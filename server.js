#!/usr/bin/env node
/* FoodHive Dashboard Server
 * - High-speed in-memory cached order engine
 * - Consolidates historical exports (32,000+ orders) + live GrubCENTER telemetry
 * - Instant (<5ms) gzip responses with background auto-sync
 * - AWS Cognito auth for live Grubtech reporting APIs
 * No npm dependencies (Node 18+).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const N = require('./public/normalize.js');
const FHSources = require('./public/sources.js');
const FHRatings = require('./public/ratings.js');
const { importCapture: importAtlasCapture } = require('./api/up-import.js');
const { handleWebhook: handleUpWebhook } = require('./api/up-webhook.js');
const UpWebhooks = require('./api/_lib/up-webhooks');
const AtlasSync = require('./api/_lib/atlas-sync.js');
const { lineItemsResponse } = require('./api/_lib/line-items-window.js');

// This is a long-running process serving every user -- one unexpected
// exception (e.g. from a response write on an already-aborted connection)
// must never take the whole server down. Log and keep running instead.
process.on('uncaughtException', err => console.error('[Uncaught Exception]', err));
process.on('unhandledRejection', err => console.error('[Unhandled Rejection]', err));

// ---------- .env ----------
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env */ }

const E = process.env;
const CFG = {
  port: +E.PORT || 3000,
  email: E.GRUBCENTER_EMAIL,
  password: E.GRUBCENTER_PASSWORD,
  region: E.GRUBCENTER_COGNITO_REGION || 'eu-west-2',
  clientIds: (E.GRUBCENTER_COGNITO_CLIENT_ID ? [E.GRUBCENTER_COGNITO_CLIENT_ID] : ['75n3em3l16kvhnf6c512680vm9', '2d8lmtmc241sviat2psomuuon8']),
  apiBases: E.GRUBCENTER_API_BASE
    ? [E.GRUBCENTER_API_BASE]
    : ['https://internal-api.grubtech.io/data-visualization/api/v1', 'https://internal-api.grubtech.io/gc-data-visualization-bff'],
  partnerId: E.GRUBCENTER_PARTNER_ID,
  tokenType: (E.GRUBCENTER_TOKEN_TYPE || 'id').toLowerCase(),
  timezone: E.GRUBCENTER_TIMEZONE || 'Asia/Dubai',
  ordersPath: E.GRUBCENTER_ORDERS_PATH || '/sales-data/order-details/',
  opsPath: '/operations-data/location-performance/report/',
  cancelPath: '/sales-data/cancelled-orders/report/',
  itemsPath: E.GRUBCENTER_ITEMS_PATH || '/operations-data/item-availability/snapshot/',
  orderItemsPath: E.GRUBCENTER_ORDER_ITEMS_PATH || '/menu-data/menu-items/order-items-sales/',
  // 500, not 200: GrubCENTER returns ~limit-3 rows per page, so a 200-row
  // page needs a second request for any day over ~197 orders -- and every
  // busy day here runs 200-300. 500 covers a normal day in ONE request,
  // roughly halving total sync time and rate-limit exposure.
  pageSize: +E.GRUBCENTER_PAGE_SIZE || 500,

  // Zoho Books (OAuth2 self-client, read-only scopes)
  zohoClientId: E.ZOHO_CLIENT_ID,
  zohoClientSecret: E.ZOHO_CLIENT_SECRET,
  zohoRefreshToken: E.ZOHO_REFRESH_TOKEN,
  zohoAccountsDomain: E.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com',
  zohoApiDomain: E.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
  zohoOrgId: E.ZOHO_ORG_ID
};

// ---------- auth ----------
let session = null;
const b64json = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

async function cognito(target, body) {
  const r = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
    // A hung auth socket must not wedge the caller forever (see gt()).
    signal: AbortSignal.timeout(20_000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.__type || `Cognito ${r.status}`);
  return j;
}

async function login() {
  if (!CFG.email || !CFG.password) throw new Error('GRUBCENTER_EMAIL / GRUBCENTER_PASSWORD not set');
  let lastErr;
  for (const ClientId of CFG.clientIds) {
    try {
      const j = await cognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId,
        AuthParameters: { USERNAME: CFG.email, PASSWORD: CFG.password }
      });
      if (j.ChallengeName) throw new Error(`Cognito challenge required: ${j.ChallengeName}`);
      const a = j.AuthenticationResult;
      session = { idToken: a.IdToken, accessToken: a.AccessToken, exp: Date.now() + (a.ExpiresIn - 60) * 1000, claims: b64json(a.IdToken.split('.')[1]), clientId: ClientId };
      return session;
    } catch (e) { lastErr = e; }
  }
  throw new Error('GrubCENTER login failed: ' + (lastErr ? lastErr.message : 'Unknown error'));
}
const ensureSession = async () => (session && session.exp > Date.now() ? session : login());

function findPartnerId(claims) {
  if (CFG.partnerId) return CFG.partnerId;
  for (const k in claims) if (/partner/i.test(k) && claims[k]) return String(claims[k]).split(',')[0];
  throw new Error('Could not find a partnerId in login token.');
}

// ---------- grubtech calls ----------
// Retry policy for the reporting API:
//  - 429 (per-minute request cap): exponential backoff, 3 attempts.
//  - Network-level failures (ECONNRESET / socket hang up / DNS blip):
//    same backoff. Without this, a single dropped connection failed a whole
//    day, and with 45 days x 4 reports that turned a ~2-minute sync into a
//    20+ minute retry crawl.
//  - 401/403: force a fresh Cognito login once (the 1-hour token can expire
//    mid-sync) and retry.
async function gt(method, base, p, query, body, retries = 3) {
  let s = await ensureSession();
  const url = base.replace(/\/$/, '') + '/' + p.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : '');
  for (let attempt = 0; attempt < retries; attempt++) {
    let r, text;
    try {
      r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (CFG.tokenType === 'access' ? s.accessToken : s.idToken) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        // Without a timeout a single stalled connection leaves the sync
        // promise (and STORE.syncing) pending forever, which silently kills
        // every later auto-sync and makes "Sync Now" do nothing until the
        // process is restarted. The retry loop below handles the abort.
        signal: AbortSignal.timeout(45_000)
      });
      text = await r.text();
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      const cause = err && err.cause ? (err.cause.code || err.cause.message) : '';
      throw new Error(`Grubtech network error ${url}: ${err.message}${cause ? ' (' + cause + ')' : ''}`);
    }
    let json; try { json = JSON.parse(text); } catch (_) { json = text; }
    if (r.ok) return json;
    // Expired/revoked token: refresh the session once and retry.
    if ((r.status === 401 || r.status === 403) && attempt < retries - 1) {
      session = null;
      s = await ensureSession();
      continue;
    }
    // 429 Too Many Requests: back off and retry. Other errors are thrown.
    if (r.status === 429 && attempt < retries - 1) {
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    const e = new Error(`Grubtech ${r.status} ${url}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  throw new Error(`Grubtech rate limit exceeded after ${retries} retries: ${url}`);
}

const rowsOf = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.items || d.content || d.results || d.orders || d.records)) || [];
const bounds = (from, to) => ({ timezone: CFG.timezone, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });

// Fetch one single page of a day range from a specific base, with retries.
async function fetchOnePage(base, pathPart, pid, query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`, query, {});
      return rowsOf(d);
    } catch (e) { lastErr = e; if (attempt < 2) await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); }
  }
  throw lastErr;
}

// Dedupe key for paginated rows. Order-level reports (order-details, ops,
// cancellations) carry one row per order, so the order id is the natural
// key. Order-items rows are one row per LINE ITEM and share their parent
// orderId -- keying those by orderId would collapse a multi-item order into
// a single line -- so fall back to the full row payload, which only removes
// exact duplicates produced by overlapping page windows.
function pagedRowKey(pathPart, r) {
  const isLineItems = pathPart.replace(/\/$/, '') === CFG.orderItemsPath.replace(/\/$/, '');
  if (isLineItems) return 'json:' + JSON.stringify(r);
  const id = r.orderId || r.id || r.uniqueOrderId || r.externalId;
  return id ? 'id:' + String(id) : 'json:' + JSON.stringify(r);
}

