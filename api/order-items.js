const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, readOrderItems, readMeta, dubaiDateKey } = require('./_lib/grubcenter');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [itemsArray, meta] = await Promise.all([readOrderItems(), readMeta()]);
  let filtered = itemsArray;
  if (from || to) {
    filtered = itemsArray.filter(x => {
      if (!x.at) return false;
      const d = dubaiDateKey(x.at);
      return (!from || d >= from) && (!to || d <= to);
    });
  }

  // Cache is stale: kick off a sync in the background without delaying this response.
  // (syncOnce() refreshes orders + order-items together; /api/orders already
  // triggers the same background sync on its own staleness check, so this is
  // a harmless redundant trigger if both endpoints are hit around the same time.)
  // Same 7-day orders / 3-day order-items window as api/orders.js -- sized to
  // finish within the function's maxDuration after the pagination fix.
  if (configured() && Date.now() - meta.lastSync > SYNC_INTERVAL_MS) {
    const bgFrom = from || dubaiDateKey(Date.now() - 7 * 864e5);
    const bgItemsFrom = from || dubaiDateKey(Date.now() - 3 * 864e5);
    const bgTo = to || dubaiDateKey(Date.now());
    waitUntil(syncOnce(bgFrom, bgTo, bgItemsFrom).catch(() => {}));
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    count: filtered.length,
    totalInStore: itemsArray.length,
    items: filtered,
    lastSync: meta.lastSync
  });
};
