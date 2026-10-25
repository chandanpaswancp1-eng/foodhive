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
  // background refresh to a narrow recent window rather than syncOnce()'s
  // own 45-day default: a full resync takes minutes, so on-demand triggers
  // firing that same slow full resync on every stale page load left
  // "today"'s totals visibly lagging GrubCENTER's live numbers between
  // syncs (and routinely blew past this function's execution limit, which
  // meant the sync never completed at all). Settled older orders rarely
  // change -- the daily cron (api/sync-cron.js) and the explicit "Sync Now"
  // button still cover wider historical refreshes.
  //
  // Orders/ops/cancellations get a 7-day window; order-items gets 3. Both
  // are sized to finish comfortably inside the function's maxDuration even
  // after the pagination fix (which now issues ~2 requests per day instead
  // of 1, because GrubCENTER under-reports page sizes). When the client
  // passed an explicit from, honor that exact range for both, unchanged.
  if (configured() && Date.now() - meta.lastSync > SYNC_INTERVAL_MS) {
    const bgFrom = from || dubaiDateKey(Date.now() - 7 * 864e5);
    const bgItemsFrom = from || dubaiDateKey(Date.now() - 3 * 864e5);
    const bgTo = to || dubaiDateKey(Date.now());
    waitUntil(syncOnce(bgFrom, bgTo, bgItemsFrom).catch(() => {}));
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    count: filtered.length,
    totalInStore: ordersArray.length,
    orders: filtered,
    opsCount: meta.liveOpsCount || 0,
    cancelCount: meta.liveCancelCount || 0,
    lastSync: meta.lastSync
  });
};
