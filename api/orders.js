const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, readOrders, readMeta } = require('./_lib/grubcenter');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [ordersArray, meta] = await Promise.all([readOrders(), readMeta()]);
  let filtered = ordersArray;
  if (from || to) {
    filtered = ordersArray.filter(o => {
      if (!o.receivedAt) return false;
      const d = new Date(o.receivedAt).toISOString().slice(0, 10);
      return (!from || d >= from) && (!to || d <= to);
    });
  }

  // Cache is stale: kick off a sync in the background without delaying this response.
  if (configured() && Date.now() - meta.lastSync > SYNC_INTERVAL_MS) {
    waitUntil(syncOnce(from, to).catch(() => {}));
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
