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
  pageSize: +E.GRUBCENTER_PAGE_SIZE || 200
};

// ---------- auth ----------
let session = null;
const b64json = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

async function cognito(target, body) {
  const r = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body)
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
async function gt(method, base, p, query, body) {
  const s = await ensureSession();
  const url = base.replace(/\/$/, '') + '/' + p.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : '');
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (CFG.tokenType === 'access' ? s.accessToken : s.idToken) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  if (!r.ok) { const e = new Error(`Grubtech ${r.status} ${url}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`); e.status = r.status; throw e; }
  return json;
}

const rowsOf = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.items || d.content || d.results || d.orders || d.records)) || [];
const bounds = (from, to) => ({ timezone: CFG.timezone, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });

// Fetch one single-day range, with offset pagination for busy days.
async function fetchPagedOneRange(pathPart, from, to, maxPages, s, pid) {
  let lastErr;
  for (const base of CFG.apiBases) {
    try {
      const first = await gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`,
        { ...bounds(from, to), limit: CFG.pageSize, offset: 0 }, {});
      const firstRows = rowsOf(first);
      const all = [...firstRows];
      if (firstRows.length < CFG.pageSize) return all;

      // Parallel batch fetch for remaining pages
      const pagePromises = [];
      const batchSize = Math.min(maxPages, 16);
      for (let page = 1; page < batchSize; page++) {
        pagePromises.push(
          gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`,
            { ...bounds(from, to), limit: CFG.pageSize, offset: page * CFG.pageSize }, {})
            .then(d => rowsOf(d))
            .catch(() => [])
        );
      }
      const results = await Promise.all(pagePromises);
      for (const rows of results) {
        all.push(...rows);
        if (rows.length < CFG.pageSize) break;
      }
      return all;
    } catch (e) { lastErr = e; if (e.status && ![404, 405].includes(e.status)) throw e; }
  }
  throw lastErr;
}

// GrubCENTER's order-details endpoint silently caps a wide [from, to] range
// to roughly one page's worth of (apparently most-recent) rows instead of
// paginating through the whole range -- confirmed experimentally: a single
// day returns its true, complete count (e.g. matches GrubCENTER's own
// "Yesterday" dashboard figure exactly), but a 3-day range returns FEWER
// total rows than that single busiest day alone returns by itself. Querying
// day-by-day and merging is the only way to get a complete pull.
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

async function fetchPaged(pathPart, from, to, maxPages = 20) {
  const s = await ensureSession();
  const pid = findPartnerId(s.claims);
  const days = dayChunks(from, to);
  const CONCURRENCY = 3;
  const all = [];
  const failedDays = [];
  for (let i = 0; i < days.length; i += CONCURRENCY) {
    const batch = days.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(day =>
      fetchDayWithRetry(pathPart, day, maxPages, s, pid).then(rows => ({ day, rows }))
    ));
    results.forEach(({ day, rows }) => { if (rows === null) failedDays.push(day); else all.push(...rows); });
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
  lastSync: 0,
  syncing: false,
  liveOpsCount: 0,
  liveCancelCount: 0
};

