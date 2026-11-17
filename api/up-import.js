const blobIo = require('./_lib/up-blob-io');
const FHAtlas = require('../public/atlas.js');

// Saves a capture from the Atlas bookmarklet (public/atlas-capture.js) for
// the Jaddaf kitchen. Atlas has no read API and no webhook is registered, so
// this is how UrbanPiper orders and the catalogue reach the dashboard.
//   kind 'orders'  -> up_orders.json, up_order_items.json (upsert by id)
//   kind 'catalog' -> up_catalog.json, plus 86 events in up_items.json
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Storage-agnostic so server.js (data/ files) can reuse it with its own io.
async function importCapture(body, io) {
  const err = FHAtlas.validate(body);
  if (err) return { status: 400, json: { ok: false, error: err } };
  const meta = (await io.readMeta()) || {};
  const now = Date.now();
  if (body.kind === 'orders') {
    const [orders, lines] = await Promise.all([io.readOrders(), io.readOrderItems()]);
    const r = FHAtlas.mergeOrders(orders, lines, body);
    await Promise.all([io.writeOrders(r.orders), io.writeOrderItems(r.lines)]);
    const m = { ...meta, lastCaptureAt: now, capturedRange: [body.from || null, body.to || null], orderCount: r.orders.length };
    await io.writeMeta(m);
    return { status: 200, json: { ok: true, kind: 'orders', added: r.added, updated: r.updated, skippedTests: r.tests, total: r.orders.length } };
  }
  const items = FHAtlas.normalizeCatalog(body);
  const capturedAt = body.capturedAt || now;
  const events = FHAtlas.catalogEvents(await io.readItems(), items, capturedAt);
  await Promise.all([io.writeCatalog({ capturedAt, receivedAt: now, items }), io.writeItems(events)]);
  await io.writeMeta({ ...meta, catalogAt: capturedAt, catalogItems: items.length });
  return { status: 200, json: { ok: true, kind: 'catalog', items: items.length, disabled: items.filter(i => !i.enabled).length } };
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
    const r = await importCapture(body, blobIo);
    res.status(r.status).json(r.json);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
module.exports.importCapture = importCapture;
