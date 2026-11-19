const { connect } = require('./_lib/atlas-sync');
const blobIo = require('./_lib/up-blob-io');

// Receives the Atlas session from the dashboard page after the Atlas
// bookmarklet's "Connect dashboard" (postMessage, never a URL). The token is
// checked against FoodHive's Atlas business and stored privately; the
// response never echoes it. See api/_lib/atlas-sync.js.
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  let body;
  try { body = await readJsonBody(req); } catch (_) {
    res.status(400).json({ ok: false, error: 'Body is not valid JSON' });
    return;
  }
  try {
    const r = await connect(body && body.token, blobIo);
    res.status(r.status).json(r.json);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
