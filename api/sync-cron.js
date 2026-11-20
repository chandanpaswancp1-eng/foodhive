/* Vercel Cron target (see vercel.json's "crons": "0 23 * * *" = 23:00 UTC =
 * 03:00 Dubai-local, deep overnight/off-hours for this restaurant business).
 * On the Hobby plan, cron schedules are limited to once a day; the real
 * freshness guarantee comes from api/orders.js kicking off syncOnce()
 * whenever the cache is stale on a normal page load, so this is just a daily
 * baseline refresh (both GrubCENTER and Zoho) even if the dashboard sits
 * unopened for a while. */
const { syncOnce, syncLineItems, dubaiDateKey } = require('./_lib/grubcenter');
const { syncOnce: syncZohoOnce } = require('./_lib/zoho');
const { syncAtlasOnce } = require('./_lib/atlas-sync');
const upIo = require('./_lib/up-blob-io');
const { foldOnce, retryFailed } = require('./_lib/up-webhooks');

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }
  try {
    // Must finish inside 60 s, or nothing is saved. 14 days of orders plus
    // 8 days of line items timed out every night (18-20 Nov 2026). Now, all
    // side by side: 7 days of orders (late cancellations and timings),
    // yesterday's line items (closes the day), Zoho and Atlas.
    const yesterday = dubaiDateKey(Date.now() - 864e5);
    const [result, lineItems, zohoResult, atlasResult] = await Promise.all([
      syncOnce(dubaiDateKey(Date.now() - 7 * 864e5), dubaiDateKey(Date.now())),
      syncLineItems({ day: yesterday }).catch(e => ({ ok: false, error: e.message })),
      syncZohoOnce().catch(e => ({ error: e.message })),
      // Jaddaf: ask UrbanPiper to resend failed webhook deliveries, fold
      // what arrived, then the Atlas sync (only while a session is live).
      (async () => {
        const retry = await retryFailed(upIo).catch(e => ({ error: e.message }));
        const fold = await foldOnce(upIo);
        const sync = await syncAtlasOnce(upIo, { from: dubaiDateKey(Date.now() - 6 * 864e5) }).catch(e => ({ ok: false, error: e.message }));
        return { ...sync, webhookRetry: retry, fold };
      })()
    ]);
    res.status(200).json({ ...result, lineItems, zoho: zohoResult, atlas: atlasResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
