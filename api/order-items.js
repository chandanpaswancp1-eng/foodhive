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

  // Serves only. Line items sync in api/sync-line-items.js, which the
  // dashboard calls in the background, so the sync gets its own 60 s.

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ ...lineItemsResponse(itemsArray, from, to, dubaiDateKey), lastSync: meta.lastSync });
};