// Fetch one single-day range, with offset pagination for busy days.
// If a base returns page 0 but some subsequent pages fail, we retry the
// failed pages up to 3 times before falling back to the next API base,
// so we never silently drop orders due to a transient page fetch failure.
//
// IMPORTANT: GrubCENTER returns FEWER rows than the requested `limit` even
// when more pages exist. Confirmed against the live API: a 303-order day
// asked for limit=200 returns 197 rows on page 0, with the remaining 106
// rows at offset=200. The old `rows.length < pageSize -> last page` check
// therefore stopped after page 0 on every busy day, which is exactly why
// the dashboard looked permanently stuck at 197 orders (Oct 24's first
// page) no matter how many times it synced. The only reliable end-of-data
// signal is an empty page, so page until one comes back.
//
// Rows are deduped by order id because the API applies `offset` before its
// own internal filtering, so consecutive page windows can overlap by a
// couple of rows (a blind concat would double-count them).
async function fetchPagedOneRange(pathPart, from, to, maxPages, s, pid) {
  let lastErr;
  for (const base of CFG.apiBases) {
    try {
      const all = [];
      const seen = new Set();
      let offset = 0;
      while (offset < maxPages * CFG.pageSize) {
        const rows = await fetchOnePage(base, pathPart, pid, { ...bounds(from, to), limit: CFG.pageSize, offset });
        if (!rows.length) break;
        let added = 0;
        for (const r of rows) {
          const key = pagedRowKey(pathPart, r);
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(r);
          added++;
        }
        // A full page of already-seen rows means the server ignored `offset`
        // and re-served the same window -- stop instead of looping.
        if (!added) break;
        offset += CFG.pageSize;
      }
      return all;
    } catch (e) { lastErr = e; if (e.status && ![404, 405].includes(e.status)) throw e; }
  }
  throw lastErr;
}

// Query the range day-by-day and merge. A wide [from, to] range does
// paginate correctly now that the empty-page stop condition is used, but
// day-chunking is still deliberate: it isolates a transient failure to one
// day instead of losing a whole multi-week pull, keeps each day's page set
// small (busy days run ~300 rows), and matches how GrubCENTER's own
// dashboard reports daily totals.
function dayChunks(from, to) {
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Up to 2 retries with growing backoff before giving up on a day -- and log
// it either way, so a transient failure shows up as a visible gap instead
// of silently shrinking the synced dataset.
async function fetchDayWithRetry(pathPart, day, maxPages, s, pid) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
    try {
      return await fetchPagedOneRange(pathPart, day, day, maxPages, s, pid);
    } catch (e) { lastErr = e; }
  }
  console.warn(`[GrubCENTER Sync] Giving up on ${pathPart} ${day} after 3 attempts: ${lastErr.message}`);
  return null; // distinguish "failed" from "legitimately 0 orders that day"
}

