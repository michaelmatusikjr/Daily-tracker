// Household server for tests (t56). With HOUSEHOLD_WORKER=<path to toozbudgeting-bank's worker-bank>
// (or a ToozBudgeting checkout next to this repo) it runs the REAL Worker handler on an in-memory
// SQLite D1 with a fake Google that signs ID tokens with a test key. Otherwise a small stand-in that
// follows the same API (/auth/*, /me, /apps/daily-tracker/*) is used, so the suite runs anywhere.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = 'mickey@example.com';

function findWorker() {
  if (process.env.HOUSEHOLD_MOCK) return null;
  const cands = [process.env.HOUSEHOLD_WORKER, path.resolve(__dirname, '../../ToozBudgeting/worker-bank')].filter(Boolean);
  return cands.find((d) => fs.existsSync(path.join(d, 'src/apps.js')) && fs.existsSync(path.join(d, 'test/helpers.mjs'))) || null;
}

async function realServer(dir, origin) {
  const H = await import(path.join(dir, 'test/helpers.mjs'));
  const t = H.setup({ ALLOWED_ORIGINS: origin, ALLOWED_OWNER_EMAILS: OWNER, APP_URL: origin + '/ToozBudgeting/', APP_URL_DAILY_TRACKER: origin + '/', PUBLIC_URL: 'https://hh.test' });
  const mint = (email) => H.idToken({ email, sub: 'sub-' + email, name: email === OWNER ? 'Mickey Matusik' : email.split('@')[0].replace(/^./, (c) => c.toUpperCase()) + ' Matusik' });
  const call = async (method, p, body, token) => {
    const res = await t.handle(new Request('https://hh.test' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), t.env, t.ctx);
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  return {
    kind: 'real', handle: t.handle, env: t.env, ctx: t.ctx, mint,
    async signIn(email) { return (await call('POST', '/auth/google', { credential: await mint(email), deviceName: 'test' })).data; },
    async invite(ownerToken, email, role) { return call('POST', '/household/invites', { email, role }, ownerToken); },
    // The installed iPhone app's sign-in: /auth/google/start?app=daily-tracker -> Google -> id_token form post.
    async redirectCode(email) {
      const g = new URL((await t.handle(new Request('https://hh.test/auth/google/start?app=daily-tracker'), t.env, t.ctx)).headers.get('Location'));
      const id_token = await H.idToken({ email, sub: 'sub-' + email, nonce: g.searchParams.get('nonce') });
      const res = await t.handle(new Request('https://hh.test/auth/google/redirect', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token, state: g.searchParams.get('state') }) }), t.env, t.ctx);
      return res.headers.get('Location');
    },
    linkRow: () => t.DB.raw.prepare('SELECT * FROM app_links').get() || null,
    prefsOf: (email) => { const r = t.DB.raw.prepare('SELECT p.prefs FROM app_prefs p JOIN users u ON u.id = p.user_id WHERE u.email = ?').get(email); return r ? JSON.parse(r.prefs) : null; },
    sessionsOf: (email) => t.DB.raw.prepare('SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get(email).n,
  };
}

