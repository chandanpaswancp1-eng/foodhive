const { configured, readMeta, readItemsMeta } = require('./_lib/grubcenter');
const { readUpMeta, readUpOrders, readUpConn, readZoho, readBrandRatings } = require('./_lib/store');
const { upFacts } = require('./_lib/atlas-sync');
const FHRatings = require('../public/ratings.js');
const { describeSources, summarize } = require('../public/sources.js');

// Health of every data source behind the dashboard, for the Data Sources
// page and the sidebar status pill. Reads small metadata files only.
function ratingsFacts(doc) {
  if (doc && doc.__error) return { configured: true, error: doc.__error };
  return { configured: true, lastSync: FHRatings.lastCapture(doc), records: doc ? FHRatings.cellCount(doc) : null, note: doc ? null : 'No ratings imported yet' };
}

module.exports = async (req, res) => {
  const safe = p => p.catch(e => ({ __error: e.message }));
  const [meta, itemsMeta, upMeta, upOrders, upConn, zoho, ratings] = await Promise.all([
    safe(readMeta()), safe(readItemsMeta()), safe(readUpMeta()), safe(readUpOrders()), safe(readUpConn()), safe(readZoho()), safe(readBrandRatings())
  ]);
  const zohoConfigured = !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_ORG_ID);
  const facts = {
    grubcenter: { configured: configured(), lastSync: meta.lastSync, error: meta.__error },
    items86: { configured: configured(), lastSync: itemsMeta.lastSync, records: itemsMeta.events, error: itemsMeta.__error },
    ...upFacts(upMeta, Array.isArray(upOrders) ? upOrders.length : null, upConn && !upConn.__error ? upConn : null),
    aggRatings: ratingsFacts(ratings),
    zoho: { configured: zohoConfigured, lastSync: zoho && zoho.lastSync, error: zoho && zoho.__error }
  };
  const sources = describeSources(facts);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ checkedAt: Date.now(), summary: summarize(sources), sources });
};
