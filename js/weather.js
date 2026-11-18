// Weather data layer for the Today weather line: Open-Meteo forecast + geocoding, BigDataCloud reverse
// geocoding, browser geolocation, and a per-device forecast cache (localStorage, NOT in profile data).
// Nothing here blocks rendering: callers read the cache synchronously (weatherFor) and ask for a refresh
// (ensureFresh), which calls the listener when new data arrives. Every failure is swallowed.
import { isValidKey, addDays, todayKey } from './dates.js';
import { getProfiles, readProfileState } from './store.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
// OpenStreetMap Nominatim: city name from coordinates (official city boundaries) and ZIPs missing from zippopotam
// (e.g. 75072, created in 2018). Its usage policy asks for an identifying Referer, so it gets the app's origin only.
const OSM_URL = 'https://nominatim.openstreetmap.org';
const NAME_SRC = 'osm'; // names looked up before this (BigDataCloud) are looked up again once
const CACHE_KEY = 'dailyTracker:weatherCache';
const POS_KEY = 'dailyTracker:weatherPos';
export const FRESH_MS = 30 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // an older cached forecast is not shown at all
const TIMEOUT_MS = 8000;
const RETRY_MS = 5 * 60 * 1000; // after a failure, don't try the same thing again for a while
const MAX_ENTRIES = 12;
export const FORECAST_DAYS = 8; // today + 7

/** ~1 km precision: this is all that is ever sent to a weather service. */
export const round2 = (n) => Math.round(n * 100) / 100;
const keyOf = (lat, lon) => `${round2(lat).toFixed(2)},${round2(lon).toFixed(2)}`;

// ---------- storage (per device) ----------
function lsRead(key) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } }
function lsWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable: weather just isn't cached */ } }

function readCache() { return lsRead(CACHE_KEY) || {}; }
function writeCache(cache) {
  const keys = Object.keys(cache).sort((a, b) => (cache[b].fetchedAt || 0) - (cache[a].fetchedAt || 0));
  const out = {};
  for (const k of keys.slice(0, MAX_ENTRIES)) out[k] = cache[k];
  lsWrite(CACHE_KEY, out);
}
const readPos = () => {
  const p = lsRead(POS_KEY);
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
};

/**
 * After a profile is deleted or reset: keep cached forecasts only for the current position and the saved
 * cities of the profiles that remain, so searched-for places don't linger on the device.
 */
export function pruneWeatherCache() {
  try {
    const keep = new Set();
    const pos = readPos();
    if (pos) keep.add(keyOf(pos.lat, pos.lon));
    for (const p of getProfiles()) {
      const d = readProfileState(p.id);
      for (const l of d?.settings?.weather?.locations || []) keep.add(keyOf(l.lat, l.lon));
    }
    const cache = readCache();
    const out = {};
    for (const k of Object.keys(cache)) if (keep.has(k)) out[k] = cache[k];
    lsWrite(CACHE_KEY, out);
  } catch { /* ignore */ }
}

// ---------- weather codes ----------
/** WMO weather code → [emoji, label]. */
export function describeCode(code) {
  const c = Number(code);
  if (c === 0) return ['☀️', 'Clear'];
  if (c === 1) return ['🌤️', 'Mostly clear'];
  if (c === 2) return ['⛅', 'Partly cloudy'];
  if (c === 3) return ['☁️', 'Cloudy'];
  if (c === 45 || c === 48) return ['🌫️', 'Fog'];
  if (c >= 51 && c <= 57) return ['🌦️', 'Drizzle'];
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return ['🌧️', 'Rain'];
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['❄️', 'Snow'];
  if (c >= 95 && c <= 99) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', 'Weather'];
}
export const toUnits = (c, units) => Math.round(units === 'C' ? c : (c * 9) / 5 + 32);

