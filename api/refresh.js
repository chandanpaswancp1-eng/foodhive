const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce } = require('./_lib/grubcenter');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, message: 'GrubCENTER credentials not configured on this deployment' });
    return;
  }
  const url = new URL(req.url, 'http://x');
  waitUntil(syncOnce(url.searchParams.get('from'), url.searchParams.get('to')).catch(() => {}));
  res.status(200).json({ ok: true, configured: true, message: 'Sync started' });
};
