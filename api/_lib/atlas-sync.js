/* Server-side sync of UrbanPiper Atlas (Jaddaf), shared by Vercel functions
   and server.js through an `io` object (Blob store or data/ files).

   Atlas has no API keys. The dashboard holds the Atlas session token that
   the Atlas bookmarklet hands over (Connect dashboard). It is kept private,
   never returned by any endpoint, and used until Atlas itself expires it
   (about 7 days), capped at CONNECT_TTL_MS after connecting. Data Sources
   warns RENEW_WARN_MS before that so the user can reconnect in time.

   Accuracy rules for an orders sync:
   - Every page of the order list is read (a repeated cursor is an error).
   - Every listed order's detail is fetched, with retries. If any detail is
     still missing, nothing is written and the error is reported.
   - Each detail must be the order asked for and fall inside the window.
   - After merging, the stored Jaddaf orders in the window must equal the
     listed non-test orders exactly; otherwise nothing is written. */
const FHAtlas = require('../../public/atlas.js');
const UpWebhooks = require('./up-webhooks');

const CONNECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_WARN_MS = 24 * 60 * 60 * 1000;
const EXPECTED_BIZ_ID = String(process.env.ATLAS_BIZ_ID || '37055789');
const DEFAULT_BACKFILL_DAYS = 30;
const MAX_WINDOW_DAYS = 45;
const OVERLAP_DAYS = 2;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const dubaiDay = ms => new Date(ms + 4 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class AtlasAuthError extends Error {}

// Payload of the Atlas JWT (not verified here; Atlas verifies it on use).
function tokenClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) { return null; }
}
// Atlas writes "2026-11-20 12:29:03.203480" (UTC) or epoch seconds/ms.
function claimTime(v) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = +v; return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(String(v).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1') + 'Z');
  return isFinite(t) ? t : null;
}

// Public view of a stored connection: never includes the token.
function connectionState(conn, now = Date.now()) {
  if (!conn || !conn.token) return { connected: false, reason: 'Not connected. Click the Atlas bookmark, then Connect dashboard.' };
  const useUntil = Math.min(conn.connectedAt + CONNECT_TTL_MS, conn.expiresAt || Infinity);
  if (now >= useUntil) return { connected: false, expired: true, connectedAt: conn.connectedAt, useUntil, reason: 'Atlas connection expired. Reconnect with the Atlas bookmark.' };
  return { connected: true, connectedAt: conn.connectedAt, useUntil, expiresSoon: useUntil - now <= RENEW_WARN_MS };
}

async function gql(token, query, variables, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(FHAtlas.API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ query, variables })
      });
      if (r.status === 401 || r.status === 403) throw new AtlasAuthError('Atlas rejected the session (' + r.status + '). Reconnect with the Atlas bookmark.');
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error('Atlas HTTP ' + r.status);
      if (j.errors && j.errors.length) {
        const m = j.errors[0].message || 'GraphQL error';
        if (/not allowed|auth|token|login|permission|unauthori[sz]ed|forbidden/i.test(m)) throw new AtlasAuthError('Atlas rejected the session: ' + m);
        throw new Error('Atlas: ' + m);
      }
      return j.data;
    } catch (e) {
      if (e instanceof AtlasAuthError) throw e;
      last = e;
      if (i < attempts - 1) await sleep(500 * Math.pow(2, i));
    }
  }
  throw last;
}

// Check a token handed over by the bookmarklet and build the stored record.
async function connect(token, io, now = Date.now()) {
  if (typeof token !== 'string' || token.split('.').length !== 3 || token.length > 10000) return { status: 400, json: { ok: false, error: 'That is not an Atlas session.' } };
  const c = tokenClaims(token);
  if (!c) return { status: 400, json: { ok: false, error: 'That is not an Atlas session.' } };
  const bizId = String(c.biz_id != null ? c.biz_id : c.app_biz_id);
  if (bizId !== EXPECTED_BIZ_ID) return { status: 403, json: { ok: false, error: `This Atlas login is for another business (${bizId}). Sign in to the FoodHive Atlas account.` } };
  const expiresAt = claimTime(c.expires_on || c.exp);
  if (expiresAt && expiresAt <= now) return { status: 400, json: { ok: false, error: 'This Atlas session has already expired. Sign in to Atlas again.' } };
  try {
    await gql(token, FHAtlas.QUERIES.list, { limit: 1, sort: { field: 'id', order: 'DESC' }, filters: [{ field: 'created', value: 'TODAY' }], brand: 'all', cursor: null }, 2);
  } catch (e) {
    return { status: 400, json: { ok: false, error: e.message } };
  }
  const conn = { token, bizId, expiresAt: expiresAt || null, connectedAt: now };
  await io.writeConn(conn);
  const meta = (await io.readMeta()) || {};
  await io.writeMeta({ ...meta, atlasConnectedAt: now, atlasUseUntil: connectionState(conn, now).useUntil, atlasError: null });
  return { status: 200, json: { ok: true, ...connectionState(conn, now) } };
}

