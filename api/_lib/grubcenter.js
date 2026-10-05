/* GrubCENTER auth + fetch + sync, adapted from server.js for stateless
 * serverless functions: the Cognito session is persisted in the meta blob
 * (via store.js) and passed in/out explicitly instead of living in a
 * module-level variable, since nothing here can rely on surviving between
 * invocations other than what's written to the Blob store. */
const N = require('../../public/normalize.js');
const { readOrders, writeOrders, readItems, readMeta, writeMeta, readBlobJson } = require('./store');

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
  pageSize: +E.GRUBCENTER_PAGE_SIZE || 200
};

const configured = () => !!(CFG.email && CFG.password);
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

async function gt(method, base, p, query, body, session) {
  const url = base.replace(/\/$/, '') + '/' + p.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : '');
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (CFG.tokenType === 'access' ? session.accessToken : session.idToken) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  if (!r.ok) { const e = new Error(`Grubtech ${r.status} ${url}: ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`); e.status = r.status; throw e; }
  return json;
}

const rowsOf = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.items || d.content || d.results || d.orders || d.records)) || [];
const bounds = (from, to) => ({ timezone: CFG.timezone, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });

async function fetchPaged(pathPart, from, to, maxPages, session) {
  const pid = findPartnerId(session.claims);
  let lastErr;
  for (const base of CFG.apiBases) {
    try {
      const first = await gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`,
        { ...bounds(from, to), limit: CFG.pageSize, offset: 0 }, {}, session);
      const firstRows = rowsOf(first);
      const all = [...firstRows];
      if (firstRows.length < CFG.pageSize) return all;

      const pagePromises = [];
      const batchSize = Math.min(maxPages, 16);
      for (let page = 1; page < batchSize; page++) {
        pagePromises.push(
          gt('POST', base, `${pathPart.replace(/\/$/, '')}/${pid}`,
            { ...bounds(from, to), limit: CFG.pageSize, offset: page * CFG.pageSize }, {}, session)
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

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/** Fetch new GrubCENTER data and merge it into the persisted orders blob.
 * Mirrors server.js's syncGrubcenter(), but reads/writes the Blob store
 * instead of an in-memory STORE + local disk. Returns a short summary. */
async function syncOnce(from, to) {
  if (!configured()) return { skipped: true, reason: 'not configured' };
  const meta = await readMeta();
  const session = await ensureSession(meta.session);
  const f = from || daysAgo(45), t = to || today();

  const [rawSales, rawOps, rawCancels] = await Promise.all([
    fetchPaged(CFG.ordersPath, f, t, 25, session),
    fetchPaged(CFG.opsPath, f, t, 20, session).catch(() => []),
    fetchPaged(CFG.cancelPath, f, t, 10, session).catch(() => [])
  ]);

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

  const mergedLive = rawSales.map(s => {
    const oid = String(s.orderId || s.id || '');
    const ext = String(s.externalId || '');
    const op = opsMap.get(oid) || opsMap.get(ext) || {};
    const cl = cancelMap.get(oid) || cancelMap.get(ext) || {};
    return {
      ...s,
      acceptedAt: op.acceptedAt || s.acceptedAt,
      startedAt: op.startedAt || s.startedAt,
      preparedAt: op.preparedAt || s.preparedAt,
      sentToDispatcherAt: op.sentToDispatcherAt || s.sentToDispatcherAt || op.sentToDispatchAt,
      dispatchedAt: op.dispatchedAt || s.dispatchedAt,
      completedAt: op.completedAt || s.completedAt,
      cancelled: cl.reason ? true : (s.cancelled || false),
      postCancelled: cl.postCancelled === 'Yes' || cl.postCancelled === true,
      reason: cl.reason || s.cancellationReason || s.reason || ''
    };
  });

  const normLive = N.normalizeOrders(mergedLive);

  const official = await (async () => {
    const list = await readBlobOfficialBrands().catch(() => null);
    return list ? new Set(list.map(b => b.toLowerCase().trim())) : null;
  })();
  const filteredLive = official ? normLive.filter(o => o.brand && official.has(String(o.brand).toLowerCase().trim())) : normLive;

  const ordersMap = new Map((await readOrders()).map(o => [o.id, o]));
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
    if (cl) {
      o.cancelled = true;
      o.reason = cl.reason || o.reason;
      o.postCancelled = cl.postCancelled === 'Yes' || cl.postCancelled === true;
    }
  });

  const ordersArray = [...ordersMap.values()];
  await writeOrders(ordersArray);
  await writeMeta({
    lastSync: Date.now(),
    session,
    liveOpsCount: rawOps.length,
    liveCancelCount: rawCancels.length
  });

  return { ok: true, total: ordersArray.length, newCount, opsCount: rawOps.length, cancelCount: rawCancels.length };
}

// Optional brand allow-list, same convention as server.js's data/official_foodhive_brands.json,
// seeded into the Blob store once (see scripts/seed-blob.js) rather than read off local disk.
const readBlobOfficialBrands = () => readBlobJson('official_foodhive_brands.json', null);

module.exports = { CFG, configured, ensureSession, findPartnerId, syncOnce, readOrders, writeOrders, readItems, readMeta };
