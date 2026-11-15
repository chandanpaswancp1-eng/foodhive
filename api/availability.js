const { waitUntil } = require('@vercel/functions');
const { configured, readItems, syncItems, readItemsMeta } = require('./_lib/grubcenter');

const ITEMS_SYNC_INTERVAL_MS = 10 * 60 * 1000;
// Only one refresh per warm instance at a time.
let running = null;

// Serves the stored 86 log. When it is more than 10 minutes old, refreshes
// it in the background from GrubCENTER's item-availability snapshot. This
// runs in this function's own invocation, not inside syncOnce, so the
// orders sync keeps its full 60 s (see syncItems in _lib/grubcenter.js).
module.exports = async (req, res) => {
  const [items, meta] = await Promise.all([readItems(), readItemsMeta()]);
  if (configured() && !running && Date.now() - (meta.lastSync || 0) > ITEMS_SYNC_INTERVAL_MS) {
    running = syncItems().catch(e => console.warn('[items] sync failed:', e.message)).finally(() => { running = null; });
    waitUntil(running);
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ items, lastSync: meta.lastSync || 0 });
};
