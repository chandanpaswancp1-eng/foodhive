const { readBrandRatings, writeBrandRatings } = require('./_lib/store');
const FHRatings = require('../public/ratings.js');

// Aggregator store ratings per brand. GET returns the saved document; POST
// saves one channel's capture (from the portal bookmarklet or manual entry),
// replacing that channel's previous rows. See public/ratings.js.
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    if (req.method === 'GET') {
      res.status(200).json((await readBrandRatings()) || FHRatings.empty());
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }
    let body;
    try { body = await readJsonBody(req); } catch (_) {
      res.status(400).json({ ok: false, error: 'Body is not valid JSON' });
      return;
    }
    const err = FHRatings.validate(body);
    if (err) { res.status(400).json({ ok: false, error: err }); return; }
    const doc = FHRatings.merge(await readBrandRatings(), body);
    await writeBrandRatings(doc);
    res.status(200).json({ ok: true, doc });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
