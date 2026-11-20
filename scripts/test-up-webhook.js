/* Checks for the UrbanPiper webhook path and the Atlas accounting rules.
   Run: node scripts/test-up-webhook.js   (no network, no real storage) */
process.env.UP_WEBHOOK_SECRET = 'test-secret-123';
process.env.ATLAS_BIZ_ID = '37055789';
const assert = require('assert');
const A = require('../public/atlas.js');
const W = require('../api/_lib/up-webhooks');
const { handleWebhook } = require('../api/up-webhook.js');

function memIo() {
  const st = { orders: [], lines: [], meta: {}, wh: {}, events: new Map(), pending: { at: 0 } };
  let chain = Promise.resolve();
  return {
    st,
    readMeta: async () => st.meta, writeMeta: async m => { st.meta = m; },
    readOrders: async () => st.orders, writeOrders: async v => { st.orders = v; },
    readOrderItems: async () => st.lines, writeOrderItems: async v => { st.lines = v; },
    readWh: async () => st.wh, writeWh: async v => { st.wh = v; },
    putEvent: async (n, o) => { st.events.set(n, { o: JSON.parse(JSON.stringify(o)), at: Date.now() }); },
    listEvents: async () => [...st.events].map(([name, v]) => ({ name, uploadedAt: v.at })),
    readEvent: async n => (st.events.get(n) || {}).o || null,
    delEvents: async ns => ns.forEach(n => st.events.delete(n)),
    writeWhPending: async v => { st.pending = v; },
    withLock: fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; }
  };
}
const H = { 'x-fh-webhook-key': 'test-secret-123' };
const ms = s => A.atlasTime(s);
const relay = (id, over = {}) => ({
  customer: { name: 'Ahmed Customer', phone: '+971500000000', email: 'a@b.c', address: { line_1: 'Villa 1' } },
  order: {
    details: { id, biz_id: 37055789, channel: 'talabat', created: ms('2026-11-20 13:05:00'), order_state: 'Placed', order_type: 'delivery',
      brand: { id: 1, name: 'Simply Burgers' }, order_subtotal: 66.5, discount: 30, total_external_discount: 0, total_charges: 0, total_taxes: 0, payable_amount: 36.5, ...over.details },
    items: over.items || [{ id: 9, title: 'Ultimate Burger Combo', price: 70, quantity: 1, total: 70, discount: 0, options_to_add: [] }],
    payment: [{ option: 'prepaid', amount: 36.5 }],
    store: { id: 5, name: 'FoodHive Jaddaf' }
  }
});
const status = (id, state, at, msg) => ({ order_id: id, new_state: state, prev_state: 'Placed', timestamp_unix: ms(at), message: msg || '', biz_id: 37055789, store_id: 'S1', updater: { name: 'Staff Name', username: 'staff' } });

