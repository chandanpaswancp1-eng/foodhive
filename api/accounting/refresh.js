const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce } = require('../_lib/zoho');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, message: 'Zoho Books credentials not configured on this deployment' });
    return;
  }
  waitUntil(syncOnce().catch(() => {}));
  res.status(200).json({ ok: true, configured: true, message: 'Zoho sync started' });
};
