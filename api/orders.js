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
  // syncs. Settled older orders rarely change -- the daily cron
  // (api/sync-cron.js) and the explicit "Sync Now" button still cover full
  // historical refreshes.
  if (configured() && Date.now() - meta.lastSync > SYNC_INTERVAL_MS) {
    const bgFrom = from || dubaiDateKey(Date.now() - 3 * 864e5);
    const bgTo = to || dubaiDateKey(Date.now());
    waitUntil(syncOnce(bgFrom, bgTo).catch(() => {}));
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