// 1. Initial preload from disk
function preloadData() {
  const t0 = Date.now();
  const allFile = path.join(__dirname, 'data', 'all_orders.json');
  const cachedFile = path.join(__dirname, 'data', 'cached_orders.json');
  const itemsFile = path.join(__dirname, 'data', 'cached_items.json');

  let list = [];
  if (fs.existsSync(allFile)) {
    try { list = JSON.parse(fs.readFileSync(allFile, 'utf8')); } catch (_) {}
  } else if (fs.existsSync(cachedFile)) {
    try { list = N.normalizeOrders(JSON.parse(fs.readFileSync(cachedFile, 'utf8'))); } catch (_) {}
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

  console.log(`[Cache Preload] Loaded ${STORE.ordersArray.length} master FoodHive orders & ${STORE.itemsArray.length} items in ${Date.now() - t0}ms`);
}
preloadData();

const REOPENED_RE = /reopen/i;

// 2. Synchronize live GrubCENTER data into master store
async function syncGrubcenter(from, to) {
  if (STORE.syncing) return;
  STORE.syncing = true;
  const f = from || daysAgo(45), t = to || today();
  try {
    console.log(`[GrubCENTER Sync] Pulling live data (${f} to ${t})...`);
    // Sequential, not parallel: each of these already fans out multiple
    // concurrent day-chunked requests internally, and running all three
    // endpoints at once compounds that into enough concurrent load to
    // trigger rate-limiting/transient failures on GrubCENTER's side.
    const rawSales = await fetchPaged(CFG.ordersPath, f, t, 25);
    const rawOps = await fetchPaged(CFG.opsPath, f, t, 20).catch(err => { console.warn('Ops warning:', err.message); return []; });
    const rawCancels = await fetchPaged(CFG.cancelPath, f, t, 10).catch(err => { console.warn('Cancel warning:', err.message); return []; });

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

    const normLive = N.normalizeOrders(mergedLive);

    const officialBrandsFile = path.join(__dirname, 'data', 'official_foodhive_brands.json');
    let official = null;
    if (fs.existsSync(officialBrandsFile)) {
      try { official = new Set(JSON.parse(fs.readFileSync(officialBrandsFile, 'utf8')).map(b => b.toLowerCase().trim())); } catch (_) {}
    }
    const filteredLive = official ? normLive.filter(o => o.brand && official.has(String(o.brand).toLowerCase().trim())) : normLive;

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

    // Async persist to disk
    fs.writeFile(path.join(__dirname, 'data', 'all_orders.json'), JSON.stringify(STORE.ordersArray), () => {});
  } catch (err) {
    console.error('[GrubCENTER Sync Error]', err.message);
  } finally {
    STORE.syncing = false;
  }
}

// Background warm sync on boot
setTimeout(() => {
  if (CFG.email && CFG.password) syncGrubcenter().catch(() => {});
}, 500);

// Background refresh every 10 minutes
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  if (CFG.email && CFG.password) syncGrubcenter().catch(() => {});
}, SYNC_INTERVAL_MS);

// ---------- HTTP SERVER ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

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

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/status') {
      const out = { configured: !!(CFG.email && CFG.password), connected: false, user: CFG.email || null, partnerId: null };
      if (out.configured) {
        try {
          const s = await ensureSession();
          out.connected = true;
          out.partnerId = findPartnerId(s.claims);
          out.claims = { email: s.claims.email, partnerStatus: s.claims.partnerStatus };
          out.lastSync = STORE.lastSync;
          out.cachedCount = STORE.ordersArray.length;
        } catch (e) { out.error = e.message; }
      }
      return sendGzip(req, res, 200, out);
    }

    if (u.pathname === '/api/refresh') {
      syncGrubcenter(u.searchParams.get('from'), u.searchParams.get('to')).catch(() => {});
      return sendGzip(req, res, 200, { ok: true, message: 'Sync started' });
    }

    if (u.pathname === '/api/orders') {
      const from = u.searchParams.get('from'), to = u.searchParams.get('to');
      let filtered = STORE.ordersArray;
      if (from || to) {
        filtered = STORE.ordersArray.filter(o => {
          if (!o.receivedAt) return false;
          const d = dubaiDateKey(o.receivedAt);
          return (!from || d >= from) && (!to || d <= to);
        });
      }

      // If cache is stale (>10 min) and not currently syncing, kick off background sync
      if (Date.now() - STORE.lastSync > SYNC_INTERVAL_MS && !STORE.syncing && CFG.email && CFG.password) {
        syncGrubcenter(from, to).catch(() => {});
      }

      return sendGzip(req, res, 200, {
        count: filtered.length,
        totalInStore: STORE.ordersArray.length,
        orders: filtered,
        opsCount: STORE.liveOpsCount,
        cancelCount: STORE.liveCancelCount,
        lastSync: STORE.lastSync
      });
    }

    if (u.pathname === '/api/cached-exports') {
      return sendGzip(req, res, 200, {
        orders: STORE.ordersArray,
        items: STORE.itemsArray,
        count: STORE.ordersArray.length,
        itemsCount: STORE.itemsArray.length
      });
    }

    if (u.pathname === '/api/availability') {
      return sendGzip(req, res, 200, { items: STORE.itemsArray });
    }

    // Static files
    let f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
    if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error('Server error:', e);
    sendGzip(req, res, 502, { error: e.message });
  }
}).listen(CFG.port, () => console.log(`FoodHive Operations & Sales server running on port ${CFG.port} with ${STORE.ordersArray.length} master Foodhive orders pre-warmed.`));