// ---------- the stand-in ----------
function mockServer(origin) {
  const users = new Map(); // email -> { id, email, name, role }
  const sessions = new Map(); // token -> email
  const codes = new Map();
  let link = null; const prefs = new Map();
  const invites = new Map();
  const tok = () => crypto.randomBytes(18).toString('base64url');
  const meOf = (u) => ({ user: { id: u.id, email: u.email, name: u.name, displayName: u.name }, household: { id: 'h_1', name: 'Our household', seq: 0, records: 0 }, role: u.role, scopes: null, accessRev: 1 });
  const signIn = (email) => {
    let u = users.get(email);
    if (!u) {
      const role = email === OWNER ? 'owner' : invites.get(email);
      if (!role) return [403, { error: 'This Google account hasn’t been invited.', code: 'NOT_INVITED' }];
      u = { id: 'u_' + users.size, email, name: email === OWNER ? 'Mickey Matusik' : email.split('@')[0].replace(/^./, (c) => c.toUpperCase()) + ' Matusik', role };
      users.set(email, u);
    }
    const token = 's_' + tok() + '.' + tok();
    sessions.set(token, email);
    return [200, { token, me: meOf(u) }];
  };
  const handle = async (req) => {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    const body = m === 'GET' || m === 'DELETE' ? {} : await req.json().catch(() => ({}));
    const J = (status, data) => [status, data];
    if (p === '/auth/config') return J(200, { googleClientId: 'test.apps.googleusercontent.com', ready: true });
    if (p === '/auth/google') { const c = String(body.credential || ''); return c.startsWith('test:') ? signIn(c.slice(5)) : J(401, { error: 'That sign-in couldn’t be verified' }); }
    if (p === '/auth/redeem') { const e = codes.get(body.code); codes.delete(body.code); return e ? signIn(e) : J(401, { error: 'That sign-in link expired.' }); }
    const t = /^Bearer (\S+)$/.exec(req.headers.get('Authorization') || '')?.[1];
    const email = t && sessions.get(t); const u = email && users.get(email);
    if (!u) return J(401, { error: 'Sign in first', code: 'SIGNED_OUT' });
    const canUse = u.role !== 'viewer';
    const status = () => ({ app: 'daily-tracker', name: 'Daily Tracker', linked: !!link, username: link?.username || null, updatedAt: link ? 1 : null, updatedBy: null, canUse, canManage: u.role === 'owner', role: u.role });
    if (p === '/auth/logout') { sessions.delete(t); return J(200, { ok: true }); }
    if (p === '/me') return J(200, meOf(u));
    if (p === '/household/invites' && m === 'POST') { invites.set(body.email, body.role); return J(200, { invite: { email: body.email } }); }
    if (p === '/apps/daily-tracker' && m === 'GET') return J(200, status());
    if (p === '/apps/daily-tracker/keys') { if (!canUse) return J(403, { error: 'View-only people can’t open Daily Tracker with Google yet. Ask an owner to make you a member.' }); return link ? J(200, { app: 'daily-tracker', ...link }) : J(404, { error: 'Daily Tracker isn’t linked to your household yet.', code: 'NOT_LINKED' }); }
    if (p === '/apps/daily-tracker/link' && m === 'POST') { if (u.role !== 'owner') return J(403, { error: 'Only an owner can link Daily Tracker' }); link = { username: body.username, authKey: body.authKey, kek: body.kek }; return J(200, status()); }
    if (p === '/apps/daily-tracker/link' && m === 'DELETE') { if (u.role !== 'owner') return J(403, { error: 'Only an owner can unlink Daily Tracker' }); link = null; return J(200, status()); }
    if (p === '/apps/daily-tracker/prefs' && m === 'GET') return J(200, { app: 'daily-tracker', prefs: prefs.get(email) || {} });
    if (p === '/apps/daily-tracker/prefs' && m === 'POST') { prefs.set(email, body.prefs || {}); return J(200, { app: 'daily-tracker', prefs: body.prefs || {} }); }
    return J(404, { error: 'Not found' });
  };
  const wrap = async (req) => {
    const o = req.headers.get('Origin');
    const cors = o === origin ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: o === origin ? 204 : 403, headers: cors });
    const [status, data] = await handle(req);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  };
  const call = async (method, p, body, token) => { const r = await wrap(new Request('https://hh.test' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })); return { status: r.status, data: await r.json() }; };
  return {
    kind: 'mock', handleFetch: wrap, mint: async (email) => 'test:' + email,
    async signIn(email) { return (await call('POST', '/auth/google', { credential: 'test:' + email })).data; },
    async invite(ownerToken, email, role) { return call('POST', '/household/invites', { email, role }, ownerToken); },
    async redirectCode(email) { const c = tok(); codes.set(c, email); return origin + '/#signin=' + c; },
    linkRow: () => (link ? { label: link.username, sealed: 'mock:' + link.authKey } : null),
    prefsOf: (email) => prefs.get(email) || null,
    sessionsOf: (email) => [...sessions.values()].filter((e) => e === email).length,
  };
}

/** Start the household server on port. Resolves { url, close, ...helpers }. */
async function startHousehold(port, origin) {
  const dir = findWorker();
  const s = dir ? await realServer(dir, origin) : mockServer(origin);
  const handle = s.kind === 'real' ? (req) => s.handle(req, s.env, s.ctx) : s.handleFetch;
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request('http://127.0.0.1:' + port + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { ...s, url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => srv.close(r)), OWNER };
}
module.exports = { startHousehold, OWNER };