// Item availability snapshot: every item and modifier with its current
// status, about 24,000 rows, because each modifier is listed once per item
// that uses it, so identical rows are real and must not end paging early.
// Large pages keep it to about 5 requests. Stops on the first empty page.
async function fetchItemsSnapshot() {
  const s = await ensureSession();
  const pid = findPartnerId(s.claims);
  const day = today(), LIMIT = 5000, MAX_PAGES = 20;
  let lastErr;
  for (const base of CFG.apiBases) {
    try {
      const all = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await fetchOnePage(base, CFG.itemsPath, pid, { ...bounds(day, day), limit: LIMIT, offset: page * LIMIT });
        if (!rows.length) return all;
        all.push(...rows);
      }
      throw new Error(`item snapshot exceeded ${MAX_PAGES * LIMIT} rows`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchPaged(pathPart, from, to, maxPages = 20) {
  const s = await ensureSession();
  const pid = findPartnerId(s.claims);
  const days = dayChunks(from, to);
  // Reduced from 3 to 2: each day already fans out up to 16 parallel page
  // requests. 3 days × 16 pages = 48 concurrent requests reliably triggers
  // GrubCENTER rate limiting (429). 2 days keeps throughput high while
  // staying under the rate-limit threshold.
  const CONCURRENCY = 2;
  const all = [];
  const failedDays = [];
  for (let i = 0; i < days.length; i += CONCURRENCY) {
    const batch = days.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(day =>
      fetchDayWithRetry(pathPart, day, maxPages, s, pid).then(rows => ({ day, rows }))
    ));
    results.forEach(({ day, rows }) => { if (rows === null) failedDays.push(day); else all.push(...rows); });
    // Progress log so a long sync is visibly moving instead of looking hung.
    if (i % 10 === 0 || i + CONCURRENCY >= days.length) {
      console.log(`[GrubCENTER Sync] ${pathPart}: ${Math.min(i + CONCURRENCY, days.length)}/${days.length} days, ${all.length} rows`);
    }
    // Small delay between batches to further reduce rate-limit risk
    if (i + CONCURRENCY < days.length) await new Promise(res => setTimeout(res, 500));
  }
  if (failedDays.length) console.warn(`[GrubCENTER Sync] ${pathPart}: ${failedDays.length} day(s) could not be fetched and are MISSING from this sync: ${failedDays.join(', ')}`);
  return all;
}

// ---------- IN-MEMORY HIGH PERFORMANCE CACHE ----------
// The business runs on Asia/Dubai time (UTC+4, no DST), but .toISOString()
// is always UTC regardless of the host's own local timezone -- using it for
// "today"/day-bucketing is wrong by up to 4 hours (e.g. 1am Dubai is still
// "yesterday" in UTC), which is exactly backwards for a day-boundary check.
// This matters doubly on Vercel, where the function runtime's local
// timezone is UTC by default regardless of what this dev machine happens
// to be set to.
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const pad2 = n => String(n).padStart(2, '0');
function dubaiDateKey(ms) {
  const d = new Date(ms + DUBAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const today = () => dubaiDateKey(Date.now());
const daysAgo = n => dubaiDateKey(Date.now() - n * 864e5);

const STORE = {
  ordersMap: new Map(),
  ordersArray: [],
  itemsArray: [],
  orderItemsArray: [],
  lastSync: 0,
  syncing: false,
  liveOpsCount: 0,
  liveCancelCount: 0,
  zoho: null,
  // UrbanPiper (Jaddaf): orders by webhook (api/up-webhook.js) or Atlas sync.
  upOrders: [],
  upOrderItems: [],
  upMeta: { lastWebhookAt: 0, webhookCount: 0, catalogAt: 0 },
  upCatalog: null,
  upItems: [],
  upConn: null,
  upWh: {},
  // Aggregator store ratings captured from partner portals (public/ratings.js).
  brandRatings: null
};

// 1. Initial preload from disk
function preloadData() {
  const t0 = Date.now();
  const allFile = path.join(__dirname, 'data', 'all_orders.json');
  const cachedFile = path.join(__dirname, 'data', 'cached_orders.json');
  const itemsFile = path.join(__dirname, 'data', 'cached_items.json');
  const orderItemsFile = path.join(__dirname, 'data', 'order_items.json');

  let list = [];
  if (fs.existsSync(allFile)) {
    try { list = JSON.parse(fs.readFileSync(allFile, 'utf8')); }
    catch (e) { console.warn('[Cache Preload] all_orders.json unreadable, falling back to cached_orders.json:', e.message); }
  }
  // Fall back to the older raw export if the master cache is missing,
  // empty, or corrupt -- otherwise a single bad write would silently boot
  // the dashboard with 0 (or a handful of) orders.
  if (!Array.isArray(list) || !list.length) {
    if (fs.existsSync(cachedFile)) {
      try { list = N.normalizeOrders(JSON.parse(fs.readFileSync(cachedFile, 'utf8'))); } catch (_) {}
    }
  }

  const officialBrandsFile = path.join(__dirname, 'data', 'official_foodhive_brands.json');
  if (fs.existsSync(officialBrandsFile)) {
    try {
      const official = new Set(JSON.parse(fs.readFileSync(officialBrandsFile, 'utf8')).map(b => b.toLowerCase().trim()));
      list = list.filter(o => o && o.brand && official.has(String(o.brand).toLowerCase().trim()));
    } catch (_) {}
  }

  list.forEach(o => { if (o && o.id) STORE.ordersMap.set(String(o.id), o); });
  STORE.ordersArray = [...STORE.ordersMap.values()];

  if (fs.existsSync(itemsFile)) {
    try { STORE.itemsArray = N.normalizeItems(JSON.parse(fs.readFileSync(itemsFile, 'utf8'))); } catch (_) {}
  }
  // 86 events captured from live GrubCENTER snapshots by earlier syncs.
  const snapFile = path.join(__dirname, 'data', 'items_snapshot_events.json');
  if (fs.existsSync(snapFile)) {
    try { STORE.itemsArray = N.mergeItemEvents(STORE.itemsArray, JSON.parse(fs.readFileSync(snapFile, 'utf8'))); } catch (_) {}
    try { STORE.itemsLastSync = fs.statSync(snapFile).mtimeMs; } catch (_) {}
  }

  for (const [file, key] of [['up_orders.json', 'upOrders'], ['up_order_items.json', 'upOrderItems'], ['up_meta.json', 'upMeta'], ['up_catalog.json', 'upCatalog'], ['up_items.json', 'upItems'], ['up_conn.json', 'upConn'], ['up_wh.json', 'upWh']]) {
    const f = path.join(__dirname, 'data', file);
    if (fs.existsSync(f)) { try { STORE[key] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} }
  }

  if (fs.existsSync(orderItemsFile)) {
    try { STORE.orderItemsArray = JSON.parse(fs.readFileSync(orderItemsFile, 'utf8')); } catch (_) {}
  }

  const ratingsFile = path.join(__dirname, 'data', 'brand_ratings.json');
  if (fs.existsSync(ratingsFile)) {
    try { STORE.brandRatings = JSON.parse(fs.readFileSync(ratingsFile, 'utf8')); } catch (_) {}
  }

  const zohoFile = path.join(__dirname, 'data', 'zoho_cache.json');
  if (fs.existsSync(zohoFile)) {
    try { STORE.zoho = JSON.parse(fs.readFileSync(zohoFile, 'utf8')); } catch (_) {}
  }

  // Seed lastSync from the cache's own write time. Without this every restart
  // reports lastSync: 0, so the first page load is treated as stale (starting
  // yet another sync) and the Sync Now completion baseline is wrong until one
  // lands. The mtime is exactly when the last successful sync persisted it.
  try {
    if (fs.existsSync(allFile)) STORE.lastSync = fs.statSync(allFile).mtimeMs;
  } catch (_) {}

  console.log(`[Cache Preload] Loaded ${STORE.ordersArray.length} master FoodHive orders, ${STORE.itemsArray.length} 86-items & ${STORE.orderItemsArray.length} order line items in ${Date.now() - t0}ms`);
}
preloadData();

// Atomic JSON persist (write temp + rename) so an interrupted write can
// never leave a truncated cache behind. See runSync() for why this matters.
//
// Writes for the same file are serialized and use a unique temp name: the
// scheduled refresh and a manual "Sync Now" can now run at the same time,
// and two writers sharing one `.tmp` path could otherwise rename a
// half-written file over the real cache.
let persistSeq = 0;
const persistChains = new Map();
function persistJson(file, data) {
  const dest = path.join(__dirname, 'data', file);
  const tmp = `${dest}.${process.pid}.${++persistSeq}.tmp`;
  const prev = persistChains.get(file) || Promise.resolve();
  const job = prev.then(() => new Promise(resolve => {
    fs.writeFile(tmp, JSON.stringify(data), err => {
      if (err) { console.error(`[Cache Persist] ${file} write failed:`, err.message); resolve(); return; }
      fs.rename(tmp, dest, err2 => {
        if (err2) console.error(`[Cache Persist] ${file} rename failed:`, err2.message);
        resolve();
      });
    });
  }));
  persistChains.set(file, job);
  return job;
}

const REOPENED_RE = /\breopen(ed)?\b/i;

// 2. Synchronize live GrubCENTER data into master store
//
// Both the scheduled refresh and the UI's "Sync Now" button funnel through
// runSync(). They used to share a single `if (STORE.syncing) return;` guard,
// so a button press during the (multi-minute) background pull was silently
// discarded while /api/refresh still answered "Sync started" -- the exact
// reason the button looked dead. Manual refreshes now run alongside a
// background pull; each entry point still dedupes against itself.
async function runSync(from, to, itemsFrom) {
  const f = from || daysAgo(45), t = to || today();
  // order-items can get its own, narrower window than orders/ops/cancel --
  // see api/_lib/grubcenter.js's syncOnce() for why (far more rows/page per
  // day). Defaults to the same window as everything else when not given
  // explicitly, i.e. today's behavior is unchanged unless a caller opts in.
  const oiFrom = itemsFrom || from || f;
  try {
    console.log(`[GrubCENTER Sync] Pulling live data (${f} to ${t})...`);
    // Sequential, not parallel: each of these already fans out multiple
    // concurrent day-chunked requests internally, and running all three
    // endpoints at once compounds that into enough concurrent load to
    // trigger rate-limiting/transient failures on GrubCENTER's side.
    const rawSales = await fetchPaged(CFG.ordersPath, f, t, 25);
    const rawOps = await fetchPaged(CFG.opsPath, f, t, 20).catch(err => { console.warn('Ops warning:', err.message); return []; });
    const rawCancels = await fetchPaged(CFG.cancelPath, f, t, 10).catch(err => { console.warn('Cancel warning:', err.message); return []; });
    const rawOrderItems = await fetchPaged(CFG.orderItemsPath, oiFrom, t, 25).catch(err => { console.warn('Order-items warning:', err.message); return []; });
    // Current item availability (one snapshot, not a date range).
    const rawItemsSnapshot = await fetchItemsSnapshot().catch(err => { console.warn('Item availability warning:', err.message); return []; });

    const opsMap = new Map();
    rawOps.forEach(o => {
      if (o.orderId) opsMap.set(String(o.orderId), o);
      if (o.externalId) opsMap.set(String(o.externalId), o);
    });

    const cancelMap = new Map();
    rawCancels.forEach(c => {
      if (c.uniqueOrderId) cancelMap.set(String(c.uniqueOrderId), c);
      if (c.orderId) cancelMap.set(String(c.orderId), c);
    });

    STORE.liveOpsCount = rawOps.length;
    STORE.liveCancelCount = rawCancels.length;

    // Merge operations & cancellation timings into live orders. GrubCENTER's
    // cancellation report also lists orders that were cancelled and then
    // REOPENED (reason "Order reopened") -- those are active again, not
    // cancelled, so they must not be flagged here even though they appear
    // in the report. (Confirmed against the live account: 235 of 2157
    // orders in one test window were wrongly marked cancelled this way --
    // the single largest source of the dashboard undercounting GrubTech's
    // own totals.)
    const mergedLive = rawSales.map(s => {
      const oid = String(s.orderId || s.id || '');
      const ext = String(s.externalId || '');
      const op = opsMap.get(oid) || opsMap.get(ext) || {};
      const cl = cancelMap.get(oid) || cancelMap.get(ext) || {};
      const reopened = REOPENED_RE.test(cl.reason || '');
      return {
        ...s,
        acceptedAt: op.acceptedAt || s.acceptedAt,
        startedAt: op.startedAt || s.startedAt,
        preparedAt: op.preparedAt || s.preparedAt,
        sentToDispatcherAt: op.sentToDispatcherAt || s.sentToDispatcherAt || op.sentToDispatchAt,
        dispatchedAt: op.dispatchedAt || s.dispatchedAt,
        completedAt: op.completedAt || s.completedAt,
        cancelled: (cl.reason && !reopened) ? true : (s.cancelled || false),
        postCancelled: cl.postCancelled === 'Yes' || cl.postCancelled === true,
        reason: reopened ? (s.cancellationReason || s.reason || '') : (cl.reason || s.cancellationReason || s.reason || '')
      };
    });

    const normLive = N.normalizeOrders(mergedLive).map(o => ({ ...o, source: 'grubcenter' }));

    const officialBrandsFile = path.join(__dirname, 'data', 'official_foodhive_brands.json');
    let official = null;
    if (fs.existsSync(officialBrandsFile)) {
      try { official = new Set(JSON.parse(fs.readFileSync(officialBrandsFile, 'utf8')).map(b => b.toLowerCase().trim())); } catch (_) {}
    }
    const filteredLive = official ? normLive.filter(o => o.brand && official.has(String(o.brand).toLowerCase().trim())) : normLive;

    // GrubCENTER's recurring sandbox fixture (brand "TEST BRAND" / channel
    // "Grubtech Test") is already excluded from new syncs by the official-
    // brands allowlist above, but rows ingested before that fix landed may
    // still be sitting in the master map -- purge them here too, on every
    // sync, so they self-clean instead of lingering forever.
    for (const [id, o] of STORE.ordersMap) {
      if (o.brand === 'TEST BRAND' || o.channel === 'Grubtech Test') STORE.ordersMap.delete(id);
    }

    // Merge into in-memory master map
    let newCount = 0;
    filteredLive.forEach(o => {
      if (!STORE.ordersMap.has(o.id)) newCount++;
      STORE.ordersMap.set(o.id, o);
    });

    // Also enrich any historical orders that match ops/cancel IDs
    STORE.ordersMap.forEach(o => {
      const op = opsMap.get(o.id);
      if (op) {
        if (!o.acceptedAt && op.acceptedAt) o.acceptedAt = op.acceptedAt;
        if (!o.startedAt && op.startedAt) o.startedAt = op.startedAt;
        if (!o.preparedAt && op.preparedAt) o.preparedAt = op.preparedAt;
        if (!o.dispatchedAt && op.dispatchedAt) o.dispatchedAt = op.dispatchedAt;
        if (!o.deliveredAt && op.completedAt) o.deliveredAt = op.completedAt;
      }
      const cl = cancelMap.get(o.id);
      if (cl && !REOPENED_RE.test(cl.reason || '')) {
        o.cancelled = true;
        o.reason = cl.reason || o.reason;
        o.postCancelled = cl.postCancelled === 'Yes' || cl.postCancelled === true;
      }
    });

    STORE.ordersArray = [...STORE.ordersMap.values()];
    STORE.lastSync = Date.now();
    console.log(`[GrubCENTER Sync Complete] Master now has ${STORE.ordersArray.length} orders (+${newCount} new, ${rawOps.length} ops timings attached)`);

    // Line items: re-fetching [oiFrom, t] returns the complete, authoritative
    // set of rows for every day in THAT window, so replace (not
    // merge-by-guessed-key) whatever this sync's days already held in the
    // store, then keep anything older untouched -- a deeper local backfill
    // must not be wiped out just because this sync only covers oiFrom..t.
    // A day GrubCENTER did not return keeps the lines already stored for it.
    const normOrderItems = N.normalizeOrderItems(rawOrderItems);
    const oiFailed = rawOrderItems.failedDays || [];
    const touchedDays = new Set(dayChunks(oiFrom, t).filter(d => !oiFailed.includes(d)));
    // An invalid/missing `at` makes dubaiDateKey() return "NaN-NaN-NaN", which
    // never matches touchedDays -- drop such rows instead of letting them
    // silently survive every future resync forever.
    const hasValidDate = x => !dubaiDateKey(x.at).includes('NaN');
    STORE.orderItemsArray = STORE.orderItemsArray
      .filter(x => hasValidDate(x) && !touchedDays.has(dubaiDateKey(x.at)))
      .concat(normOrderItems.filter(x => hasValidDate(x) && touchedDays.has(dubaiDateKey(x.at))));
    console.log(`[GrubCENTER Sync Complete] ${STORE.orderItemsArray.length} order line items in store (${normOrderItems.length} refreshed for this window)`);

    // Atomic cache persist: write to a temp file then rename over the real
    // one. A plain fs.writeFile() interrupted mid-write (Ctrl-C, crash, OOM)
    // leaves truncated JSON behind, and the next boot then silently falls
    // back to an older/smaller cache -- which looks exactly like the sync
    // "losing" thousands of orders. rename() is atomic on one filesystem.
    persistJson('all_orders.json', STORE.ordersArray);
    persistJson('order_items.json', STORE.orderItemsArray);

    // 86 items: add the items currently Unavailable in GrubCENTER to the
    // event log. Skipped when the snapshot fetch failed (empty), so a bad
    // pull never wipes anything.
    if (rawItemsSnapshot.length) {
      const fresh = N.mergeItemEvents(N.snapshotToItemEvents(rawItemsSnapshot));
      STORE.itemsArray = N.mergeItemEvents(STORE.itemsArray, fresh);
      STORE.itemsLastSync = Date.now();
      persistJson('items_snapshot_events.json', STORE.itemsArray.filter(x => x.source === N.SNAPSHOT_SOURCE));
      console.log(`[GrubCENTER Sync Complete] ${fresh.length} items currently 86'd, ${STORE.itemsArray.length} 86 events in store`);
    }
  } catch (err) {
    console.error('[GrubCENTER Sync Error]', err.message);
  }
}

// ---------- Live view (polled every 10 s by the dashboard) ----------
// Today's orders and cancellations straight from GrubCENTER, shared for 10 s
// across all viewers and never written to the cache files. Same rules as
// runSync for cancellations, reopened orders, official brands and the test
// fixture. Prep timings and older days still come from the regular sync.
const LIVE_TTL_MS = 10000;
const live = { at: 0, data: null, promise: null };
async function liveToday() {
  if (live.data && Date.now() - live.at < LIVE_TTL_MS) return live.data;
  if (live.promise) return live.promise;
  live.promise = (async () => {
    const s = await ensureSession();
    const pid = findPartnerId(s.claims);
    const day = today();
    const [rawSales, rawCancels] = await Promise.all([
      fetchPagedOneRange(CFG.ordersPath, day, day, 5, s, pid),
      fetchPagedOneRange(CFG.cancelPath, day, day, 2, s, pid).catch(() => [])
    ]);
    const cancelMap = new Map();
    rawCancels.forEach(c => {
      if (c.uniqueOrderId) cancelMap.set(String(c.uniqueOrderId), c);
      if (c.orderId) cancelMap.set(String(c.orderId), c);
    });
    const merged = rawSales.map(o => {
      const cl = cancelMap.get(String(o.orderId || o.id || '')) || cancelMap.get(String(o.externalId || '')) || {};
      const reopened = REOPENED_RE.test(cl.reason || '');
      return {
        ...o,
        cancelled: (cl.reason && !reopened) ? true : (o.cancelled || false),
        postCancelled: cl.postCancelled === 'Yes' || cl.postCancelled === true,
        reason: reopened ? (o.cancellationReason || o.reason || '') : (cl.reason || o.cancellationReason || o.reason || '')
      };
    });
    let official = null;
    try { official = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'official_foodhive_brands.json'), 'utf8')).map(b => b.toLowerCase().trim())); } catch (_) {}
    const orders = N.normalizeOrders(merged).map(o => ({ ...o, source: 'grubcenter' })).filter(o =>
      o.brand !== 'TEST BRAND' && o.channel !== 'Grubtech Test' &&
      (!official || (o.brand && official.has(String(o.brand).toLowerCase().trim()))));
    live.data = { day, at: Date.now(), orders };
    live.at = live.data.at;
    return live.data;
  })().finally(() => { live.promise = null; });
  return live.promise;
}

