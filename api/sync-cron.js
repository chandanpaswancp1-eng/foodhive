/* Vercel Cron target (see vercel.json's "crons": "0 23 * * *" = 23:00 UTC =
 * 03:00 Dubai-local, deep overnight/off-hours for this restaurant business).
 * On the Hobby plan, cron schedules are limited to once a day; the real
 * freshness guarantee comes from api/orders.js kicking off syncOnce()
 * whenever the cache is stale on a normal page load, so this is just a daily
 * baseline refresh (both GrubCENTER and Zoho) even if the dashboard sits
 * unopened for a while. */
const { syncOnce, dubaiDateKey } = require('./_lib/grubcenter');
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
    // Explicit recent window rather than syncOnce()'s 45-day default: on
    // Vercel the 45-day pull can exceed the function's maxDuration (and a
    // killed function persists nothing), while a 14-day window completes
    // reliably and is more than enough to pick up late cancellations/ops
    // updates. Older history is already in the Blob store (seeded once via
    // scripts/seed-blob.js) and can be refreshed with /api/refresh?full=1.
    const result = await syncOnce(dubaiDateKey(Date.now() - 14 * 864e5), dubaiDateKey(Date.now()), dubaiDateKey(Date.now() - 7 * 864e5));
    const zohoResult = await syncZohoOnce().catch(e => ({ error: e.message }));
    res.status(200).json({ ...result, zoho: zohoResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