// ---------- network ----------
async function getJson(url, referrerPolicy = 'no-referrer') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** Validate an Open-Meteo response into { tz, days: { 'YYYY-MM-DD': { hi, lo, pop, code } } } (°C), or null. */
export function parseForecast(j) {
  const d = j && j.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const days = {};
  d.time.slice(0, 16).forEach((k, i) => {
    const hi = d.temperature_2m_max?.[i], lo = d.temperature_2m_min?.[i];
    if (typeof k !== 'string' || !isValidKey(k) || !Number.isFinite(hi) || !Number.isFinite(lo)) return;
    const pop = d.precipitation_probability_max?.[i];
    const code = d.weather_code?.[i];
    days[k] = { hi, lo, pop: Number.isFinite(pop) ? Math.max(0, Math.min(100, Math.round(pop))) : null, code: Number.isFinite(code) ? code : null };
  });
  return Object.keys(days).length ? { tz: typeof j.timezone === 'string' ? j.timezone.slice(0, 64) : '', days } : null;
}

export async function fetchForecast(lat, lon) {
  const q = new URLSearchParams({
    latitude: String(round2(lat)), longitude: String(round2(lon)),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    timezone: 'auto', forecast_days: String(FORECAST_DAYS), temperature_unit: 'celsius',
  });
  let j;
  try { j = await getJson(`${FORECAST_URL}?${q}`); } catch { await new Promise((r) => setTimeout(r, 1500)); j = await getJson(`${FORECAST_URL}?${q}`); }
  const out = parseForecast(j);
  if (!out) throw new Error('Unexpected forecast response');
  return out;
}

const ZIP_URL = 'https://api.zippopotam.us/us/';
const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

const osmJson = (path, params) => getJson(`${OSM_URL}/${path}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': 'en', ...params })}`, 'strict-origin');
/** The town an OSM address belongs to. */
const osmTown = (a) => [a?.city, a?.town, a?.village, a?.hamlet, a?.municipality, a?.suburb, a?.county].find((x) => typeof x === 'string' && x.trim()) || '';

/** US ZIP lookup in OpenStreetMap (has newer ZIPs). Returns [] when not found; throws on a network problem. */
async function searchZipOsm(zip) {
  const list = await osmJson('search', { postalcode: zip, countrycodes: 'us', addressdetails: '1', limit: '5' });
  return (Array.isArray(list) ? list : []).map((r) => {
    const lat = Number(r?.lat), lon = Number(r?.lon);
    // display_name looks like "75072, McKinney, Collin County, Texas, United States"
    const parts = typeof r?.display_name === 'string' ? r.display_name.split(',').map((x) => x.trim()) : [];
    const name = osmTown(r?.address) || parts[1] || '';
    const state = typeof r?.address?.state === 'string' ? r.address.state : (parts.length > 3 ? parts[parts.length - 2] : '');
    return validCoord(lat, lon) && name ? { name: name.slice(0, 80), detail: [state, 'US'].filter(Boolean).join(', ').concat(' ', zip).slice(0, 80), lat: round2(lat), lon: round2(lon) } : null;
  }).filter(Boolean).slice(0, 5);
}

/** US ZIP lookup (zippopotam.us). [] when the ZIP is unknown (HTTP 404); throws on other problems. */
async function searchZip(zip) {
  let j;
  try { j = await getJson(ZIP_URL + zip); } catch (e) { if (e && e.message === 'HTTP 404') return []; throw e; }
  const list = Array.isArray(j?.places) ? j.places : [];
  return list.filter((p) => p && typeof p['place name'] === 'string' && p['place name'] && validCoord(Number(p.latitude), Number(p.longitude)))
    .slice(0, 5).map((p) => ({
      name: p['place name'].replace(/\bMc (?=[A-Z])/g, 'Mc').slice(0, 80), // zippopotam writes "Mc Kinney"
      detail: ([typeof p['state abbreviation'] === 'string' ? p['state abbreviation'] : '', 'US'].filter(Boolean).join(', ') + ' ' + zip).slice(0, 80),
      lat: round2(Number(p.latitude)), lon: round2(Number(p.longitude)),
    }));
}

