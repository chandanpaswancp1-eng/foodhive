const { readMeta, dubaiDateKey } = require('./_lib/grubcenter');
const { readAllOrderItems } = require('./_lib/store');
const { lineItemsResponse } = require('./_lib/line-items-window');

// Order line items for a date range; with no range, the most recent 35 days
// (see _lib/line-items-window.js). The full history is backfilled into the
// store by scripts/backfill-order-items.js and fetched on demand by the client.
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [itemsArray, meta] = await Promise.all([readAllOrderItems(), readMeta()]);

  // No sync from here. Every page load calls /api/orders too, and it starts
  // the one background sync (orders + line items) when the data is stale. A
  // second sync from this endpoint (7 days of orders, 3 of line items) could
  // never finish within 60 s and ran at the same time as that one.

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ ...lineItemsResponse(itemsArray, from, to, dubaiDateKey), lastSync: meta.lastSync });
};
