// Household sign-in (SYNC.md › Household sign-in): Sign in with Google on the shared household server
// (toozbudgeting-bank), the same people, household and roles as ToozBudgeting. It doesn't hold any
// Daily Tracker data: an owner links the household's Daily Tracker account once, and the server hands
// its sign-in keys to owners and members so they sign in to Daily Tracker without a password.
// The household session token lives in localStorage on this device only (never in an export).
import { HOUSEHOLD_SERVER_URL, HOUSEHOLD_APP_ID } from './householdConfig.js';

const STATE_KEY = 'dailyTracker:household';
const CONFIG_KEY = 'dailyTracker:householdConfig';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const TIMEOUT = 20000;
export const APP_ID = HOUSEHOLD_APP_ID;

const listeners = new Set();
export function onHouseholdChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

function readJSON(k) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } }
function writeState(v) { try { if (v) localStorage.setItem(STATE_KEY, JSON.stringify(v)); else localStorage.removeItem(STATE_KEY); } catch { /* storage full: stays signed in for this session only */ } changed(); }

/** The household server's address ('' = household sign-in hidden). Settings can override it (tests). */
export function serverUrl() {
  const o = readJSON(CONFIG_KEY);
  const u = o && typeof o.serverUrl === 'string' ? o.serverUrl : HOUSEHOLD_SERVER_URL;
  return String(u || '').trim().replace(/\/+$/, '');
}
export const householdAvailable = () => !!serverUrl();

/** { token, me, at, server } or null. me = { user, household, role, scopes } from the server. */
export function householdState() { const s = readJSON(STATE_KEY); return s && s.server === serverUrl() ? s : null; }
export const isHouseholdSignedIn = () => !!householdState()?.token;
export const householdMe = () => householdState()?.me || null;
export const isHouseholdOwner = () => householdMe()?.role === 'owner';

export class HouseholdError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data || {}; } }

export async function api(method, path, body, { auth = true } = {}) {
  const base = serverUrl();
  if (!base) throw new HouseholdError(0, 'Household sign-in isn’t set up');
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  if (auth) {
    const t = householdState()?.token;
    if (!t) throw new HouseholdError(401, 'Sign in with Google first', { code: 'SIGNED_OUT' });
    headers.Authorization = 'Bearer ' + t;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), mode: 'cors', signal: ctl.signal });
  } catch { throw new HouseholdError(0, navigator.onLine === false ? 'You’re offline' : 'Can’t reach the household server'); }
  finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    // The household session ended (or this person was removed): forget it. Daily Tracker's own session is untouched.
    if (auth && (res.status === 401 || data?.code === 'REMOVED')) { const s = householdState(); if (s?.token) writeState({ ...s, token: null, signedOutReason: data?.error || 'You were signed out.' }); }
    throw new HouseholdError(res.status, data?.error || `HTTP ${res.status}`, data);
  }
  return data;
}

export async function authConfig() {
  try { return await api('GET', '/auth/config', undefined, { auth: false }); } catch (e) { return { ready: false, googleClientId: null, error: e.message }; }
}

function deviceName() {
  const ua = navigator.userAgent || '';
  const standalone = matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  return `Daily Tracker · ${standalone ? `${what} app` : what}`;
}

function finish(res) {
  writeState({ token: res.token, me: res.me, at: Date.now(), server: serverUrl(), signedOutReason: null });
  return res.me;
}
/** Trade a Google ID token for a household session. Resolves me. */
export async function signInWithCredential(credential) {
  return finish(await api('POST', '/auth/google', { credential, deviceName: deviceName() }, { auth: false }));
}
/** The installed iPhone app signs in by redirect; the server sends it back with #signin=<one-time code>. */
export async function redeemCode(code) {
  return finish(await api('POST', '/auth/redeem', { code }, { auth: false }));
}
export async function refreshMe() {
  const me = await api('GET', '/me');
  const s = householdState();
  if (s?.token) writeState({ ...s, me });
  return me;
}
/** Sign out of the household on this device (Daily Tracker's own account stays signed in). */
export async function signOutHousehold() {
  try { if (isHouseholdSignedIn()) await api('POST', '/auth/logout', {}); } catch { /* already gone */ }
  writeState(null);
}

