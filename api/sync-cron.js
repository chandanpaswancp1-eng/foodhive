/* Vercel Cron target (see vercel.json's "crons"). On the Hobby plan, cron
 * schedules are limited to once a day; the real freshness guarantee comes
 * from api/orders.js kicking off syncOnce() whenever the cache is stale on
 * a normal page load, so this is just a daily baseline refresh even if the
 * dashboard sits unopened for a while. */
const { syncOnce } = require('./_lib/grubcenter');
const { syncOnce: syncZohoOnce } = require('./_lib/zoho');

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  try {
    const result = await syncOnce();
    const zohoResult = await syncZohoOnce().catch(e => ({ error: e.message }));
    res.status(200).json({ ...result, zoho: zohoResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
