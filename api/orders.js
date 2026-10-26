const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, readOrders, readMeta, dubaiDateKey } = require('./_lib/grubcenter');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [ordersArray, meta] = await Promise.all([readOrders(), readMeta()]);
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
  // Order-items uses the same narrow window: it has far more rows per day
  // than orders and was the main reason a wider pull timed out.
  const stale = configured() && Date.now() - (meta.lastSync || 0) > SYNC_INTERVAL_MS;
  if (stale) {
    const bgTo = to || dubaiDateKey(Date.now());
    const earliest = dubaiDateKey(Date.now() - 2 * 864e5);
    // Honour a short explicit range (a specific day the client opened), but
    // never fan out to a wide selection.
    const bgFrom = from && from >= earliest && from <= bgTo ? from : dubaiDateKey(Date.now() - 864e5);
    waitUntil(syncOnce(bgFrom, bgTo, bgFrom).catch(() => {}));
  }

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
