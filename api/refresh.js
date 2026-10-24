const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, dubaiDateKey } = require('./_lib/grubcenter');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, message: 'GrubCENTER credentials not configured on this deployment' });
    return;
  }
  const url = new URL(req.url, 'http://x');
  const full = url.searchParams.get('full') === '1';
  // `full=1` forces a complete 45-day re-sync regardless of cached data.
  if (full) {
    waitUntil(syncOnce(dubaiDateKey(Date.now() - 45 * 864e5), dubaiDateKey(Date.now())).catch(() => {}));
    res.status(200).json({ ok: true, configured: true, message: 'Full 45-day re-sync started' });
    return;
  }
  waitUntil(syncOnce(url.searchParams.get('from'), url.searchParams.get('to')).catch(() => {}));
  res.status(200).json({ ok: true, configured: true, message: 'Sync started' });
};