/** City or US ZIP search (zippopotam.us / Open-Meteo geocoding). Returns [{ name, detail, lat, lon }]; throws on a network problem. */
export async function searchPlaces(text) {
  const name = String(text || '').trim().slice(0, 80);
  if (!name) return [];
  const zm = /^(\d{5})(-\d{4})?$/.exec(name);
  if (zm) {
    let found = [];
    try { found = await searchZip(zm[1]); } catch { /* try OpenStreetMap */ }
    if (found.length) return found;
    return searchZipOsm(zm[1]); // newer ZIPs; throws (→ "couldn't search") only if this fails too
  }
  const q = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
  if (zm) q.set('countryCode', 'US');
  const j = await getJson(`${SEARCH_URL}?${q}`);
  const list = Array.isArray(j?.results) ? j.results : [];
  return list.filter((r) => r && typeof r.name === 'string' && Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Math.abs(r.latitude) <= 90 && Math.abs(r.longitude) <= 180)
    .slice(0, 5).map((r) => ({
      name: r.name.slice(0, 80),
      detail: [r.admin1, r.country_code || r.country].filter((x) => typeof x === 'string' && x).join(', ').slice(0, 80),
      lat: round2(r.latitude), lon: round2(r.longitude),
    }));
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const nameKeyOf = (lat, lon) => `${round3(lat).toFixed(3)},${round3(lon).toFixed(3)}`;
/** City name only: ~100 m precision so the name doesn't land in the neighbouring city. */
async function reverseName(lat, lon) {
  const q = new URLSearchParams({ latitude: String(round3(lat)), longitude: String(round3(lon)), localityLanguage: 'en' });
  try {
    const j = await osmJson('reverse', { lat: String(round3(lat)), lon: String(round3(lon)), zoom: '10', addressdetails: '1' });
    const n = osmTown(j?.address);
    if (n) return n.trim().slice(0, 80);
  } catch { /* fall back to BigDataCloud */ }
  const j = await getJson(`${REVERSE_URL}?${q}`);
  const n = [j?.city, j?.locality].find((x) => typeof x === 'string' && x.trim());
  return n ? n.trim().slice(0, 80) : '';
}

// ---------- diagnostics (memory only; shown in the location menu) ----------
const lastError = new Map(); // 'forecast' | 'pos' | 'name' | 'search' → { msg, at }
function noteError(kind, e) {
  const geo = { 1: 'Location permission denied', 2: 'Position unavailable', 3: 'Timed out finding your location' };
  const msg = kind === 'pos' && e && geo[e.code] ? geo[e.code] : (e && e.name === 'AbortError' ? 'Timed out' : String((e && e.message) || e || 'Error'));
  lastError.set(kind, { msg: msg.slice(0, 120), at: Date.now() });
}
export function noteSearchError(e) { if (e) noteError('search', e); else lastError.delete('search'); }
/** What the location menu shows: the position's accuracy and recent problems. */
export function weatherDiagnostics() {
  const pos = readPos();
  return { acc: pos && Number.isFinite(pos.acc) ? pos.acc : null, posAt: pos ? pos.at || null : null, errors: Object.fromEntries(lastError) };
}

// ---------- current location ----------
const failedAt = new Map(); // key → time of the last failed attempt (memory only)
let geoDenied = false;

function geolocate(fresh = false) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(Object.assign(new Error('unsupported'), { code: 0 })); return; }
    // The browser's own timeout may only start once permission is answered, so also give up ourselves.
    const guard = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 3 })), TIMEOUT_MS + 2000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(guard); resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null }); },
      (e) => { clearTimeout(guard); reject(e); },
      { enableHighAccuracy: fresh, timeout: TIMEOUT_MS, maximumAge: fresh ? 0 : 15 * 60 * 1000 });
  });
}

