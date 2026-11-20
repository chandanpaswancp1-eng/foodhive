/* UrbanPiper webhooks for Jaddaf: Order Relay (a new order) and Order Status
   Update, set up in Atlas -> Settings -> Webhooks. They make Jaddaf live
   without the Atlas session, which is now only used for the catalogue and to
   cross-check the webhook data (reconcile below).

   Storage, through an `io` (api/_lib/up-blob-io.js or server.js upFileIo):
   - each delivery is saved as its own event (io.putEvent) and nothing else,
     so deliveries arriving together never overwrite each other;
   - fold() merges the events into up_orders.json / up_order_items.json under
     io.withLock, keeps each order's webhook copy in up_wh.json (for the
     cross-check and later status updates) and then deletes the events.
   Customer details are never stored: FHAtlas.fromWebhook drops them. */
const crypto = require('crypto');
const FHAtlas = require('../../public/atlas.js');

const EXPECTED_BIZ_ID = String(process.env.ATLAS_BIZ_ID || '37055789');
const KEEP_WH_DAYS = 45;
const ORPHAN_KEEP_MS = 3 * 864e5;
const RETRY_URL = 'https://pos-int.urbanpiper.com/external/api/v1/webhooks/retry/';
const OPEN_FROM_H = 11, OPEN_TO_H = 2;
const STALE_OPEN_MS = 6 * 3600e3;
const dubaiDay = ms => new Date(ms + 4 * 3600e3).toISOString().slice(0, 10);

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const sameHex = (x, y) => x.length === y.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y));
// The key in UP_WEBHOOK_SECRET, or the key Atlas actually sends once it has
// been verified against Atlas (tryAdopt; only its SHA-256 is stored).
function keyOk(given, adopted) {
  const want = process.env.UP_WEBHOOK_SECRET || '';
  if (typeof given !== 'string' || !given) return false;
  if (want) {
    const a = Buffer.from(given), b = Buffer.from(want);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return !!(adopted && adopted.hash && sameHex(sha(given), adopted.hash));
}

// Atlas sends a key we do not know (it was typed differently in Atlas).
// Trust it only when the delivery is proven real: a status update for this
// business whose exact status change (order, status, time within 2 minutes)
// Atlas's own record confirms through the connected session. Then keep the
// key's SHA-256, so later deliveries pass without the session. At most one
// check per key per minute per instance.
const adoptTried = new Map();
async function tryAdopt(io, given, body, fetchDetail, now = Date.now()) {
  if (typeof given !== 'string' || given.length < 12 || !io.readWhKey || !io.writeWhKey) return { adopted: false, reason: 'not possible' };
  const st = body && body.order_id != null && body.new_state ? FHAtlas.statusFromWebhook(body) : null;
  if (!st || st.bizId !== EXPECTED_BIZ_ID || !st.created) return { adopted: false, reason: 'not a status update for this business' };
  const hash = sha(given);
  const cur = await io.readWhKey();
  if (cur && cur.hash === hash) return { adopted: true, already: true };
  if (now - (adoptTried.get(hash) || 0) < 60e3) return { adopted: false, reason: 'checked recently' };
  adoptTried.set(hash, now);
  const detail = await fetchDetail(st.orderId).catch(() => null);
  if (!detail) return { adopted: false, reason: 'Atlas record not available' };
  const at = FHAtlas.atlasTime(st.created);
  const match = String(detail.id) === String(st.orderId) && (detail.statusUpdates || []).some(u =>
    FHAtlas.statusName(u.status) === st.status && Math.abs((FHAtlas.atlasTime(u.created) || 0) - at) <= 120e3);
  if (!match) return { adopted: false, reason: 'Atlas does not confirm this status change' };
  await io.writeWhKey({ hash, adoptedAt: now, verifiedBy: { order: st.orderId, status: st.status, at: st.created } });
  console.warn(`[up-webhook] Atlas key verified against order ${st.orderId} (${st.status}) and adopted`);
  return { adopted: true };
}

// A delivery to the event we store, or { ignore } for payloads that are not
// order events (UrbanPiper's retry summaries, pings).
function parseEvent(body) {
  if (body && body.order && body.order.details) {
    const raw = FHAtlas.fromWebhook(body);
    if (!raw) return { error: 'Order Relay without an order id' };
    if (raw.bizId && raw.bizId !== EXPECTED_BIZ_ID) return { error: `Order for another business (${raw.bizId})`, forbidden: true };
    if (!raw.created) return { error: `Order ${raw.id} has no created time` };
    const hash = crypto.createHash('sha1').update(JSON.stringify(raw)).digest('hex').slice(0, 12);
    return { event: { kind: 'relay', orderId: String(raw.id), at: FHAtlas.atlasTime(raw.created), raw }, name: `relay-${raw.id}-${hash}.json` };
  }
  if (body && body.order_id != null && body.new_state) {
    const st = FHAtlas.statusFromWebhook(body);
    if (st.bizId && st.bizId !== EXPECTED_BIZ_ID) return { error: `Status for another business (${st.bizId})`, forbidden: true };
    if (!st.created) return { error: `Status for ${st.orderId} has no time` };
    return { event: { kind: 'status', orderId: st.orderId, at: FHAtlas.atlasTime(st.created), status: st.status, created: st.created, message: st.message }, name: `status-${st.orderId}-${FHAtlas.atlasTime(st.created)}-${st.status}.json` };
  }
  return { ignore: true };
}

// Webhook copy of an order: the relay record plus every status update.
function rebuild(entry) {
  const ups = (entry.statuses || []).slice().sort((a, b) => (FHAtlas.atlasTime(a.created) || 0) - (FHAtlas.atlasTime(b.created) || 0));
  const raw = { ...entry.raw, statusUpdates: entry.raw.statusUpdates.concat(ups.map(u => ({ status: u.status, created: u.created, message: u.message || '' }))) };
  if (ups.length) raw.status = ups[ups.length - 1].status;
  return raw;
}

// Merge stored events into the Jaddaf orders. Safe to run any time and more
// than once: events are deleted only after the orders are written.
async function fold(io, now = Date.now()) {
  const names = await io.listEvents();
  if (!names.length) return { ok: true, events: 0 };
  return io.withLock(async () => {
    const evs = [];
    for (const n of names) { const e = await io.readEvent(n.name); if (e) evs.push({ ...e, _name: n.name, _up: n.uploadedAt }); }
    evs.sort((a, b) => (a.at || 0) - (b.at || 0));
    const [orders, lines, wh, meta] = await Promise.all([io.readOrders(), io.readOrderItems(), io.readWh(), io.readMeta()]);
    const whDoc = wh && typeof wh === 'object' ? { ...wh } : {};
    const done = [], rebuildIds = new Set(), patch = new Map();
    let orphans = 0;
    for (const e of evs) {
      const id = 'up_' + e.orderId;
      if (e.kind === 'relay') {
        const prev = whDoc[id];
        whDoc[id] = { raw: e.raw, statuses: prev ? prev.statuses : [], receivedAt: now };
        rebuildIds.add(id);
        done.push(e._name);
      } else if (e.kind === 'status') {
        const u = { status: e.status, created: e.created, message: e.message };
        if (whDoc[id]) {
          const seen = whDoc[id].statuses.some(s => s.status === u.status && s.created === u.created);
          if (!seen) whDoc[id].statuses.push(u);
          rebuildIds.add(id);
          done.push(e._name);
        } else if (orders.some(o => o.id === id)) {
          // Placed before the webhook was set up: patch the stored order.
          if (!patch.has(id)) patch.set(id, []);
          patch.get(id).push(u);
          done.push(e._name);
        } else if (now - (e._up || now) > ORPHAN_KEEP_MS) {
          orphans++;
          done.push(e._name);
        }
        // else: the relay may still arrive; keep the event for the next fold.
      } else done.push(e._name);
    }
    // Orders an Atlas sync already wrote keep Atlas's figures (the full
    // record); only their statuses move forward from webhooks.
    const byId = new Map(orders.map(o => [o.id, o]));
    const capture = [];
    for (const id of rebuildIds) {
      const cur = byId.get(id);
      if (cur && cur.via !== 'webhook') {
        if (!patch.has(id)) patch.set(id, []);
        patch.get(id).push(...whDoc[id].statuses);
      } else capture.push(rebuild(whDoc[id]));
    }
    const r = FHAtlas.mergeOrders(orders, lines, { kind: 'orders', orders: capture });
    let outOrders = r.orders;
    if (patch.size) outOrders = outOrders.map(o => (patch.has(o.id) ? FHAtlas.applyStatuses(o, patch.get(o.id)) : o));
    // Keep 45 days of webhook copies for the cross-check.
    const cutoff = now - KEEP_WH_DAYS * 864e5;
    for (const [id, v] of Object.entries(whDoc)) if ((FHAtlas.atlasTime(v.raw && v.raw.created) || 0) < cutoff) delete whDoc[id];
    await Promise.all([io.writeOrders(outOrders), io.writeOrderItems(r.lines), io.writeWh(whDoc)]);
    const lastEvent = evs.reduce((m, e) => Math.max(m, e.at || 0), meta.lastWebhookAt || 0);
    await io.writeMeta({ ...meta, lastWebhookAt: lastEvent, lastFoldAt: now, firstWebhookAt: meta.firstWebhookAt || now,
      webhookCount: (meta.webhookCount || 0) + done.length, webhookOrphans: (meta.webhookOrphans || 0) + orphans,
      orderCount: outOrders.length, purgedPreLive: (meta.purgedPreLive || 0) + (r.purgedPreLive || 0), webhookError: null });
    await io.delEvents(done);
    return { ok: true, events: evs.length, folded: done.length, orders: capture.length, patched: patch.size, kept: evs.length - done.length, orphans };
  });
}

let inflight = null;
function foldOnce(io) {
  if (!inflight) {
    inflight = fold(io).catch(async e => {
      try { const m = (await io.readMeta()) || {}; await io.writeMeta({ ...m, webhookError: e.message, webhookErrorAt: Date.now() }); } catch (_) {}
      return { ok: false, error: e.message };
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

// Cross-check: the Atlas order records (authoritative) against the webhook
// copies of the same orders, to the fils. Orders created before the first
// webhook are not expected to have a copy.
const FIELDS = ['status', 'cancelled', 'brand', 'channel', 'receiptTotal', 'discount', 'netSales', 'charges'];
function reconcile(atlasOrders, whDoc, firstWebhookAt, from, to) {
  const diffs = [], missing = [], extra = [];
  const atlasIds = new Set(atlasOrders.map(o => o.id));
  for (const a of atlasOrders) {
    const w = whDoc[a.id];
    if (!w) { if (firstWebhookAt && a.receivedAt > firstWebhookAt + 5 * 60e3) missing.push(a.id); continue; }
    const n = FHAtlas.normalizeOrder(rebuild(w));
    if (!n) continue;
    for (const f of FIELDS) {
      const x = a[f], y = n[f];
      const same = typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 0.005 : x === y;
      if (!same) diffs.push({ id: a.id, field: f, atlas: x, webhook: y });
    }
  }
  for (const [id, w] of Object.entries(whDoc)) {
    const d = String(w.raw.created).slice(0, 10);
    if (d >= from && d <= to && !atlasIds.has(id) && !FHAtlas.isTest(rebuild(w))) extra.push(id);
  }
  return { from, to, compared: atlasOrders.filter(o => whDoc[o.id]).length, diffs: diffs.slice(0, 50), diffCount: diffs.length, missingInWebhook: missing, extraInWebhook: extra };
}

// Ask UrbanPiper to resend Order Relay deliveries that failed in the last
// 24 hours (Settings -> API Access username and key; 2 calls an hour max).
async function retryFailed(io, now = Date.now()) {
  const user = process.env.UP_API_USERNAME, key = process.env.UP_API_KEY;
  if (!user || !key) {
    const result = { skipped: true, reason: 'UP_API_USERNAME / UP_API_KEY not set' };
    const save = async () => { const m = (await io.readMeta()) || {}; if (m.firstWebhookAt) await io.writeMeta({ ...m, webhookRetry: { at: now, ...result } }); };
    await (io.withLock ? io.withLock(save) : save()).catch(() => {});
    return result;
  }
  const end = now - 60e3, start = end - 24 * 3600e3 + 1000;
  let result;
  try {
    const r = await fetch(RETRY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `apikey ${user}:${key}`, 'x-upr-biz-id': EXPECTED_BIZ_ID },
      body: JSON.stringify({ event_type: 18, start_time: start, end_time: end })
    });
    const j = await r.json().catch(() => ({}));
    result = { httpStatus: r.status, status: j.status || null, message: j.message || null, referenceId: j.reference_id || null };
  } catch (e) { result = { error: e.message }; }
  const save = async () => { const m = (await io.readMeta()) || {}; await io.writeMeta({ ...m, webhookRetry: { at: now, ...result } }); };
  await (io.withLock ? io.withLock(save) : save());
  return result;
}

// Data Sources facts while webhooks are live (atlas-sync upFacts uses this).
function webhookFacts(m, now = Date.now()) {
  if (!m || !m.firstWebhookAt) return null;
  const h = new Date(now + 4 * 3600e3).getUTCHours();
  const open = h >= OPEN_FROM_H || h < OPEN_TO_H;
  const hhmm = ms => new Date(ms + 4 * 3600e3).toISOString().slice(11, 16);
  const rec = m.reconcile;
  const retry = m.webhookRetry;
  const notes = [`Live via UrbanPiper webhook. Last order event ${m.lastWebhookAt ? (dubaiDay(m.lastWebhookAt) === dubaiDay(now) ? 'today ' : dubaiDay(m.lastWebhookAt) + ' ') + hhmm(m.lastWebhookAt) : 'none yet'} (Dubai).`];
  if (rec) notes.push(rec.diffCount || rec.missingInWebhook.length || rec.extraInWebhook.length
    ? `Cross-check with Atlas ${rec.from} to ${rec.to}: ${rec.diffCount} figure differences, ${rec.missingInWebhook.length} orders missing from webhooks, ${rec.extraInWebhook.length} not in Atlas.`
    : `Cross-check with Atlas ${rec.from} to ${rec.to}: ${rec.compared} orders match.`);
  if (!retry) notes.push('Missed-delivery retry: not run yet.');
  else if (retry.skipped || retry.reason) notes.push('Missed-delivery retry: add UP_API_USERNAME and UP_API_KEY (Atlas → Settings → API Access) in Vercel.');
  else if (retry.error || retry.status !== 'success') notes.push(`Missed-delivery retry failed: ${retry.error || retry.message || retry.httpStatus}.`);
  const recErr = rec && (rec.diffCount || rec.missingInWebhook.length || rec.extraInWebhook.length) ? `Webhook vs Atlas: ${rec.diffCount + rec.missingInWebhook.length + rec.extraInWebhook.length} differences` : null;
  return {
    lastSync: m.lastWebhookAt || m.firstWebhookAt,
    staleAfter: open ? STALE_OPEN_MS : 24 * 3600e3,
    error: m.webhookError || recErr || null,
    note: notes.join(' ')
  };
}

// Top-level keys of a payload (and of order.details), for logs. No values.
function shape(b) {
  if (!b || typeof b !== 'object') return typeof b;
  const top = Object.keys(b).slice(0, 15).join(',');
  const det = b.order && b.order.details ? ' order.details:' + Object.keys(b.order.details).slice(0, 25).join(',') : '';
  return `{${top}}${det}`;
}

module.exports = { shape, keyOk, tryAdopt, sha, parseEvent, fold, foldOnce, rebuild, reconcile, retryFailed, webhookFacts, EXPECTED_BIZ_ID };
