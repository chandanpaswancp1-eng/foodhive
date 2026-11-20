const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, readMeta, dubaiDateKey } = require('./_lib/grubcenter');
const { readAllOrders, readUpMeta, readUpConn } = require('./_lib/store');
const { syncAtlasOnce, connectionState } = require('./_lib/atlas-sync');
const upIo = require('./_lib/up-blob-io');
const { foldOnce } = require('./_lib/up-webhooks');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  // GrubCENTER (Motor City) + UrbanPiper (Jaddaf) orders, each tagged with `source`.
  const [ordersArray, meta, upMeta, upConn, whPending] = await Promise.all([readAllOrders(), readMeta(), readUpMeta().catch(() => ({})), readUpConn().catch(() => null), upIo.readWhPending().catch(() => ({ at: 0 }))]);
  let filtered = ordersArray;
  if (from || to) {
    filtered = ordersArray.filter(o => {
      if (!o.receivedAt) return false;
      const d = dubaiDateKey(o.receivedAt);
      return (!from || d >= from) && (!to || d <= to);
    });
  }

  // Cache is stale: kick off a sync in the background without delaying this
  // response. When the client didn't ask for a specific range (the common
  // case -- the initial page load fetches with no from/to), default this
  // background refresh to today + yesterday. A 45-day resync takes minutes
  // and a 7-day one still ran ~3+ minutes locally, so the old wider defaults
  // routinely blew past this function's execution limit and the sync never
  // completed at all. Settled older orders rarely change -- the daily cron
  // (api/sync-cron.js) and the explicit "Sync Now" button cover the rest.
  //
  // Order line items are not synced here: they run in api/order-items.js,
  // in their own invocation, so a slow item pull can never stop new orders
  // being saved (it did on 20 Nov 2026: syncs timed out at 60 s).
  const stale = configured() && Date.now() - (meta.lastSync || 0) > SYNC_INTERVAL_MS;
  if (stale) {
    const bgTo = to || dubaiDateKey(Date.now());
    const earliest = dubaiDateKey(Date.now() - 2 * 864e5);
    // Honour a short explicit range (a specific day the client opened), but
    // never fan out to a wide selection.
    const bgFrom = from && from >= earliest && from <= bgTo ? from : dubaiDateKey(Date.now() - 864e5);
    // Orders only; line items sync in api/order-items.js (own invocation).
    waitUntil(syncOnce(bgFrom, bgTo).catch(() => {}));
  }
  // Jaddaf (Atlas) on the same 10-minute rhythm while a connection is live.
  // Orders only; the catalogue is refreshed by Sync Now and the cron.
  const upStale = connectionState(upConn).connected && Date.now() - ((upMeta && upMeta.lastCaptureAt) || 0) > SYNC_INTERVAL_MS;
  // Webhook deliveries are folded as they arrive (api/up-webhook.js); this
  // catches any fold that did not run. Then the Atlas sync, if due.
  const whDue = whPending && whPending.at > ((upMeta && upMeta.lastFoldAt) || 0);
  if (whDue || upStale) waitUntil((async () => {
    if (whDue) await foldOnce(upIo);
    if (upStale) await syncAtlasOnce(upIo, { catalog: false }).catch(() => {});
  })());

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    count: filtered.length,
    totalInStore: ordersArray.length,
    orders: filtered,
    opsCount: meta.liveOpsCount || 0,
    cancelCount: meta.liveCancelCount || 0,
    lastSync: meta.lastSync,
    // The response still carries the pre-sync cache; the client uses this
    // flag to poll /api/status and re-fetch automatically once the
    // background sync finishes, instead of requiring a second manual reload.
    stale
  });
};