let bgSyncPromise = null;
let manualSyncPromise = null;
const syncBusy = () => !!(bgSyncPromise || manualSyncPromise);

function syncGrubcenter(from, to, itemsFrom) {
  if (bgSyncPromise) return bgSyncPromise;
  STORE.syncing = true;
  bgSyncPromise = runSync(from, to, itemsFrom).finally(() => {
    bgSyncPromise = null;
    STORE.syncing = syncBusy();
  });
  return bgSyncPromise;
}

// UI "Sync Now". Deliberately does NOT join bgSyncPromise: a 14-day
// background pull takes minutes, so waiting for it would put the button back
// where it started. A narrow (1-3 day) pull costs a handful of extra
// requests, and both syncs merge into the same in-memory STORE.
function syncNowManual(from, to, itemsFrom) {
  if (manualSyncPromise) return manualSyncPromise;
  STORE.syncing = true;
  manualSyncPromise = runSync(from, to, itemsFrom).finally(() => {
    manualSyncPromise = null;
    STORE.syncing = syncBusy();
  });
  return manualSyncPromise;
}

// Background warm sync on boot. A 14-day window is enough to catch up after
// a restart (the rest of the history is already on disk); a deeper backfill
// is still available through /api/refresh?full=1. BOOT_SYNC_DAYS exists so a
// quick smoke test can boot with a shorter pull.
const BOOT_SYNC_DAYS = +E.BOOT_SYNC_DAYS || 14;
let lastWideSyncAt = Date.now();
setTimeout(() => {
  if (!CFG.email || !CFG.password) return;
  lastWideSyncAt = Date.now();
  syncGrubcenter(daysAgo(BOOT_SYNC_DAYS), today(), daysAgo(7)).catch(() => {});
}, 500);

