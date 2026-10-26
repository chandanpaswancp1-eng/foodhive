/* GrubCENTER auth + fetch + sync, adapted from server.js for stateless
 * serverless functions: the Cognito session is persisted in the meta blob
 * (via store.js) and passed in/out explicitly instead of living in a
 * module-level variable, since nothing here can rely on surviving between
 * invocations other than what's written to the Blob store. */
const N = require('../../public/normalize.js');
const { readOrders, writeOrders, readItems, readOrderItems, writeOrderItems, readMeta, writeMeta, readBlobJson } = require('./store');

const E = process.env;
const CFG = {
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
  pageSize: +E.GRUBCENTER_PAGE_SIZE || 500
};

const configured = () => !!(CFG.email && CFG.password);
const b64json = s => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

async function cognito(target, body) {
  const r = await fetch(`https://cognito-idp.${CFG.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
    // Never let a stalled auth socket outlive the function.
    signal: AbortSignal.timeout(20_000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.__type || `Cognito ${r.status}`);
  return j;
}

async function login() {
  if (!configured()) throw new Error('GRUBCENTER_EMAIL / GRUBCENTER_PASSWORD not set');
  let lastErr;
  for (const ClientId of CFG.clientIds) {
    try {
      const j = await cognito('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH', ClientId,
        AuthParameters: { USERNAME: CFG.email, PASSWORD: CFG.password }
      });
      if (j.ChallengeName) throw new Error(`Cognito challenge required: ${j.ChallengeName}`);
      const a = j.AuthenticationResult;
      return { idToken: a.IdToken, accessToken: a.AccessToken, exp: Date.now() + (a.ExpiresIn - 60) * 1000, claims: b64json(a.IdToken.split('.')[1]), clientId: ClientId };
    } catch (e) { lastErr = e; }
  }
  throw new Error('GrubCENTER login failed: ' + (lastErr ? lastErr.message : 'Unknown error'));
}

const ensureSession = async cached => (cached && cached.exp > Date.now() ? cached : login());

function findPartnerId(claims) {
  if (CFG.partnerId) return CFG.partnerId;
  for (const k in claims) if (/partner/i.test(k) && claims[k]) return String(claims[k]).split(',')[0];
  throw new Error('Could not find a partnerId in login token.');
}

// Retry policy for the reporting API:
//  - 429 (per-minute request cap): exponential backoff, 3 attempts.
//  - Network-level failures (ECONNRESET / socket hang up / DNS blip):
//    same backoff. Without this, a single dropped connection failed a whole
//    day, and with a 45-day x 4-report pull that turned a ~2-minute sync
//    into a 20+ minute retry crawl.
async function gt(method, base, p, query, body, session, retries = 3) {
  const url = base.replace(/\/$/, '') + '/' + p.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : '');
  for (let attempt = 0; attempt < retries; attempt++) {
    let r, text;
    try {
      r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (CFG.tokenType === 'access' ? session.accessToken : session.idToken) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        // A stalled connection would otherwise sit here until the function
        // itself is killed, holding the whole sync open. The retry loop
        // below treats the abort like any other network error.
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
async function fetchOnePage(base, pathPart, pid, query, session) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`, query, {}, session);
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
async function fetchPagedOneRange(pathPart, from, to, maxPages, session, pid) {
  let lastErr;
  for (const base of CFG.apiBases) {
    try {
      const all = [];
      const seen = new Set();
      let offset = 0;
      while (offset < maxPages * CFG.pageSize) {
        const rows = await fetchOnePage(base, pathPart, pid, { ...bounds(from, to), limit: CFG.pageSize, offset }, session);
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
// Note: on Vercel this means sync duration scales with the day count in
// [from, to] -- keep the window reasonable or it may hit the function's
// max execution duration.
function dayChunks(from, to) {
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// One retry before giving up on a day (kept short -- Vercel functions have
// a max execution duration, so this trades some reliability for staying
// within it, unlike server.js's more patient 3-attempt version). Returns
// null (not []) on failure so the caller can tell "failed" apart from
// "legitimately 0 orders that day" and report the gap instead of silently
// treating it as empty.
async function fetchDayWithRetry(pathPart, day, maxPages, session, pid) {
  try {
    return await fetchPagedOneRange(pathPart, day, day, maxPages, session, pid);
  } catch (e) {
    try {
      return await fetchPagedOneRange(pathPart, day, day, maxPages, session, pid);
    } catch (e2) {
      console.warn(`[sync] giving up on ${pathPart} ${day}: ${e2.message}`);
      return null;
    }
  }
}

async function fetchPaged(pathPart, from, to, maxPages, session) {
  const pid = findPartnerId(session.claims);
  const days = dayChunks(from, to);
  // Reduced from 3 to 2: each day already fans out multiple page requests.
  // 3 days of parallel page fetches reliably triggers GrubCENTER rate
  // limiting (429). 2 days keeps throughput high while staying under the
  // rate-limit threshold.
  const CONCURRENCY = 2;
  const all = [];
  const failedDays = [];
  for (let i = 0; i < days.length; i += CONCURRENCY) {
    const batch = days.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(day =>
      fetchDayWithRetry(pathPart, day, maxPages, session, pid).then(rows => ({ day, rows }))
    ));
    results.forEach(({ day, rows }) => { if (rows === null) failedDays.push(day); else all.push(...rows); });
    if (i % 10 === 0 || i + CONCURRENCY >= days.length) {
      console.log(`[sync] ${pathPart}: ${Math.min(i + CONCURRENCY, days.length)}/${days.length} days, ${all.length} rows`);
    }
    if (i + CONCURRENCY < days.length) await new Promise(res => setTimeout(res, 500));
  }
  // Surface gaps to the caller (syncOnce logs them) instead of letting a
  // partial pull look like a complete one.
  all.failedDays = failedDays;
  if (failedDays.length) console.warn(`[sync] ${pathPart}: ${failedDays.length} day(s) could not be fetched: ${failedDays.join(', ')}`);
  return all;
}

// The business runs on Asia/Dubai time (UTC+4, no DST). .toISOString() is
// always UTC regardless of the runtime's own local timezone -- and on
// Vercel that runtime defaults to UTC, so this isn't just a theoretical
// 4-hour edge case, it's the normal case there. dubaiDateKey() computes the
// correct Dubai-local calendar date for any timestamp regardless of host TZ.
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const pad2 = n => String(n).padStart(2, '0');
function dubaiDateKey(ms) {
  const d = new Date(ms + DUBAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const today = () => dubaiDateKey(Date.now());
const daysAgo = n => dubaiDateKey(Date.now() - n * 864e5);
const REOPENED_RE = /\breopen(ed)?\b/i;

/** Fetch new GrubCENTER data and merge it into the persisted orders blob.
 * Mirrors server.js's syncGrubcenter(), but reads/writes the Blob store
 * instead of an in-memory STORE + local disk. Returns a short summary. */
async function syncOnce(from, to, itemsFrom) {
  if (!configured()) return { skipped: true, reason: 'not configured' };
  const meta = await readMeta();
  const session = await ensureSession(meta.session);
  const f = from || daysAgo(45), t = to || today();
  // order-items has far more rows per day than orders (several lines per
  // order) and needs proportionally more pages/requests per day -- fetching
  // the full 45-day window for it here blew past Vercel's function duration
  // limit ("Task timed out after 300 seconds", confirmed in production
  // runtime logs) and, worse, did so *silently*: fetchDayWithRetry swallows
  // per-day failures and returns [], so the sync "succeeded" while quietly
  // writing only a couple of days of order-items instead of the requested
  // 45 -- orders/ops/cancel stayed complete because they're much lighter.
  // A shorter, reliably-completable window keeps whatever IS synced
  // trustworthy; the per-day merge-by-touched-days logic below only
  // replaces these recent days, so older order-items history already in
  // the blob (e.g. backfilled locally) is left alone, not truncated.
  const orderItemsFrom = itemsFrom || from || daysAgo(7);

  // Sequential, not parallel: each of these already fans out multiple
  // concurrent day-chunked requests internally (see fetchPaged), and
  // Promise.all-ing all four report types at once compounds that into
  // enough concurrent load to trigger rate-limiting/transient failures on
  // GrubCENTER's side -- the exact failure mode observed for order-items
  // above. Mirrors server.js's syncGrubcenter(), which fetches sequentially
  // for the same documented reason and has not hit this failure locally.
  const rawSales = await fetchPaged(CFG.ordersPath, f, t, 25, session);
  const rawOps = await fetchPaged(CFG.opsPath, f, t, 20, session).catch(() => []);
  const rawCancels = await fetchPaged(CFG.cancelPath, f, t, 10, session).catch(() => []);
  const rawOrderItems = await fetchPaged(CFG.orderItemsPath, orderItemsFrom, t, 25, session).catch(() => []);
  const failedDays = {
    orders: rawSales.failedDays || [],
    ops: rawOps.failedDays || [],
    cancel: rawCancels.failedDays || [],
    orderItems: rawOrderItems.failedDays || []
  };

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

  // GrubCENTER's cancellation report also lists orders that were cancelled
  // and then REOPENED (reason "Order reopened") -- those are active again,
  // not cancelled, so they must not be flagged here even though they
  // appear in the report (confirmed against the live account: this was the
  // single largest source of undercounting vs GrubCENTER's own totals).
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

  const official = await (async () => {
    const list = await readBlobOfficialBrands().catch(() => null);
    return list ? new Set(list.map(b => b.toLowerCase().trim())) : null;
  })();
  const filteredLive = official ? normLive.filter(o => o.brand && official.has(String(o.brand).toLowerCase().trim())) : normLive;

  const ordersMap = new Map((await readOrders()).map(o => [o.id, o]));
  // GrubCENTER's recurring sandbox fixture (brand "TEST BRAND" / channel
  // "Grubtech Test") is already excluded from new syncs by the official-
  // brands allowlist above, but rows ingested before that fix landed are
  // still sitting in the stored data -- purge them here too, on every
  // sync, so they self-clean instead of lingering forever. No-op once
  // they're gone.
  for (const [id, o] of ordersMap) {
    if (o.brand === 'TEST BRAND' || o.channel === 'Grubtech Test') ordersMap.delete(id);
  }
  let newCount = 0;
  filteredLive.forEach(o => {
    if (!ordersMap.has(o.id)) newCount++;
    ordersMap.set(o.id, o);
  });
  ordersMap.forEach(o => {
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

  const ordersArray = [...ordersMap.values()];
  await writeOrders(ordersArray);

  // A pull where EVERY requested day failed is a broken pull, not a
  // legitimately empty range -- don't mark the cache fresh, so the next
  // request retries immediately instead of waiting 10 minutes. An empty pull
  // whose days all succeeded (e.g. "today" just after midnight) is a real
  // result and must advance lastSync, otherwise the Sync Now button can
  // never detect completion.
  const rangeDays = dayChunks(f, t).length;
  const allDaysFailed = rawSales.length === 0 && (rawSales.failedDays || []).length === rangeDays;
  if (allDaysFailed) console.warn(`[sync] order-details failed for every day in ${f}..${t}; leaving lastSync untouched so the next request retries`);

  // Line items: [orderItemsFrom, t] (not the wider [f, t]) is re-fetched in
  // full each sync, so it's the authoritative set for every day in THAT
  // window -- replace whatever the store already held for those days rather
  // than merge-by-guessed-key, and leave anything older untouched (e.g. a
  // deeper local backfill already sitting in the blob must not be wiped out
  // just because this sync only covers the recent window).
  const normOrderItems = N.normalizeOrderItems(rawOrderItems);
  const touchedDays = new Set(dayChunks(orderItemsFrom, t));
  // An invalid/missing `at` makes dubaiDateKey() return "NaN-NaN-NaN", which
  // never matches touchedDays -- drop such rows instead of letting them
  // silently survive every future resync forever.
  const hasValidDate = x => !dubaiDateKey(x.at).includes('NaN');
  const existingOrderItems = await readOrderItems();
  const orderItemsArray = existingOrderItems
    .filter(x => hasValidDate(x) && !touchedDays.has(dubaiDateKey(x.at)))
    .concat(normOrderItems.filter(hasValidDate));
  await writeOrderItems(orderItemsArray);

  await writeMeta({
    lastSync: allDaysFailed ? (meta.lastSync || 0) : Date.now(),
    session,
    liveOpsCount: rawOps.length,
    liveCancelCount: rawCancels.length
  });

  return {
    ok: true,
    total: ordersArray.length,
    newCount,
    opsCount: rawOps.length,
    cancelCount: rawCancels.length,
    orderItemsCount: orderItemsArray.length,
    failedDays
  };
}

// Optional brand allow-list, same convention as server.js's data/official_foodhive_brands.json,
// seeded into the Blob store once (see scripts/seed-blob.js) rather than read off local disk.
const readBlobOfficialBrands = () => readBlobJson('official_foodhive_brands.json', null);

module.exports = { CFG, configured, ensureSession, findPartnerId, syncOnce, readOrders, writeOrders, readItems, readOrderItems, writeOrderItems, readMeta, dubaiDateKey };
