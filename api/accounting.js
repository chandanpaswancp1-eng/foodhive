const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, readZoho } = require('./_lib/zoho');

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  const zoho = await readZoho();

  if (configured() && Date.now() - ((zoho && zoho.lastSync) || 0) > SYNC_INTERVAL_MS) {
    waitUntil(syncOnce().catch(() => {}));
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json(zoho || { configured: configured(), lastSync: 0 });
};
