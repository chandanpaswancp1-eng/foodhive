const { readMeta, dubaiDateKey } = require('./_lib/grubcenter');
const { readAllOrderItems } = require('./_lib/store');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [itemsArray, meta] = await Promise.all([readAllOrderItems(), readMeta()]);
  let filtered = itemsArray;
  if (from || to) {
    filtered = itemsArray.filter(x => {
      if (!x.at) return false;
      const d = dubaiDateKey(x.at);
      return (!from || d >= from) && (!to || d <= to);
    });
  }

  // No sync from here. Every page load calls /api/orders too, and it starts
  // the one background sync (orders + line items) when the data is stale. A
  // second sync from this endpoint (7 days of orders, 3 of line items) could
  // never finish within 60 s and ran at the same time as that one.

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({
    count: filtered.length,
    totalInStore: itemsArray.length,
    items: filtered,
    lastSync: meta.lastSync
  });
};
