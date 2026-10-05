const { waitUntil } = require('@vercel/functions');
const { syncOnce } = require('./_lib/grubcenter');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  waitUntil(syncOnce(url.searchParams.get('from'), url.searchParams.get('to')).catch(() => {}));
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ ok: true, message: 'Sync started' });
};