/** Resolve the device position (rounded) and its city name; remembered per device. */
async function refreshPosition(fresh = false) {
  try {
    const p = await geolocate(fresh);
    geoDenied = false; deniedThisSession = false;
    const lat = round2(p.lat), lon = round2(p.lon);
    const nameKey = nameKeyOf(p.lat, p.lon);
    const old = readPos();
    // Reuse the known city name when the new fix is within ~200 m of where it was looked up (fixes jitter).
    const near = (() => {
      const m = old && typeof old.nameKey === 'string' && old.nameKey.split(',').map(Number);
      return !!m && old.src === NAME_SRC && m.length === 2 && m.every(Number.isFinite) && Math.abs(m[0] - p.lat) <= 0.002 && Math.abs(m[1] - p.lon) <= 0.002;
    })();
    let name = old && near ? old.name || '' : '';
    if (!name) { try { name = await reverseName(p.lat, p.lon); lastError.delete('name'); } catch (e) { noteError('name', e); name = old && keyOf(old.lat, old.lon) === keyOf(lat, lon) ? old.name || '' : ''; } }
    lsWrite(POS_KEY, { lat, lon, name, nameKey: name ? (near ? old.nameKey : nameKey) : '', src: NAME_SRC, acc: p.acc, at: Date.now() });
    lastError.delete('pos');
    return true;
  } catch (e) {
    noteError('pos', e);
    // Denied (code 1) forgets the remembered position; any other failure (unsupported, unavailable, timeout)
    // keeps an older position if there is one, otherwise it's time to ask for a city.
    if (e && e.code === 1) { deniedThisSession = true; try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ } }
    geoDenied = !readPos();
    return false;
  }
}

// ---------- public API ----------
let listener = () => {};
/** Called (with no arguments) whenever new weather data or a position arrived. */
export function onWeatherChange(fn) { listener = typeof fn === 'function' ? fn : () => {}; }

const inFlight = new Map();

/** Where to look: { kind:'current'|'saved', lat, lon, name } or { kind:'need-city' } / { kind:'locating' }. */
export function resolveTarget(w) {
  const sel = w.locations.find((l) => l.id === w.selected);
  if (w.selected !== 'current' && sel) return { kind: 'saved', lat: sel.lat, lon: sel.lon, name: sel.name };
  const pos = readPos();
  if (pos) return { kind: 'current', lat: pos.lat, lon: pos.lon, name: pos.name || '' };
  return geoDenied ? { kind: 'need-city' } : { kind: 'locating' };
}

/**
 * What the weather line should show for `dateKey`, from the cache only (never waits for the network).
 * → null when nothing should show (a past day, or beyond 7 days ahead); otherwise
 * { pill, needCity, forecast: { emoji, label, hi, lo, pop } | null, stale, updatedAt }.
 */
export function weatherFor(w, dateKey, today = todayKey()) {
  if (dateKey < today || dateKey > addDays(today, FORECAST_DAYS - 1)) return null;
  const t = resolveTarget(w);
  if (t.kind === 'need-city') return { pill: 'Add a city', needCity: true, forecast: null, stale: false, updatedAt: null };
  const pill = t.name || 'Current location';
  if (t.kind === 'locating') return { pill, needCity: false, forecast: null, stale: false, updatedAt: null };
  const entry = readCache()[keyOf(t.lat, t.lon)];
  const day = entry && entry.days && Date.now() - (entry.fetchedAt || 0) <= MAX_AGE_MS && entry.days[dateKey];
  if (!day) return { pill, needCity: false, forecast: null, stale: false, updatedAt: null };
  const [emoji, label] = describeCode(day.code);
  const age = Date.now() - (entry.fetchedAt || 0);
  // Stale = older than the refresh interval and the refresh isn't working (offline / failed).
  const failed = failedAt.has(keyOf(t.lat, t.lon)) || (typeof navigator !== 'undefined' && navigator.onLine === false);
  return {
    pill, needCity: false, stale: age > FRESH_MS && failed, updatedAt: entry.fetchedAt || null,
    forecast: { emoji, label, hi: toUnits(day.hi, w.units), lo: toUnits(day.lo, w.units), pop: day.pop },
  };
}