// Window: re-read the last OVERLAP_DAYS (late cancellations) and everything
// since the last good sync, capped. First sync backfills 30 days.
function syncWindow(meta, now, from, to) {
  const today = dubaiDay(now);
  const t = to && to <= today ? to : today;
  const floor = addDays(t, -(MAX_WINDOW_DAYS - 1));
  let f = addDays(t, -OVERLAP_DAYS);
  if (meta && meta.atlasSyncTo) { const since = addDays(meta.atlasSyncTo, -OVERLAP_DAYS); if (since < f) f = since; }
  else f = addDays(t, -(DEFAULT_BACKFILL_DAYS - 1));
  if (from && from < f) f = from;
  if (f < floor) f = floor;
  return { from: f, to: t };
}

async function listIds(token, from, to) {
  const ids = [], seen = new Set(), cursors = new Set();
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const d = await gql(token, FHAtlas.QUERIES.list, { limit: 100, sort: { field: 'id', order: 'DESC' }, filters: [{ field: 'created', value: from + ',' + to }], brand: 'all', cursor });
    const l = d && d.ordersV2;
    if (!l || !Array.isArray(l.objects)) throw new Error('Atlas order list came back empty-handed');
    for (const o of l.objects) if (!seen.has(String(o.id))) { seen.add(String(o.id)); ids.push(o.id); }
    if (!l.hasNext) return ids;
    if (!l.nextCursor || cursors.has(l.nextCursor)) throw new Error('Atlas order list paging repeated itself; not saving a partial list');
    cursors.add(l.nextCursor);
    cursor = l.nextCursor;
  }
  throw new Error('Atlas order list has more than 50,000 orders in this window');
}

// Order detail with its charge lines (delivery vs service, for Prime Net
// Revenue). If Atlas rejects the charges field, use the query without it
// from then on in this instance; orders then keep deliveryCharges null.
let chargesUnsupported = false;
async function orderDetail(token, id, attempts) {
  if (!chargesUnsupported) {
    try { return await gql(token, FHAtlas.QUERIES.order, { id: +id }, attempts); } catch (e) {
      if (e instanceof AtlasAuthError || !/charges|cannot query field|unknown field/i.test(e.message)) throw e;
      chargesUnsupported = true;
      console.warn('[Atlas] order charges not available: ' + e.message);
    }
  }
  return gql(token, FHAtlas.QUERIES.orderBasic, { id: +id }, attempts);
}