(async () => {
  let n = 0; const ok = m => { n++; console.log('  ok', m); };

  // 1. Accounting rules
  const base = { id: 1, created: '2026-11-19 20:00:00', channel: 'TALABAT', status: 'COMPLETED', subtotal: 66.5, discount: 30, totalCharges: 0, totalTaxes: 0, payableAmount: 36.5, statusUpdates: [], items: [{ title: 'X', price: 70, quantity: 1, total: 70 }] };
  let o = A.normalizeOrder(base);
  assert.deepStrictEqual([o.receiptTotal, o.discount, o.netSales, o.charges], [70, 33.5, 34.76, 0]); ok('hidden discount: gross 70, discount 33.5, net 34.76 (net unchanged)');
  o = A.normalizeOrder({ ...base, subtotal: 78, discount: 0, totalCharges: 11.4, items: [{ title: 'Y', price: 78, quantity: 1, total: 78 }] });
  assert.deepStrictEqual([o.receiptTotal, o.discount, o.netSales, o.charges], [89.4, 0, 85.14, 11.4]); ok('charges stay in gross/net and are kept on their own');
  o = A.normalizeOrder({ ...base, subtotal: 100, discount: 0, items: [{ title: 'Z', price: 100, quantity: 1, total: 100 }] });
  assert.strictEqual(o.discount, 0); ok('no hidden discount when items equal subtotal');
  assert.strictEqual(A.normalizeOrder({ ...base, created: '2026-11-06 12:00:00' }), null); ok('orders before go-live are tests');
  const pre = A.normalizeOrder({ ...base, id: 2 }); const old = { ...pre, id: 'up_old', receivedAt: ms('2026-10-29 12:00:00') };
  const mm = A.mergeOrders([old, pre], [{ orderId: 'up_old', item: 'a' }, { orderId: pre.id, item: 'b' }], { orders: [] });
  assert.deepStrictEqual([mm.orders.map(x => x.id), mm.lines.map(l => l.orderId), mm.purgedPreLive], [[pre.id], [pre.id], 1]); ok('stored pre-go-live orders and lines are removed');

  // 2. Security
  const io = memIo();
  assert.strictEqual((await handleWebhook({}, relay(500), io)).status, 401); ok('missing key: 401');
  assert.strictEqual((await handleWebhook({ 'x-fh-webhook-key': 'test-secret-12X' }, relay(500), io)).status, 401); ok('wrong key: 401');
  assert.strictEqual((await handleWebhook(H, relay(500, { details: { biz_id: 111 } }), io)).status, 401); ok('other business: 401');
  assert.strictEqual(io.st.events.size, 0); ok('nothing stored on rejected deliveries');
  delete process.env.UP_WEBHOOK_SECRET;
  assert.strictEqual((await handleWebhook(H, relay(500), io)).status, 503); ok('no secret configured: 503');
  process.env.UP_WEBHOOK_SECRET = 'test-secret-123';

  // 3. Relay, privacy, duplicates
  let r = await handleWebhook(H, relay(1001), io);
  assert.strictEqual(r.status, 200);
  await handleWebhook(H, relay(1001), io);
  assert.strictEqual(io.st.events.size, 1); ok('same delivery twice is one event');
  const stored = JSON.stringify([...io.st.events.values()]);
  assert(!/Ahmed|\+9715|a@b\.c|Villa|Staff Name/.test(stored)); ok('no customer or staff details stored');
  await W.fold(io);
  assert.strictEqual(io.st.orders.length, 1);
  o = io.st.orders[0];
  assert.deepStrictEqual([o.id, o.channel, o.brand, o.status, o.receiptTotal, o.discount, o.netSales, o.via, o.location], ['up_1001', 'Talabat', 'Simply Burgers', 'PLACED', 70, 33.5, 34.76, 'webhook', 'Jaddaf']); ok('relay becomes a Jaddaf order with the right figures');
  assert.strictEqual(io.st.lines.length, 1); ok('item line stored');
  assert.strictEqual(io.st.events.size, 0); ok('events deleted after fold');
  assert(!/Ahmed|\+9715|Villa/.test(JSON.stringify([io.st.orders, io.st.lines, io.st.wh]))); ok('no customer details in orders, lines or webhook copies');

  // 4. Status updates (out of order, together, repeated)
  await handleWebhook(H, status(1001, 'Food Ready', '2026-11-20 13:20:00'), io);
  await handleWebhook(H, status(1001, 'Acknowledged', '2026-11-20 13:06:00'), io);
  await handleWebhook(H, status(1001, 'Dispatched', '2026-11-20 13:30:00'), io);
  await handleWebhook(H, status(1001, 'Completed', '2026-11-20 13:55:00'), io);
  await W.fold(io); await W.fold(io);
  o = io.st.orders[0];
  assert.deepStrictEqual([o.status, o.acceptedAt, o.preparedAt, o.dispatchedAt, o.deliveredAt], ['COMPLETED', ms('2026-11-20 13:06:00'), ms('2026-11-20 13:20:00'), ms('2026-11-20 13:30:00'), ms('2026-11-20 13:55:00')]); ok('statuses applied in time order; timings set');
  await handleWebhook(H, relay(1001), io); await W.fold(io);
  assert.strictEqual(io.st.orders[0].status, 'COMPLETED'); ok('a re-sent relay does not reset the status');

  // 5. Cancellation
  await handleWebhook(H, relay(1002), io);
  await handleWebhook(H, status(1002, 'Acknowledged', '2026-11-20 13:07:00'), io);
  await handleWebhook(H, status(1002, 'Cancelled', '2026-11-20 13:15:00', 'Restaurant too busy'), io);
  await W.fold(io);
  o = io.st.orders.find(x => x.id === 'up_1002');
  assert.deepStrictEqual([o.cancelled, o.postCancelled, o.reason], [true, true, 'Restaurant too busy']); ok('cancellation with reason, after accept');

  // 6. Status for an order from an Atlas sync (before webhooks): patch only
  const atlasOrder = A.normalizeOrder({ ...base, id: 900, created: '2026-11-20 11:00:00', status: 'ACKNOWLEDGED', statusUpdates: [{ status: 'ACKNOWLEDGED', created: '2026-11-20 11:01:00' }] });
  io.st.orders.push(atlasOrder);
  await handleWebhook(H, status(900, 'Completed', '2026-11-20 11:40:00'), io);
  await W.fold(io);
  o = io.st.orders.find(x => x.id === 'up_900');
  assert.deepStrictEqual([o.status, o.deliveredAt, o.via, o.receiptTotal], ['COMPLETED', ms('2026-11-20 11:40:00'), 'atlas', 70]); ok('Atlas order keeps its figures, status moves forward');

  // 7. Status before its relay is kept for the next fold
  await handleWebhook(H, status(1003, 'Acknowledged', '2026-11-20 14:01:00'), io);
  await W.fold(io);
  assert.strictEqual(io.st.events.size, 1); ok('status without its order waits for the relay');
  await handleWebhook(H, relay(1003, { details: { created: ms('2026-11-20 14:00:00') } }), io);
  await W.fold(io);
  o = io.st.orders.find(x => x.id === 'up_1003');
  assert.deepStrictEqual([o.acceptedAt, io.st.events.size], [ms('2026-11-20 14:01:00'), 0]); ok('then both are applied');

  // 8. Concurrent folds lose nothing
  const io2 = memIo();
  for (let i = 0; i < 20; i++) await handleWebhook(H, relay(2000 + i), io2);
  await Promise.all([W.fold(io2), W.fold(io2), W.fold(io2)]);
  assert.strictEqual(io2.st.orders.length, 20); ok('20 orders folded by 3 overlapping folds: 20 stored');

  // 9. Test orders from webhooks
  const t = relay(3000); t.customer.name = 'Test Order';
  await handleWebhook(H, t, io2); await W.fold(io2);
  assert(!io2.st.orders.some(x => x.id === 'up_3000')); ok('test customer order skipped');

  // 10. Options outside item totals
  const opt = relay(4000, { details: { order_subtotal: 55, discount: 0, payable_amount: 55 }, items: [{ id: 1, title: 'Pizza', price: 45, quantity: 1, total: 45, options_to_add: [{ title: 'Extra cheese', price: 10, quantity: 1, total_price: 10 }] }] });
  await handleWebhook(H, opt, io2); await W.fold(io2);
  o = io2.st.orders.find(x => x.id === 'up_4000');
  const ln = io2.st.lines.find(l => l.orderId === 'up_4000');
  assert.deepStrictEqual([o.receiptTotal, o.discount, ln.lineTotal], [55, 0, 55]); ok('option prices added when that matches the subtotal');

  // 11. Cross-check
  const wo = io.st.orders.find(x => x.id === 'up_1001');
  let rc = W.reconcile([wo], io.st.wh, 1, '2026-11-20', '2026-11-20');
  assert.strictEqual(rc.diffCount, 0); ok('cross-check: identical records match');
  rc = W.reconcile([{ ...wo, discount: 30 }], io.st.wh, 1, '2026-11-20', '2026-11-20');
  assert.deepStrictEqual([rc.diffCount, rc.diffs[0].field], [1, 'discount']); ok('cross-check: a 3.50 discount difference is reported');

  rc = W.reconcile([{ ...wo, id: 'up_9999', receivedAt: Date.now() }], {}, null, '2026-11-20', '2026-11-20');
  assert.strictEqual(rc.missingInWebhook.length, 0); ok('cross-check: no order expected by webhook before the first Order placed delivery');
  rc = W.reconcile([{ ...wo, id: 'up_9999', receivedAt: Date.now() }], {}, Date.now() - 3600e3, '2026-11-20', '2026-11-20');
  assert.strictEqual(rc.missingInWebhook.length, 1); ok('cross-check: an order after it with no webhook copy is reported');
  const io4 = memIo(); await handleWebhook(H, relay(6001), io4); await W.fold(io4);
  assert(io4.st.meta.firstRelayAt > 0); ok('first Order placed delivery recorded');

  // 12. Unknown payloads are acknowledged and ignored
  r = await handleWebhook(H, { reference_id: 'x', num_webhooks_retried: 2 }, io2);
  assert.deepStrictEqual([r.status, r.json.ignored], [200, true]); ok('retry summary callback ignored');

  // 13. Adopting the key Atlas actually sends, only when Atlas confirms it
  const io3 = memIo(); let ws = null;
  io3.readWhKey = async () => ws; io3.writeWhKey = async v => { ws = v; };
  const atlasKey = 'AtlasTyped16char';
  const H3 = { 'x-fh-webhook-key': atlasKey };
  const real = status(5001, 'Acknowledged', '2026-11-20 14:10:00');
  const detail = { id: 5001, statusUpdates: [{ status: 'ACKNOWLEDGED', created: '2026-11-20 14:10:20' }] };
  r = await handleWebhook(H3, real, io3);
  assert.deepStrictEqual([r.status, !!r.adopt], [401, true]); ok('unknown key: 401 and flagged for checking');
  let ad = await W.tryAdopt(io3, atlasKey, { ...real, biz_id: 111 }, async () => detail);
  assert(!ad.adopted && !ws); ok('other business: never adopted');
  ad = await W.tryAdopt(io3, atlasKey, real, async () => null);
  assert(!ad.adopted && !ws); ok('no Atlas session: not adopted');
  ad = await W.tryAdopt(io3, 'ForgedKey1234567', status(5001, 'Completed', '2026-11-20 14:10:00'), async () => detail);
  assert(!ad.adopted && !ws); ok('status Atlas does not confirm: not adopted');
  ad = await W.tryAdopt(io3, 'OtherKey12345678', status(5001, 'Acknowledged', '2026-11-20 14:20:00'), async () => detail);
  assert(!ad.adopted && !ws); ok('time 10 minutes off: not adopted');
  ad = await W.tryAdopt(io3, atlasKey, real, async () => detail);
  assert.strictEqual(ad.reason, 'checked recently'); ok('same key not re-checked within a minute');
  ad = await W.tryAdopt(io3, atlasKey, real, async () => detail, Date.now() + 61e3);
  assert(ad.adopted && ws && ws.hash === W.sha(atlasKey) && !JSON.stringify(ws).includes(atlasKey)); ok('confirmed by Atlas: adopted, only its SHA-256 stored');
  r = await handleWebhook(H3, relay(5002), io3);
  assert.strictEqual(r.status, 200); ok('adopted key now accepted without the session');
  r = await handleWebhook({ 'x-fh-webhook-key': 'AtlasTyped16chaX' }, relay(5003), io3);
  assert.strictEqual(r.status, 401); ok('a different key is still refused');
  r = await handleWebhook(H, relay(5004), io3);
  assert.strictEqual(r.status, 200); ok('the Vercel key keeps working too');

  console.log(`\nAll ${n} checks passed.`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
