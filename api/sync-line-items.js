const { waitUntil } = require('@vercel/functions');
const { configured, syncLineItems, readLiMeta } = require('./_lib/grubcenter');

// GrubCENTER order line items, one day per run (see syncLineItems). Its own
// endpoint, called in the background by the dashboard on load and refresh,
// so the run has the whole 60 s: reading and rewriting the ~12 MB store plus
// a 20-40 s GrubCENTER pull did not fit beside /api/order-items' response
// and timed out (15:06-15:50, 20 Nov 2026). At most every 10 minutes.
const LI_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let running = null;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) { res.status(200).json({ ok: false, skipped: 'not configured' }); return; }
  const li = await readLiMeta();
  const due = Date.now() - Math.max(li.lastSync || 0, li.lastAttempt || 0) > LI_SYNC_INTERVAL_MS;
  if (due && !running) {
    const t0 = Date.now();
    running = syncLineItems()
      .then(r => { console.log(`[line items] ${r.ok ? `${r.day}: ${r.lines} lines` : r.error || r.skipped} in ${Date.now() - t0} ms`); return r; })
      .catch(e => console.warn('[line items] sync failed:', e.message))
      .finally(() => { running = null; });
    waitUntil(running);
  }
  res.status(202).json({ ok: true, started: !!(due && running), lastSync: li.lastSync || 0, lastDay: li.lastDay || null });
};