// ---------- this app on the household server ----------
const A = `/apps/${encodeURIComponent(APP_ID)}`;
/** { linked, username, updatedAt, updatedBy, canUse, canManage, role } */
export const appStatus = () => api('GET', A);
/** { username, authKey, kek }: owners and members only; 404 NOT_LINKED, 403 for view-only people. */
export const appKeys = () => api('GET', A + '/keys');
export const setLink = (keys) => api('POST', A + '/link', { username: keys.username, authKey: keys.authKey, kek: keys.kek });
export const removeLink = () => api('DELETE', A + '/link');
export const getPrefs = () => api('GET', A + '/prefs').then((r) => r.prefs || {});
export const setPrefs = (prefs) => api('POST', A + '/prefs', { prefs }).then((r) => r.prefs || {});

export const ROLE_LABEL = { owner: 'Owner', member: 'Member', viewer: 'View only' };

// ---------- the redirect return ----------
/**
 * Read "#signin=<code>" / "#signin-error=<message>" (the redirect sign-in coming back) and remove it from
 * the address before anything else reads the hash. { code, error } or null.
 */
export function captureSignInFromUrl() {
  if (!/^#signin(-error)?=/.test(location.hash || '')) return null;
  const q = new URLSearchParams(location.hash.slice(1));
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  if (q.has('signin-error')) {
    const code = q.get('signin-code');
    return { code: null, error: (q.get('signin-error') || 'Sign-in failed') + (code && code !== 'ERROR' ? ` (${code})` : '') };
  }
  return { code: q.get('signin') || '', error: null };
}

// ---------- Google Identity Services ----------
let gis = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gis) return gis;
  gis = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GIS_SRC; el.async = true;
    el.onload = () => (window.google?.accounts?.id ? resolve(window.google) : reject(new Error('Google sign-in didn’t load')));
    el.onerror = () => { gis = null; reject(new Error('Couldn’t load Google sign-in. Check your connection.')); };
    document.head.append(el);
  });
  return gis;
}

/**
 * Installed iPhone/iPad app: Google's popup doesn't come back to it, so it signs in by redirect: a plain link
 * to the household server's /auth/google/start?app=daily-tracker (Google's OpenID page, then back here with
 * #signin=<one-time code>). The app name is sealed in the sign-in state on the server, never a free URL.
 */
export const useRedirect = () => /iPhone|iPad/.test(navigator.userAgent || '') && !!(navigator.standalone || matchMedia?.('(display-mode: standalone)')?.matches);

/**
 * Put the official Sign in with Google button in host. onSignedIn(me) runs once the household server
 * accepts it; onError(message) on any failure. Resolves false when it can't be shown.
 */
export async function renderGoogleButton(host, { onSignedIn, onError, text = 'signin_with' } = {}) {
  if (!householdAvailable()) return false;
  const cfg = await authConfig();
  if (!cfg.ready) {
    const text = !cfg.error ? 'Google sign-in isn’t set up on the household server yet.'
      : navigator.onLine === false ? 'You’re offline. Sign in with Google once you’re back online.'
      : `Google sign-in isn’t reachable right now (${cfg.error}).`;
    host.replaceChildren(Object.assign(document.createElement('p'), { className: 'set-desc', textContent: text }));
    return false;
  }
  if (useRedirect()) {
    const a = document.createElement('a');
    a.className = 'btn secondary gsi-link';
    a.href = `${serverUrl()}/auth/google/start?app=${encodeURIComponent(APP_ID)}`;
    a.setAttribute('role', 'button');
    a.textContent = 'Sign in with Google';
    host.replaceChildren(a);
    return true;
  }
  let google;
  try { google = await loadGis(); } catch (e) { onError?.(e.message); return false; }
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: 'popup',
    callback: async (resp) => {
      if (!resp?.credential) { onError?.('Google didn’t send a sign-in. Try again.'); return; }
      try { onSignedIn?.(await signInWithCredential(resp.credential)); } catch (e) { onError?.(e.message); }
    },
  });
  host.replaceChildren();
  const width = Math.min(360, Math.max(220, host.clientWidth || 300));
  google.accounts.id.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', text, shape: 'pill', logo_alignment: 'left', width });
  return true;
}
