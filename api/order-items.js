const { waitUntil } = require('@vercel/functions');
const { readMeta, dubaiDateKey, configured, syncLineItems, readLiMeta } = require('./_lib/grubcenter');
const { readAllOrderItems } = require('./_lib/store');
const { lineItemsResponse } = require('./_lib/line-items-window');

// Order line items for a date range; with no range, the most recent 35 days
// (see _lib/line-items-window.js). The full history is backfilled into the
// store by scripts/backfill-order-items.js and fetched on demand by the client.
const LI_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let running = null;

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');

  const [itemsArray, meta, li] = await Promise.all([readAllOrderItems(), readMeta(), readLiMeta()]);

  // GrubCENTER line items sync here, one day per run, in this function's own
  // invocation (like the 86 items in api/availability.js), so a slow item
  // pull never costs the orders sync its 60 s. Every 10 minutes at most;
  // yesterday first until it has been pulled whole after midnight.
  if (configured() && !running && Date.now() - Math.max(li.lastSync || 0, li.lastAttempt || 0) > LI_SYNC_INTERVAL_MS) {
    running = syncLineItems().catch(e => console.warn('[line items] sync failed:', e.message)).finally(() => { running = null; });
    waitUntil(running);
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ ...lineItemsResponse(itemsArray, from, to, dubaiDateKey), lastSync: meta.lastSync });
};