/** Make sure the selected location has a forecast younger than ~30 min; fires the listener when something changed. */
export function ensureFresh(w) {
  try {
    const t = resolveTarget(w);
    if (t.kind === 'need-city' || inFlight.has('force')) return;
    if (t.kind === 'locating' || (t.kind === 'current' && positionDue())) {
      if (inFlight.has('pos') || recentlyFailed('pos')) return;
      const p = refreshPosition().then((ok) => {
        if (!ok) failedAt.set('pos', Date.now()); else failedAt.delete('pos');
        listener();
      }).finally(() => inFlight.delete('pos'));
      inFlight.set('pos', p);
      // A known position can still be used for the forecast while the new one is looked up.
      if (t.kind === 'locating') return;
    }
    const key = keyOf(t.lat, t.lon);
    const entry = readCache()[key];
    if (entry && Date.now() - (entry.fetchedAt || 0) < FRESH_MS) return;
    if (inFlight.has(key) || recentlyFailed(key)) return;
    const p = loadForecast(t).finally(() => { inFlight.delete(key); listener(); });
    inFlight.set(key, p);
  } catch { /* weather must never break the app */ }
}

/**
 * Forced refresh (pull-to-refresh, app coming back to the foreground): for "current location" re-reads the
 * position (no cached fix, high accuracy), then fetches the forecast even if the cache is fresh.
 * Resolves when done; repeated calls while one is running share it.
 */
export function refreshWeather(w, { auto = false } = {}) {
  if (inFlight.has('force')) return inFlight.get('force');
  // Coming back to the app: at most once a minute, keep the failure backoff, and don't retry a denied location.
  if (auto && (Date.now() - lastForced < AUTO_GAP_MS || (deniedThisSession && resolveTarget(w).kind === 'need-city'))) return Promise.resolve();
  lastForced = Date.now();
  const p = (async () => {
    try {
      if (!auto) failedAt.clear();
      let t = resolveTarget(w);
      if (t.kind === 'need-city') { geoDenied = false; t = resolveTarget(w); }
      // Don't make the forecast wait for a GPS fix (that can take 10 s+): refresh the known place right away.
      const first = t.kind === 'saved' || t.kind === 'current' ? loadForecast(t) : null;
      if (t.kind === 'current' || t.kind === 'locating') {
        const before = t.kind === 'current' ? keyOf(t.lat, t.lon) : '';
        const ok = await refreshPosition(true);
        if (!ok) failedAt.set('pos', Date.now());
        listener();
        t = resolveTarget(w);
        if (t.kind === 'current' && keyOf(t.lat, t.lon) !== before) await loadForecast(t);
      }
      if (first) await first;
    } catch { /* weather must never break the app */ }
  })().finally(() => { inFlight.delete('force'); listener(); });
  inFlight.set('force', p);
  return p;
}

let lastForced = 0, deniedThisSession = false;
const AUTO_GAP_MS = 60 * 1000;

async function loadForecast(t) {
  const key = keyOf(t.lat, t.lon);
  try {
    const f = await fetchForecast(t.lat, t.lon);
    const cache = readCache();
    cache[key] = { fetchedAt: Date.now(), tz: f.tz, days: f.days };
    writeCache(cache);
    failedAt.delete(key); lastError.delete('forecast');
  } catch (e) { failedAt.set(key, Date.now()); noteError('forecast', e); }
  listener();
}

/** True while a forecast or position lookup for the line is running. */
export function weatherBusy() { return inFlight.size > 0; }
/** True when the last forecast request for the shown place failed. */
export function weatherFailed(w) { const t = resolveTarget(w); return (t.kind === 'current' || t.kind === 'saved') && failedAt.has(keyOf(t.lat, t.lon)); }

function recentlyFailed(key) { const t = failedAt.get(key); return !!t && Date.now() - t < RETRY_MS; }
function positionDue() { const p = readPos(); return !p || Date.now() - (p.at || 0) > FRESH_MS; }

/** Forget the "recently failed" marks (e.g. after the user picked another location or came back online). */
export function resetRetries() { failedAt.clear(); geoDenied = false; }
if (typeof window !== 'undefined') window.addEventListener('online', () => { failedAt.clear(); listener(); });