async function fetchDetails(token, ids, from, to) {
  const out = new Array(ids.length), failed = [];
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++, id = ids[i];
      try {
        const d = await orderDetail(token, id, 4);
        const o = d && d.order;
        if (!o || String(o.id) !== String(id)) throw new Error('detail for another order');
        const day = String(o.created).slice(0, 10);
        if (day < from || day > to) throw new Error(`created ${o.created} is outside ${from}..${to}`);
        out[i] = FHAtlas.fromDetail(o);
      } catch (e) {
        if (e instanceof AtlasAuthError) throw e;
        failed.push(`${id} (${e.message})`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed.length) throw new Error(`${failed.length} of ${ids.length} Atlas orders could not be read; nothing was saved. First: ${failed[0]}`);
  return out;
}

async function syncCatalog(token, io, now) {
  const items = [];
  let offset = 0, total = null;
  for (let page = 0; page < 300; page++) {
    const d = await gql(token, FHAtlas.QUERIES.items, { limit: 100, offset, filters: [], brand: 'all' });
    const l = d && d.items;
    if (!l || !Array.isArray(l.objects)) throw new Error('Atlas catalogue came back empty-handed');
    total = l.count;
    l.objects.forEach(i => items.push(FHAtlas.fromItem(i)));
    offset += l.objects.length;
    if (!l.objects.length || offset >= total) break;
  }
  if (total != null && items.length !== total) throw new Error(`Atlas catalogue read ${items.length} of ${total} items; nothing was saved`);
  const catalog = FHAtlas.normalizeCatalog({ items });
  const events = FHAtlas.catalogEvents(await io.readItems(), catalog, now);
  await Promise.all([io.writeCatalog({ capturedAt: now, receivedAt: now, source: 'atlas-sync', items: catalog }), io.writeItems(events)]);
  return { items: catalog.length, disabled: catalog.filter(i => !i.enabled).length };
}

// One sync. Returns { ok, ... } and never throws; errors are also recorded
// in meta.atlasError so Data Sources shows them.
async function syncAtlas(io, opts = {}) {
  const now = Date.now();
  const meta = (await io.readMeta()) || {};
  const conn = await io.readConn();
  const state = connectionState(conn, now);
  if (!state.connected) return { ok: false, needsConnect: true, error: state.reason };
  const win = syncWindow(meta, now, opts.from, opts.to);
  const t0 = Date.now();
  try {
    const ids = await listIds(conn.token, win.from, win.to);
    const orders = await fetchDetails(conn.token, ids, win.from, win.to);
    const capture = { kind: 'orders', from: win.from, to: win.to, orders };
    const bad = FHAtlas.validate(capture);
    if (bad) throw new Error('Atlas data failed validation: ' + bad);
    let catalog = null;
    if (opts.catalog !== false && (opts.catalog === true || !meta.catalogAt || now - meta.catalogAt > CATALOG_MAX_AGE_MS)) {
      try { catalog = await syncCatalog(conn.token, io, now); } catch (e) { catalog = { error: e.message }; }
    }
    // Read, merge and write under the same lock the webhook fold uses, so
    // neither overwrites the other's orders or meta.
    const locked = io.withLock || (fn => fn());
    return await locked(async () => {
    const [stored, lines] = await Promise.all([io.readOrders(), io.readOrderItems()]);
    const r = FHAtlas.mergeOrders(stored, lines, capture);
    // Reconcile: stored Jaddaf orders in the window == listed non-test orders.
    const expected = new Set(orders.filter(o => !FHAtlas.isTest(o)).map(o => 'up_' + o.id));
    const inWindow = r.orders.filter(o => { const d = dubaiDay(o.receivedAt); return d >= win.from && d <= win.to; });
    const extra = inWindow.filter(o => !expected.has(o.id));
    const missing = [...expected].filter(id => !r.orders.some(o => o.id === id));
    if (missing.length) throw new Error(`Reconciliation failed: ${missing.length} Atlas orders missing after merge; nothing was saved`);
    // Orders stored earlier but no longer listed by Atlas for these days were
    // deleted or turned out to be tests there; drop them so totals match.
    const finalOrders = extra.length ? r.orders.filter(o => !extra.some(x => x.id === o.id)) : r.orders;
    const finalLines = extra.length ? r.lines.filter(l => !extra.some(x => x.id === l.orderId)) : r.lines;
    await Promise.all([io.writeOrders(finalOrders), io.writeOrderItems(finalLines)]);
    const result = { ok: true, from: win.from, to: win.to, listed: ids.length, saved: expected.size, added: r.added, updated: r.updated, removed: extra.length, skippedTests: r.tests, purgedPreLive: r.purgedPreLive || 0, total: finalOrders.length, ms: Date.now() - t0 };
    const fresh = (await io.readMeta()) || {};
    // Cross-check webhook copies against these Atlas records.
    let reconcile = fresh.reconcile || null;
    if (fresh.firstWebhookAt && io.readWh) {
      const inWin = finalOrders.filter(o => { const d = dubaiDay(o.receivedAt); return d >= win.from && d <= win.to; });
      reconcile = { at: now, ...UpWebhooks.reconcile(inWin, (await io.readWh()) || {}, fresh.firstRelayAt || null, win.from, win.to) };
      result.reconcile = { compared: reconcile.compared, diffs: reconcile.diffCount, missingInWebhook: reconcile.missingInWebhook.length, extraInWebhook: reconcile.extraInWebhook.length };
    }
    await io.writeMeta({ ...fresh, lastCaptureAt: now, atlasSyncTo: win.to, capturedRange: [win.from, win.to], orderCount: finalOrders.length, atlasError: null, atlasLast: result, reconcile,
      purgedPreLive: (fresh.purgedPreLive || 0) + (r.purgedPreLive || 0),
      ...(catalog && !catalog.error ? { catalogAt: now, catalogItems: catalog.items } : {}) });
    return { ...result, catalog };
    });
  } catch (e) {
    if (e instanceof AtlasAuthError) await io.writeConn(null).catch(() => {});
    const fresh = (await io.readMeta().catch(() => null)) || meta;
    await io.writeMeta({ ...fresh, atlasError: e.message, atlasErrorAt: now }).catch(() => {});
    return { ok: false, needsConnect: e instanceof AtlasAuthError, error: e.message, from: win.from, to: win.to };
  }
}

// Data Sources facts for the two UrbanPiper rows (public/sources.js).
function upFacts(meta, orderCount, conn, now = Date.now()) {
  const m = meta && !meta.__error ? meta : {};
  const st = connectionState(conn, now);
  const when = ms => {
    const d = new Date(ms + 4 * 3600e3);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.toISOString().slice(11, 16);
  };
  const recentError = m.atlasError && (m.atlasErrorAt || 0) > (m.lastCaptureAt || 0) ? m.atlasError : null;
  let note;
  if (st.connected && st.expiresSoon) note = `Atlas session ends ${when(st.useUntil)} (Dubai). Reconnect with the Atlas bookmark before then to keep Jaddaf syncing.`;
  else if (st.connected) note = `Atlas connected. Syncs automatically until ${when(st.useUntil)} (Dubai).`;
  else if (m.atlasConnectedAt) note = 'Atlas connection expired, so Jaddaf is not syncing. Reconnect with the Atlas bookmark.';
  else note = 'Not connected. Use Update from Atlas → Connect dashboard.';
  // Webhooks live: they are the source of Jaddaf orders, and the Atlas
  // session is optional (catalogue and cross-check), so its expiry is a note.
  const wf = UpWebhooks.webhookFacts(m, now);
  if (wf) {
    const sess = st.connected ? `Atlas session (catalogue and cross-check) until ${when(st.useUntil)} (Dubai).`
      : 'Atlas session not connected (optional: catalogue and cross-check).';
    const atlasErr = recentError && st.connected ? ` Last Atlas sync failed: ${recentError}` : '';
    return {
      upOrders: { configured: true, lastSync: wf.lastSync, staleAfter: wf.staleAfter, records: orderCount, error: (meta && meta.__error) || wf.error, note: `${wf.note} ${sess}${atlasErr}` },
      upCatalog: { configured: true, lastSync: m.catalogAt || 0, records: m.catalogItems || null, note: m.catalogAt ? null : 'No Atlas catalogue yet.' }
    };
  }
  return {
    upOrders: {
      configured: true,
      lastSync: m.lastCaptureAt || 0,
      records: orderCount,
      error: (meta && meta.__error) || recentError || (!st.connected && m.atlasConnectedAt ? 'Reconnect Atlas: the connection has expired' : null),
      warn: st.connected && st.expiresSoon ? 'Atlas session ends within a day' : null,
      note: m.capturedRange && m.capturedRange[0] ? `${note} Last sync covered ${m.capturedRange[0]} to ${m.capturedRange[1]}.` : note
    },
    upCatalog: { configured: true, lastSync: m.catalogAt || 0, records: m.catalogItems || null, note: m.catalogAt ? null : 'No Atlas catalogue yet.' }
  };
}

// One sync at a time per process: Sync Now, the page-load refresh and the
// cron can overlap, and two read-merge-writes of up_orders.json must not race.
let inflight = null;
function syncAtlasOnce(io, opts) {
  if (!inflight) inflight = syncAtlas(io, opts).finally(() => { inflight = null; });
  return inflight;
}

// One order's Atlas record through the connected session, or null (no
// session, or Atlas refused). Used to verify a webhook key (tryAdopt).
async function fetchOrderDetail(io, id) {
  const conn = await io.readConn();
  if (!connectionState(conn).connected) return null;
  try {
    const d = await orderDetail(conn.token, id, 2);
    return d && d.order ? FHAtlas.fromDetail(d.order) : null;
  } catch (_) { return null; }
}

module.exports = { fetchOrderDetail, syncAtlas, syncAtlasOnce, upFacts, syncCatalog, connect, connectionState, syncWindow, tokenClaims, claimTime, CONNECT_TTL_MS, RENEW_WARN_MS, EXPECTED_BIZ_ID };
