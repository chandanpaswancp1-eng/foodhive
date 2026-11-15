const { configured, readMeta, readItemsMeta } = require('./_lib/grubcenter');
const { readUpMeta, readUpOrders, readZoho } = require('./_lib/store');
const { describeSources, summarize } = require('../public/sources.js');

// Health of every data source behind the dashboard, for the Data Sources
// page and the sidebar status pill. Reads small metadata files only.
module.exports = async (req, res) => {
  const safe = p => p.catch(e => ({ __error: e.message }));
  const [meta, itemsMeta, upMeta, upOrders, zoho] = await Promise.all([
    safe(readMeta()), safe(readItemsMeta()), safe(readUpMeta()), safe(readUpOrders()), safe(readZoho())
  ]);
  const zohoConfigured = !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_ORG_ID);
  const facts = {
    grubcenter: { configured: configured(), lastSync: meta.lastSync, error: meta.__error },
    items86: { configured: configured(), lastSync: itemsMeta.lastSync, records: itemsMeta.events, error: itemsMeta.__error },
    upOrders: {
      configured: !!process.env.URBANPIPER_WEBHOOK_SECRET,
      lastSync: upMeta.lastWebhookAt,
      records: Array.isArray(upOrders) ? upOrders.length : null,
      error: upMeta.__error,
      note: upMeta.lastWebhookAt ? null : 'No webhook received yet (Jaddaf not live)'
    },
    upCatalog: { configured: true, lastSync: upMeta.catalogAt, records: upMeta.catalogItems || null, note: upMeta.catalogAt ? null : 'No Atlas snapshot yet' },
    zoho: { configured: zohoConfigured, lastSync: zoho && zoho.lastSync, error: zoho && zoho.__error }
  };
  const sources = describeSources(facts);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ checkedAt: Date.now(), summary: summarize(sources), sources });
};