// Frequent (10-minute) refresh: just today + yesterday. This is what keeps
// the live totals moving. The old 14-day window took ~6 minutes per tick, so
// a background sync was running for most of every 10-minute cycle and any
// Sync Now press in that window used to be silently discarded.
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  if (CFG.email && CFG.password) syncGrubcenter(daysAgo(1), today(), daysAgo(1)).catch(() => {});
}, SYNC_INTERVAL_MS);

// Wider reconciliation every 3 hours (plus the boot pull above): a late
// cancellation / ops timestamp can land on an order received many days ago,
// which a 2-day window would never pick up. The once-a-minute check skips
// while another background pull is still running.
const WIDE_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  if (!CFG.email || !CFG.password || bgSyncPromise) return;
  if (Date.now() - lastWideSyncAt < WIDE_SYNC_INTERVAL_MS) return;
  lastWideSyncAt = Date.now();
  syncGrubcenter(daysAgo(14), today(), daysAgo(7)).catch(() => {});
}, 60 * 1000);

// ---------- Zoho Books (accounting) ----------
let zohoSession = null;

async function zohoLogin() {
  if (!(CFG.zohoClientId && CFG.zohoClientSecret && CFG.zohoRefreshToken)) {
    throw new Error('ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN not set');
  }
  const r = await fetch(`${CFG.zohoAccountsDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CFG.zohoClientId,
      client_secret: CFG.zohoClientSecret,
      refresh_token: CFG.zohoRefreshToken
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Zoho auth failed: ' + (j.error || r.status));
  zohoSession = { accessToken: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return zohoSession;
}
const ensureZohoSession = async () => (zohoSession && zohoSession.exp > Date.now() ? zohoSession : zohoLogin());

async function zget(p, query) {
  const s = await ensureZohoSession();
  const qp = new URLSearchParams({ organization_id: CFG.zohoOrgId, ...(query || {}) });
  const url = `${CFG.zohoApiDomain}/books/v3${p}?${qp}`;
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${s.accessToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (typeof j.code === 'number' && j.code !== 0)) {
    throw new Error(`Zoho ${r.status} ${p}: ${j.message || r.statusText}`);
  }
  return j;
}

// Zoho list endpoints (invoices/bills) cap at per_page=200 and flag more pages via page_context.has_more_page.
async function zGetAllPages(p, listKey, query) {
  const all = [];
  for (let page = 1; ; page++) {
    const j = await zget(p, { ...query, per_page: 200, page });
    all.push(...(j[listKey] || []));
    if (!j.page_context || !j.page_context.has_more_page) break;
  }
  return all;
}

// Zoho's Profit & Loss report nests sections arbitrarily deep (e.g. "Gross
// Profit" > account_transactions > "Operating Income" / "Cost of Goods
// Sold"), so this recurses into a flat { "Operating Income": 12345, ... }
// name->total lookup instead of assuming a fixed depth. First-occurrence-wins
// (not last) -- if a name were ever repeated at a deeper level, the
// authoritative top-level total (visited first in a top-down walk) must not
// be silently overwritten by a coincidentally-same-named descendant.
function flattenPL(rows, map) {
  map = map || {};
  for (const r of (rows || [])) {
    if (!(r.name in map)) map[r.name] = +r.total || 0;
    if (r.account_transactions && r.account_transactions.length) flattenPL(r.account_transactions, map);
  }
  return map;
}

function monthRange(offsetMonths) {
  const now = new Date(Date.now() + DUBAI_OFFSET_MS);
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + offsetMonths;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  const iso = d => d.toISOString().slice(0, 10);
  // Current month only: cap `to` at today, not the calendar month-end. The
  // frontend's GrubCENTER current-month revenue figure
  // (grubCenterMonthFigures()) is always month-to-date (no future orders
  // can exist), so the Zoho expense window fetched here must share that
  // same anchor -- otherwise Net Profit/True Net Profit blend a
  // month-to-date revenue figure against a full-month expense figure (e.g.
  // a pre-dated recurring bill later in the month would count as an
  // expense before its matching revenue days have actually happened).
  // Closed/past months keep the full calendar month-end, since "today"
  // doesn't apply to them.
  const to = offsetMonths === 0 ? iso(now) : iso(end);
  return {
    from: iso(start), to,
    key: `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}`,
    label: start.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  };
}

async function fetchPLTotals(from, to) {
  const j = await zget('/reports/profitandloss', { from_date: from, to_date: to });
  const m = flattenPL(j.profit_and_loss);
  const income = (m['Operating Income'] || 0) + (m['Non Operating Income'] || 0);
  const expenses = (m['Cost of Goods Sold'] || 0) + (m['Operating Expense'] || 0) + (m['Non Operating Expense'] || 0);
  const netProfit = m['Net Profit/Loss'] != null ? m['Net Profit/Loss'] : income - expenses;
  return { income, expenses, netProfit, rawTree: j.profit_and_loss };
}

// Finds a named section (not a same-named leaf -- see flattenPL's comment on
// why Zoho can repeat a section's own name as a leaf directly beneath it)
// by returning the first match found in a top-down walk, then maps that
// section's immediate children into { name, amount } leaf items. This has
// to recurse: verified against live data that 'Cost of Goods Sold' and
// 'Operating Expense' are NOT top-level rows here -- they're nested several
// levels under grouping rows like "Gross Profit"/"Operating Profit", so a
// top-level-only scan (tried and reverted) silently found nothing. Used to
// surface EBITDA's reference panel: the real account-level breakdown behind
// the "Cost of Goods Sold"/"Operating Expense" totals, which the flattened
// income/expenses/netProfit numbers alone don't expose.
function findSection(rows, name) {
  for (const r of (rows || [])) {
    if (r.name === name) return r;
    if (r.account_transactions && r.account_transactions.length) {
      const found = findSection(r.account_transactions, name);
      if (found) return found;
    }
  }
  return null;
}
function extractCategoryBreakdown(tree) {
  const leafItems = section => ((section && section.account_transactions) || []).map(r => ({ name: r.name, amount: +r.total || 0 }));
  const cogs = findSection(tree, 'Cost of Goods Sold');
  const opex = findSection(tree, 'Operating Expense');
  return {
    cogs: { total: cogs ? +cogs.total || 0 : 0, items: leafItems(cogs) },
    operatingExpense: { total: opex ? +opex.total || 0 : 0, items: leafItems(opex) }
  };
}

async function fetchBalanceSheet() {
  const j = await zget('/reports/balancesheet', { as_of_date: today() });
  return j.balance_sheet || [];
}

// Zoho's Balance Sheet report is always exactly two top-level rows (Assets,
// then Liabilities & Equities), so this reads off that stable position
// rather than matching an exact label string that could vary by org/locale.
// "Total Liabilities"/"Total Equities" one level down are standard Zoho
// labels, matched directly like flattenPL()/findSection() do elsewhere.
function extractBalanceSheet(tree) {
  const assetsRow = (tree || [])[0] || null;
  const liabEquityRow = (tree || [])[1] || null;
  const findChild = (row, label) => ((row && row.account_transactions) || []).find(r => r.total_label === label || r.name === label) || null;
  const liabilitiesRow = findChild(liabEquityRow, 'Total Liabilities');
  const equityRow = findChild(liabEquityRow, 'Total Equities');
  const totalAssets = assetsRow ? +assetsRow.total || 0 : 0;
  const totalLiabilities = liabilitiesRow ? +liabilitiesRow.total || 0 : 0;
  const totalEquity = equityRow ? +equityRow.total || 0 : 0;
  return {
    totalAssets, totalLiabilities, totalEquity,
    // Sanity check on the accounting equation (Assets = Liabilities +
    // Equity), since totalEquity is read independently off Zoho's own
    // "Total Equities" row rather than computed as Assets - Liabilities --
    // a wrong two-row positional guess above or a Zoho-side reporting
    // quirk would otherwise pass through silently. 1 AED tolerance for
    // report rounding.
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1,
    tree: tree || []
  };
}

// One-time (first sync only): find the real start of this org's books by
// asking Zoho for its single earliest bill and earliest invoice, so the P&L
// trend can be backfilled from actual day one instead of a guessed window.
async function findEarliestBookDate() {
  let earliest = null;
  for (const [p, key] of [['/bills', 'bills'], ['/invoices', 'invoices']]) {
    try {
      const j = await zget(p, { sort_column: 'date', sort_order: 'A', per_page: 1 });
      const d = j[key] && j[key][0] && j[key][0].date;
      if (d && (!earliest || d < earliest)) earliest = d;
    } catch (_) { /* endpoint unavailable or empty -- fall through */ }
  }
  return earliest; // 'YYYY-MM-DD' or null if the org has no bills/invoices yet
}

// How many whole months back `dateStr`'s month is from the current
// (Dubai-local) month -- e.g. last month = 1, this month = 0.
function monthsBack(dateStr) {
  const now = new Date(Date.now() + DUBAI_OFFSET_MS);
  const [y, m] = dateStr.split('-').map(Number);
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (m - 1));
}

// Pull live accounting KPIs: a permanently-cumulative P&L trend (backfilled
// once from the org's actual earliest bill/invoice, then only rolled
// forward -- never capped/truncated), cash position, A/R & A/P aging, and
// the full invoice/bill lists (for both the overdue KPIs and raw export).
async function syncZoho() {
  if (!(CFG.zohoClientId && CFG.zohoClientSecret && CFG.zohoRefreshToken && CFG.zohoOrgId)) return;
  // Without this, the 10-min interval, the manual "Sync Now" button, and a
  // stale-triggered request can all kick off a full sequential backfill at
  // once -- duplicating work and risking Zoho's per-minute rate limit, the
  // exact failure mode the sequential-fetch fix above was written to avoid.
  if (STORE.zohoSyncing) return;
  STORE.zohoSyncing = true;
  try {
    console.log('[Zoho Sync] Pulling accounting KPIs...');

    const prevByKey = new Map(((STORE.zoho && STORE.zoho.trend) || []).map(t => [t.key, t]));
    let offsetsToFetch;
    if (prevByKey.size === 0) {
      // First-ever sync: backfill every month since the org's actual first
      // bill/invoice, not a guessed window, so nothing is missed.
      const earliest = await findEarliestBookDate();
      const monthsOfHistory = earliest ? monthsBack(earliest) : 0;
      offsetsToFetch = Array.from({ length: monthsOfHistory + 1 }, (_, i) => i - monthsOfHistory);
      console.log(`[Zoho Sync] First run -- backfilling ${offsetsToFetch.length} month(s) of P&L history from ${earliest || 'this month'}`);
    } else {
      // Closed months don't change -- only refresh current + previous month.
      offsetsToFetch = [-1, 0];
    }

    // Sequential, not parallel: Zoho's reports endpoints enforce a fairly
    // tight per-minute request cap, and firing these calls concurrently
    // reliably triggers a 429 "exceeded the maximum number of requests per
    // minute" block that then takes several minutes to clear.
    const fetched = [];
    let currentMonthTree = null;
    for (const offset of offsetsToFetch) {
      const { key, label, from, to } = monthRange(offset);
      const { income, expenses, netProfit, rawTree } = await fetchPLTotals(from, to);
      fetched.push({ key, label, income, expenses, netProfit });
      if (offset === 0) currentMonthTree = rawTree;
    }
    fetched.forEach(f => prevByKey.set(f.key, f));

    // Unbounded and permanently cumulative -- once a month is fetched it
    // stays in the trend forever (sorted chronologically by key), instead of
    // being capped/sliced to a fixed trailing window.
    const trend = [...prevByKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const current = trend[trend.length - 1];

    const bankResp = await zget('/bankaccounts', {});
    const arAging = await zget('/reports/aragingsummary', { to_date: today() });
    const apAging = await zget('/reports/apagingsummary', { to_date: today() });
    const balanceSheetTree = await fetchBalanceSheet();
    // Full lists (all statuses), not just overdue -- these double as both
    // the overdue KPI source below and the raw data for Data Export.
    const allInvoices = await zGetAllPages('/invoices', 'invoices', {});
    const allBills = await zGetAllPages('/bills', 'bills', {});
    // Balance + due-date based, not status-based: Zoho relabels an invoice/bill
    // 'partially_paid' once any payment lands, even if it's still outstanding
    // and past due, so a status==='overdue' filter alone silently drops those
    // records.
    const todayKey = today();
    // Drafts and voids are not yet (or no longer) owed, so never overdue.
    const isOverdue = x => (+x.balance || 0) > 0 && x.due_date && x.due_date < todayKey && x.status !== 'draft' && x.status !== 'void';
    const overdueInvoices = allInvoices.filter(isOverdue);
    const overdueBills = allBills.filter(isOverdue);

    const activeBankAccounts = (bankResp.bankaccounts || []).filter(a => a.is_active && (a.account_type === 'bank' || a.account_type === 'cash'));

    const toBuckets = intervals => (intervals || []).map(i => ({ label: i.interval_formatted, amount: +i.amount || 0 }));

    STORE.zoho = {
      income: current.income,
      expenses: current.expenses,
      netProfit: current.netProfit,
      netMargin: current.income ? current.netProfit / current.income : 0,
      // The calendar month current.income/expenses/netProfit actually cover,
      // so the frontend can detect (and warn) when this is stale against its
      // own live-clock "current month" -- e.g. right after a month rollover,
      // before the next sync has re-fetched the new month's P&L.
      currentMonthKey: current.key,
      currentMonthExpenseBreakdown: extractCategoryBreakdown(currentMonthTree),
      balanceSheet: extractBalanceSheet(balanceSheetTree),
      bankAccounts: activeBankAccounts.map(a => ({ name: a.account_name, type: a.account_type, balance: +a.balance || 0, currency: a.currency_code })),
      ar: arAging.invoice ? +arAging.invoice.total || 0 : 0,
      ap: apAging.bills ? +apAging.bills.total || 0 : 0,
      arAging: toBuckets(arAging.invoice && arAging.invoice.intervals),
      apAging: toBuckets(apAging.bills && apAging.bills.intervals),
      overdueInvoices: { count: overdueInvoices.length, amount: overdueInvoices.reduce((s, i) => s + (+i.balance || 0), 0) },
      overdueBills: { count: overdueBills.length, amount: overdueBills.reduce((s, b) => s + (+b.balance || 0), 0) },
      invoices: allInvoices,
      bills: allBills,
      trend,
      currency: (bankResp.bankaccounts && bankResp.bankaccounts[0] && bankResp.bankaccounts[0].currency_code) || 'AED',
      lastSync: Date.now()
    };

    fs.writeFile(path.join(__dirname, 'data', 'zoho_cache.json'), JSON.stringify(STORE.zoho), () => {});
    console.log(`[Zoho Sync Complete] Income ${STORE.zoho.income}, Expenses ${STORE.zoho.expenses}, Net Profit ${STORE.zoho.netProfit}`);
  } catch (err) {
    console.error('[Zoho Sync Error]', err.message);
  } finally {
    STORE.zohoSyncing = false;
  }
}

setTimeout(() => { syncZoho().catch(() => {}); }, 1500);
setInterval(() => { syncZoho().catch(() => {}); }, SYNC_INTERVAL_MS);

// ---------- HTTP SERVER ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

// Request body as text, capped at 2 MB (ratings captures are a few KB).
function readRequestBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendGzip(req, res, code, obj) {
  const jsonStr = JSON.stringify(obj);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const accept = req.headers['accept-encoding'] || '';
  if (accept.includes('gzip') && jsonStr.length > 2048) {
    zlib.gzip(Buffer.from(jsonStr), (err, gz) => {
      if (err) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        return res.end(jsonStr);
      }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
  } else {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(jsonStr);
  }
}

// ---------- UrbanPiper (Jaddaf) storage: data/ files, same io shape as Vercel's Blob ----------
const UP_EVENTS_DIR = path.join(__dirname, 'data', 'up_events');
let upLockChain = Promise.resolve();
const upSave = (file, key) => async v => {
  STORE[key] = v;
  const f = path.join(__dirname, 'data', file);
  if (v == null) { try { fs.unlinkSync(f); } catch (_) {} return; }
  fs.writeFileSync(f, JSON.stringify(v));
};
const upFileIo = {
  readMeta: async () => STORE.upMeta, writeMeta: upSave('up_meta.json', 'upMeta'),
  readOrders: async () => STORE.upOrders, writeOrders: upSave('up_orders.json', 'upOrders'),
  readOrderItems: async () => STORE.upOrderItems, writeOrderItems: upSave('up_order_items.json', 'upOrderItems'),
  readItems: async () => STORE.upItems, writeItems: upSave('up_items.json', 'upItems'),
  writeCatalog: upSave('up_catalog.json', 'upCatalog'),
  readConn: async () => STORE.upConn, writeConn: upSave('up_conn.json', 'upConn'),
  // Webhook events: one file each in data/up_events/ (gitignored with data/).
  putEvent: async (name, obj) => { fs.mkdirSync(UP_EVENTS_DIR, { recursive: true }); fs.writeFileSync(path.join(UP_EVENTS_DIR, path.basename(name)), JSON.stringify(obj)); },
  listEvents: async () => { try { return fs.readdirSync(UP_EVENTS_DIR).filter(n => n.endsWith('.json')).map(n => ({ name: n, uploadedAt: fs.statSync(path.join(UP_EVENTS_DIR, n)).mtimeMs })); } catch (_) { return []; } },
  readEvent: async name => { try { return JSON.parse(fs.readFileSync(path.join(UP_EVENTS_DIR, path.basename(name)), 'utf8')); } catch (_) { return null; } },
  delEvents: async names => { names.forEach(n => { try { fs.unlinkSync(path.join(UP_EVENTS_DIR, path.basename(n))); } catch (_) {} }); },
  readWh: async () => STORE.upWh || {}, writeWh: upSave('up_wh.json', 'upWh'),
  // One writer of up_orders at a time inside this process.
  withLock: fn => { const run = upLockChain.then(fn, fn); upLockChain = run.catch(() => {}); return run; }
};
const syncAtlas = opts => AtlasSync.syncAtlasOnce(upFileIo, opts).then(r => {
  if (r.ok) console.log(`[Atlas Sync] ${r.from}..${r.to}: ${r.listed} listed, ${r.added} new, ${r.updated} updated, ${r.removed} removed (${r.ms} ms)`);
  else if (!r.needsConnect || STORE.upMeta.atlasConnectedAt) console.warn('[Atlas Sync] ' + r.error);
  return r;
});
// Jaddaf on the same 10-minute rhythm as GrubCENTER while connected.
setInterval(() => { if (AtlasSync.connectionState(STORE.upConn).connected) syncAtlas({ catalog: undefined }).catch(() => {}); }, 10 * 60 * 1000);
setTimeout(() => { if (AtlasSync.connectionState(STORE.upConn).connected) syncAtlas({}).catch(() => {}); }, 1500);

// ---------- Sources: GrubCENTER (Motor City) + UrbanPiper (Jaddaf) ----------
// Each source keeps its own store so writers never race; readers merge.
// Orders cached before `source` existed all came from GrubCENTER.
const tagSource = (arr, source) => (arr || []).map(o => (o && !o.source ? { ...o, source } : o));
const allOrders = () => tagSource(STORE.ordersArray, 'grubcenter').concat(tagSource(STORE.upOrders, 'urbanpiper'));
const allOrderItems = () => tagSource(STORE.orderItemsArray, 'grubcenter').concat(tagSource(STORE.upOrderItems, 'urbanpiper'));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/sources') {
      const zohoConfigured = !!(CFG.zohoClientId && CFG.zohoClientSecret && CFG.zohoRefreshToken && CFG.zohoOrgId);
      const gcConfigured = !!(CFG.email && CFG.password);
      const sources = FHSources.describeSources({
        grubcenter: { configured: gcConfigured, lastSync: STORE.lastSync },
        items86: { configured: gcConfigured, lastSync: STORE.itemsLastSync || 0, records: STORE.itemsArray.length },
        ...AtlasSync.upFacts(STORE.upMeta, STORE.upOrders.length, STORE.upConn),
        aggRatings: { configured: true, lastSync: FHRatings.lastCapture(STORE.brandRatings), records: STORE.brandRatings ? FHRatings.cellCount(STORE.brandRatings) : null, note: STORE.brandRatings ? null : 'No ratings imported yet' },
        zoho: { configured: zohoConfigured, lastSync: STORE.zoho && STORE.zoho.lastSync }
      });
      return sendGzip(req, res, 200, { checkedAt: Date.now(), summary: FHSources.summarize(sources), sources });
    }

    if (u.pathname === '/api/brand-ratings') {
      if (req.method === 'GET') return sendGzip(req, res, 200, STORE.brandRatings || FHRatings.empty());
      if (req.method !== 'POST') return sendGzip(req, res, 405, { ok: false, error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(await readRequestBody(req) || '{}'); } catch (_) { return sendGzip(req, res, 400, { ok: false, error: 'Body is not valid JSON' }); }
      const err = FHRatings.validate(body);
      if (err) return sendGzip(req, res, 400, { ok: false, error: err });
      STORE.brandRatings = FHRatings.merge(STORE.brandRatings, body);
      fs.writeFileSync(path.join(__dirname, 'data', 'brand_ratings.json'), JSON.stringify(STORE.brandRatings));
      return sendGzip(req, res, 200, { ok: true, doc: STORE.brandRatings });
    }

    if (u.pathname === '/api/up-connect') {
      if (req.method !== 'POST') return sendGzip(req, res, 405, { ok: false, error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}'); } catch (_) { return sendGzip(req, res, 400, { ok: false, error: 'Body is not valid JSON' }); }
      try {
        const r = await AtlasSync.connect(body && body.token, upFileIo);
        if (r.json.ok) syncAtlas({}).catch(() => {});
        return sendGzip(req, res, r.status, r.json);
      } catch (e) { return sendGzip(req, res, 500, { ok: false, error: e.message }); }
    }

    // Line items sync inside runSync locally; the Vercel-only background
    // endpoint has nothing to do here.
    if (u.pathname === '/api/sync-line-items') return sendGzip(req, res, 200, { ok: true, local: true });

    if (u.pathname === '/api/up-webhook') {
      if (req.method !== 'POST') return sendGzip(req, res, 405, { ok: false, error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(await readRequestBody(req, 2 * 1024 * 1024) || '{}'); } catch (_) { return sendGzip(req, res, 400, { ok: false, error: 'Body is not valid JSON' }); }
      try {
        const r = await handleUpWebhook(req.headers, body, upFileIo);
        if (r.fold) UpWebhooks.foldOnce(upFileIo).then(f => { if (f && f.folded) console.log(`[UrbanPiper Webhook] folded ${f.folded} event(s)`); });
        return sendGzip(req, res, r.status, r.json);
      } catch (e) { return sendGzip(req, res, 500, { ok: false, error: 'Could not save the event' }); }
    }

    if (u.pathname === '/api/up-import') {
      if (req.method !== 'POST') return sendGzip(req, res, 405, { ok: false, error: 'Method not allowed' });
      let body;
      try { body = JSON.parse(await readRequestBody(req, 8 * 1024 * 1024) || '{}'); } catch (e) { return sendGzip(req, res, 400, { ok: false, error: e.message === 'Body too large' ? e.message : 'Body is not valid JSON' }); }
      try {
        const r = await importAtlasCapture(body, upFileIo);
        return sendGzip(req, res, r.status, r.json);
      } catch (e) { return sendGzip(req, res, 500, { ok: false, error: e.message }); }
    }

    if (u.pathname === '/api/status') {
      // lastSync / syncing are reported even when the Cognito check fails:
      // the UI polls them to know when a sync finished, and dropping them on
      // an auth blip made the poll look like an eternal "still running".
      const out = {
        configured: !!(CFG.email && CFG.password), connected: false, user: CFG.email || null, partnerId: null,
        lastSync: STORE.lastSync, cachedCount: STORE.ordersArray.length, syncing: syncBusy()
      };
      if (out.configured) {
        try {
          const s = await ensureSession();
          out.connected = true;
          out.partnerId = findPartnerId(s.claims);
          out.claims = { email: s.claims.email, partnerStatus: s.claims.partnerStatus };
        } catch (e) { out.error = e.message; }
      }
      return sendGzip(req, res, 200, out);
    }

    if (u.pathname === '/api/refresh') {
      // Sync Now pulls both kitchens at once. Atlas (Jaddaf) finishes inside
      // this request and its exact result goes back in `atlas`; GrubCENTER
      // (Motor City) runs on and the client polls lastSync.
      const atlasRun = UpWebhooks.foldOnce(upFileIo).then(() => syncAtlas({ catalog: u.searchParams.get('catalog') === '1' ? true : undefined })).catch(e => ({ ok: false, error: e.message }));
      if (!(CFG.email && CFG.password)) {
        return sendGzip(req, res, 200, { ok: false, configured: false, message: 'GrubCENTER credentials not configured on this server', atlas: await atlasRun });
      }
      const full = u.searchParams.get('full') === '1';
      // `full=1` forces a complete 45-day re-sync regardless of cached data,
      // useful when the local cache is suspected to be incomplete or stale.
      if (full) {
        const busy = !!bgSyncPromise;
        syncGrubcenter(daysAgo(45), today()).catch(() => {});
        return sendGzip(req, res, 200, {
          ok: true, configured: true, busy,
          message: busy ? 'A background sync is already running' : 'Full 45-day re-sync started',
          atlas: await atlasRun
        });
      }
      // The button must return quickly. A 14-day pull takes ~6 minutes, and
      // the old code silently ignored any press while that was running. Cap
      // the on-demand window at 3 days (today only when no range is given),
      // so it finishes in well under a minute and runs alongside a
      // background sync instead of being dropped.
      const to = u.searchParams.get('to') || today();
      const requestedFrom = u.searchParams.get('from');
      const maxDays = 3;
      const minFrom = new Date(new Date(to + 'T00:00:00Z').getTime() - maxDays * 864e5).toISOString().slice(0, 10);
      // No explicit range (the All / Week / Month pills) -> refresh just
      // today. A short explicit range (one day, or a few) is honoured as-is;
      // anything older is handled by the background reconciliation.
      const from = requestedFrom && requestedFrom >= minFrom && requestedFrom <= to ? requestedFrom : to;
      const busy = !!manualSyncPromise;
      syncNowManual(from, to, from).catch(() => {});
      return sendGzip(req, res, 200, {
        ok: true, configured: true, busy,
        message: busy ? 'A sync is already running' : 'Sync started',
        from, to, days: dayChunks(from, to).length,
        atlas: await atlasRun
      });
    }

    if (u.pathname === '/api/orders') {
      const from = u.searchParams.get('from'), to = u.searchParams.get('to');
      // GrubCENTER (Motor City) + UrbanPiper (Jaddaf), each tagged with `source`.
      const all = allOrders();
      let filtered = all;
      if (from || to) {
        filtered = all.filter(o => {
          if (!o.receivedAt) return false;
          const d = dubaiDateKey(o.receivedAt);
          return (!from || d >= from) && (!to || d <= to);
        });
      }

      // If the cache is stale (>10 min) and nothing is currently syncing,
      // kick off a narrow background refresh. A wide 45-day pull used to
      // start here on every stale page load and take minutes; today +
      // yesterday is enough to keep the visible totals moving, and the
      // 3-hourly reconciliation covers late updates to older orders.
      const stale = CFG.email && CFG.password && Date.now() - STORE.lastSync > SYNC_INTERVAL_MS;
      if (stale && !syncBusy()) {
        // Honour a short explicit range (e.g. the user opened a specific day
        // that isn't cached yet), but never fan out to the whole selection.
        const bgTo = to || today();
        const bgFrom = from && from >= daysAgo(2) && from <= bgTo ? from : daysAgo(1);
        syncGrubcenter(bgFrom, bgTo, bgFrom).catch(() => {});
      }

      return sendGzip(req, res, 200, {
        count: filtered.length,
        totalInStore: all.length,
        orders: filtered,
        opsCount: STORE.liveOpsCount,
        cancelCount: STORE.liveCancelCount,
        lastSync: STORE.lastSync,
        stale: !!stale
      });
    }

    if (u.pathname === '/api/order-items') {
      // Same date window as Vercel's api/order-items.js: last 35 days unless
      // a range is asked for; older history is fetched on demand.
      const from = u.searchParams.get('from'), to = u.searchParams.get('to');
      return sendGzip(req, res, 200, { ...lineItemsResponse(allOrderItems(), from, to, dubaiDateKey), lastSync: STORE.lastSync });
    }

    if (u.pathname === '/api/cached-exports') {
      return sendGzip(req, res, 200, {
        orders: STORE.ordersArray,
        items: STORE.itemsArray,
        orderItems: STORE.orderItemsArray,
        count: STORE.ordersArray.length,
        itemsCount: STORE.itemsArray.length
      });
    }

    if (u.pathname === '/api/live') {
      if (!CFG.email || !CFG.password) return sendGzip(req, res, 200, { ok: false, configured: false, orders: [] });
      try {
        const d = await liveToday();
        return sendGzip(req, res, 200, { ok: true, day: d.day, at: d.at, orders: d.orders });
      } catch (e) {
        return sendGzip(req, res, 200, { ok: false, error: String(e.message || e).slice(0, 200), orders: [] });
      }
    }

    if (u.pathname === '/api/availability') {
      return sendGzip(req, res, 200, { items: STORE.itemsArray.concat(STORE.upItems || []) });
    }

    if (u.pathname === '/api/accounting') {
      const configured = !!(CFG.zohoClientId && CFG.zohoClientSecret && CFG.zohoRefreshToken && CFG.zohoOrgId);
      return sendGzip(req, res, 200, STORE.zoho || { configured, lastSync: 0 });
    }

    if (u.pathname === '/api/accounting/refresh') {
      if (!(CFG.zohoClientId && CFG.zohoClientSecret && CFG.zohoRefreshToken && CFG.zohoOrgId)) {
        return sendGzip(req, res, 200, { ok: false, configured: false, message: 'Zoho Books credentials not configured on this server' });
      }
      syncZoho().catch(() => {});
      return sendGzip(req, res, 200, { ok: true, configured: true, message: 'Zoho sync started' });
    }

    // Static files
    let f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => {
      // This callback runs after the enclosing try/catch has already
      // returned, so an exception here (e.g. writing to an already-aborted
      // connection) would otherwise be an uncaught exception on a fresh
      // stack -- handled directly rather than relying on the process-level
      // fallback alone.
      try {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        res.end(buf);
      } catch (e) {
        console.error('Static file response error:', e.message);
      }
    });
  } catch (e) {
    console.error('Server error:', e);
    sendGzip(req, res, 502, { error: e.message });
  }
}).listen(CFG.port, () => console.log(`FoodHive Operations & Sales server running on port ${CFG.port} with ${STORE.ordersArray.length} master Foodhive orders pre-warmed.`));
