const { waitUntil } = require('@vercel/functions');
const upIo = require('./_lib/up-blob-io');
const W = require('./_lib/up-webhooks');
const { fetchOrderDetail } = require('./_lib/atlas-sync');

// UrbanPiper webhooks for Jaddaf (Atlas -> Settings -> Webhooks): Order Relay
// and Order Status Update. Atlas sends the header X-FH-Webhook-Key, which
// must equal UP_WEBHOOK_SECRET. The delivery is saved as its own event
// before we answer 200 (a non-2xx makes UrbanPiper retry), then folded into
// the Jaddaf orders in the background. Customer details are never stored.
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Shared with server.js (which passes its own io and runs the fold itself).
async function handleWebhook(headers, body, io) {
  if (!process.env.UP_WEBHOOK_SECRET) return { status: 503, json: { ok: false, error: 'Webhook not configured on this deployment' } };
  const adopted = io.readWhKey ? await io.readWhKey().catch(() => null) : null;
  if (!W.keyOk(headers['x-fh-webhook-key'], adopted)) {
    // Why a delivery was refused, without logging the key or the payload.
    const given = headers['x-fh-webhook-key'];
    const names = Object.keys(headers).filter(h => /key|auth|token|secret|fh/i.test(h));
    console.warn(`[up-webhook] 401 key: ${given == null ? 'header missing' : `given ${String(given).length} chars, expected ${String(process.env.UP_WEBHOOK_SECRET).length}`}; key-like headers: ${names.join(', ') || 'none'}; shape: ${W.shape(body)}`);
    // Still 401 (UrbanPiper retries), but check the key against Atlas.
    return { status: 401, json: { ok: false, error: 'Unauthorized' }, adopt: given ? { given, body } : null };
  }
  const p = W.parseEvent(body);
  if (p.ignore) { console.warn(`[up-webhook] ignored payload, shape: ${W.shape(body)}`); return { status: 200, json: { ok: true, ignored: true } }; }
  if (p.error) { console.warn(`[up-webhook] ${p.forbidden ? 401 : 400}: ${p.error}`); return { status: p.forbidden ? 401 : 400, json: { ok: false, error: p.error } }; }
  await io.putEvent(p.name, p.event);
  if (io.writeWhPending) await io.writeWhPending({ at: Date.now() }).catch(() => {});
  return { status: 200, json: { ok: true, kind: p.event.kind, order: p.event.orderId }, fold: true };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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
    const r = await handleWebhook(req.headers, body, upIo);
    if (r.fold) waitUntil(W.foldOnce(upIo));
    if (r.adopt) waitUntil(W.tryAdopt(upIo, r.adopt.given, r.adopt.body, id => fetchOrderDetail(upIo, id)).catch(() => {}));
    res.status(r.status).json(r.json);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not save the event' });
  }
};
module.exports.handleWebhook = handleWebhook;
