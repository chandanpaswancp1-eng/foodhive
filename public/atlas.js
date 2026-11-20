/* UrbanPiper Atlas (Jaddaf) imports, shared by the server (/api/up-import on
   Vercel and in server.js) and the browser, like ratings.js.

   Atlas has no read API, so data comes from a bookmarklet (atlas-capture.js)
   run in a signed-in Atlas tab. It calls the same GraphQL queries the Atlas
   pages use and copies a JSON capture, which is pasted into the dashboard:

   { kind: 'orders',  capturedAt, from, to, orders: [AtlasOrder] }
   { kind: 'catalog', capturedAt, items: [{ id, title, price, enabled, category, ref, brand }] }

   AtlasOrder carries no customer details: { id, created, channel, type,
   brand, store, paymentMode, status, subtotal, discount, totalCharges,
   totalTaxes, payableAmount, test, statusUpdates: [{ status, created,
   message }], items: [{ id, title, price, quantity, total, discount }] }.
   Atlas times are Dubai local "YYYY-MM-DD HH:mm:ss". */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./normalize.js'));
  else root.FHAtlas = factory(root.GCNormalize);
})(typeof self !== 'undefined' ? self : this, function (GCNormalize) {
  const inferCuisine = b => (GCNormalize && GCNormalize.inferCuisine ? GCNormalize.inferCuisine(b) : null) || 'No Cluster';
  const LOCATION = 'Jaddaf';
  const VAT_RATE = 0.05;
  const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
  const MAX_ORDERS = 20000;
  const MAX_ITEMS = 20000;
  // Jaddaf's first real orders were on 10 Nov 2026; everything created
  // before that was go-live testing (confirmed by the owner, 20 Nov 2026).
  const GO_LIVE = '2026-11-10';

  // Atlas channel codes to the channel names GrubCENTER orders use, so
  // commission.js rates and channel charts treat both kitchens alike.
  const CHANNELS = {
    talabat: 'Talabat', deliveroo: 'Deliveroo', careem: 'Careem', keeta: 'Keeta 2.0',
    noonfood: 'Noon', noon: 'Noon', phoneorder: 'Phone Order', phone: 'Phone Order',
    eateasy: 'EatEasy', web: 'Website', app_android: 'App', app_ios: 'App', satellite: 'Satellite'
  };
  const channelName = c => CHANNELS[String(c || '').toLowerCase()] || String(c || 'Unknown');

  // "2026-11-17 14:25:22" (Dubai) to epoch ms.
  function atlasTime(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - DUBAI_OFFSET_MS;
  }
  const num = v => (typeof v === 'number' && isFinite(v) ? v : isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  const round2 = v => Math.round(v * 100) / 100;

  function payment(mode) {
    const m = String(mode || '').toLowerCase();
    if (m.includes('cash')) return 'CASH';
    if (m.includes('card')) return 'CARD';
    return 'PREPAID';
  }

  // "Reason: Unspecified. Updated By Smash Stack" -> "Unspecified".
  function cancelReason(msg) {
    let m = String(msg || '').replace(/updated by .*$/i, '');
    const r = m.match(/reason:\s*(.*)$/i);
    if (r) m = r[1];
    return m.replace(/[.\s]+$/, '').trim();
  }

  // Test orders: anything created before GO_LIVE, cancelled with reason
  // TEST_ORDER or remarks "test", or flagged by the bookmarklet or webhook
  // (test customer name).
  function isTest(o) {
    if (o.test) return true;
    if (o.created && String(o.created).slice(0, 10) < GO_LIVE) return true;
    return (o.statusUpdates || []).some(s => /test[_ ]?order|remarks:\s*test\b/i.test(String(s.message || '')));
  }
  const GO_LIVE_MS = Date.UTC(+GO_LIVE.slice(0, 4), +GO_LIVE.slice(5, 7) - 1, +GO_LIVE.slice(8, 10)) - DUBAI_OFFSET_MS;

  // One Atlas order to the dashboard order shape (see data/all_orders.json).
  // Prices in Atlas UAE menus include VAT, so as with GrubCENTER receiptTotal
  // and discount are VAT-inclusive and netSales is VAT-exclusive.
  //
  // Hidden discount: on some aggregator orders Atlas's subtotal is already
  // below the item prices (items AED 70.00, subtotal AED 66.50) and the gap
  // is not in `discount`. Gross Sales is then the item prices and the gap is
  // added to the discount, so Gross, Discount and Discount % are right and
  // Net Sales is unchanged ((70 - 33.5) / 1.05 = (66.5 - 30) / 1.05).
  // Charges (delivery, packaging) stay in Gross and Net Sales like Motor
  // City's, and are also kept on their own in `charges`.
  function normalizeOrder(o) {
    if (!o || o.id == null || isTest(o)) return null;
    const receivedAt = atlasTime(o.created);
    if (!receivedAt) return null;
    const first = st => { const u = (o.statusUpdates || []).find(s => String(s.status).toUpperCase() === st); return u ? atlasTime(u.created) : null; };
    const status = String(o.status || '').toUpperCase();
    const cancelled = status === 'CANCELLED';
    const cancelUpd = cancelled ? [...(o.statusUpdates || [])].reverse().find(s => String(s.status).toUpperCase() === 'CANCELLED') : null;
    const taxes = num(o.totalTaxes);
    const charges = num(o.totalCharges);
    const subtotal = num(o.subtotal);
    const itemsTotal = (o.items || []).reduce((t, it) => t + num(it.total != null ? it.total : num(it.price) * (num(it.quantity) || 1)), 0);
    const hidden = (o.items || []).length && itemsTotal - subtotal > 0.01 ? itemsTotal - subtotal : 0;
    const discount = num(o.discount) + hidden;
    const receipt = subtotal + hidden + charges + (taxes > 0 ? taxes : 0);
    const net = taxes > 0 ? num(o.payableAmount) - taxes : (receipt - discount) / (1 + VAT_RATE);
    const lines = Array.isArray(o.charges) ? o.charges : null;
    const deliveryCharges = lines && Math.abs(lines.reduce((t, c) => t + num(c.value), 0) - charges) <= 0.01
      ? lines.filter(c => /deliver/i.test(String(c.title || ''))).reduce((t, c) => t + num(c.value), 0) : null;
    const acceptedAt = first('ACKNOWLEDGED');
    const deliveredAt = first('COMPLETED');
    const brand = String(o.brand || '').trim() || 'Unknown';
    return {
      id: 'up_' + o.id,
      receivedAt,
      acceptedAt,
      startedAt: null,
      preparedAt: first('FOOD_READY'),
      stdAt: null,
      dispatchedAt: first('DISPATCHED'),
      deliveredAt,
      brand,
      cuisine: inferCuisine(brand),
      location: LOCATION,
      channel: channelName(o.channel),
      payment: payment(o.paymentMode),
      partner: '(Blank)',
      netSales: round2(Math.max(net, 0)),
      receiptTotal: round2(receipt),
      discount: round2(discount),
      charges: round2(charges),
      // Delivery charge lines ("Delivery charge"), when Atlas sent the charge
      // breakdown; null when only the total is known.
      deliveryCharges: deliveryCharges == null ? null : round2(deliveryCharges),
      cancelled,
      postCancelled: cancelled && !!acceptedAt,
      reason: cancelled ? (cancelReason(cancelUpd && cancelUpd.message) || 'Unspecified') : '',
      rating: null,
      estPrep: null,
      status,
      via: o.via === 'webhook' ? 'webhook' : 'atlas',
      source: 'urbanpiper'
    };
  }

  // Line items in the order_items shape the Menu pages use.
  function normalizeLines(o, order) {
    if (!order) return [];
    return (o.items || []).map(it => {
      const qty = num(it.quantity) || 1;
      const lineTotal = it.total != null ? num(it.total) : num(it.price) * qty;
      return {
        orderId: order.id, item: String(it.title || '').trim(), itemId: it.id == null ? '' : String(it.id),
        modifier: '', modifierId: '', type: 'Menu Item', qty, unitPrice: num(it.price), lineTotal: round2(lineTotal),
        discount: round2(num(it.discount)), brand: order.brand, location: LOCATION, channel: order.channel, at: order.receivedAt
      };
    }).filter(l => l.item);
  }

  function validate(p) {
    if (!p || typeof p !== 'object') return 'Body must be a JSON object';
    if (p.kind === 'orders') {
      if (!Array.isArray(p.orders)) return 'orders must be an array';
      if (p.orders.length > MAX_ORDERS) return `Too many orders (max ${MAX_ORDERS})`;
      for (const [i, o] of p.orders.entries()) {
        if (!o || o.id == null) return `Order ${i + 1}: id is required`;
        if (!atlasTime(o.created)) return `Order ${o.id}: created time "${o.created}" is not Atlas format`;
      }
      return null;
    }
    if (p.kind === 'catalog') {
      if (!Array.isArray(p.items) || !p.items.length) return 'items must be a non-empty array';
      if (p.items.length > MAX_ITEMS) return `Too many items (max ${MAX_ITEMS})`;
      return null;
    }
    return 'kind must be "orders" or "catalog". Paste the capture from the FoodHive Atlas bookmarklet.';
  }

  // Upsert by id: recapturing an overlapping range is safe and the newer
  // capture wins (an order cancelled after the last capture, say). Lines are
  // replaced for every order in the capture.
  function mergeOrders(existing, existingLines, capture) {
    // Orders stored before GO_LIVE were tests: drop them and their lines.
    const map = new Map((existing || []).filter(o => !(o.receivedAt < GO_LIVE_MS)).map(o => [o.id, o]));
    const preLive = new Set((existing || []).filter(o => o.receivedAt < GO_LIVE_MS).map(o => o.id));
    const touched = new Set(preLive);
    const lines = [];
    let added = 0, updated = 0, tests = 0;
    for (const raw of capture.orders || []) {
      const o = normalizeOrder(raw);
      if (!o) { if (raw && raw.id != null && isTest(raw)) { tests++; if (map.delete('up_' + raw.id)) touched.add('up_' + raw.id); } continue; }
      if (map.has(o.id)) updated++; else added++;
      map.set(o.id, o);
      touched.add(o.id);
      lines.push(...normalizeLines(raw, o));
    }
    const keptLines = (existingLines || []).filter(l => !touched.has(l.orderId));
    const orders = [...map.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    return { orders, lines: keptLines.concat(lines), added, updated, tests, purgedPreLive: preLive.size };
  }

  // Catalogue items with the Jaddaf location. Atlas `enabled: false` means
  // the item is switched off, which the Items page counts as 86'd.
  function normalizeCatalog(capture) {
    return (capture.items || []).map(i => ({
      id: i.id, title: String(i.title || '').trim(), price: num(i.price), enabled: i.enabled !== false,
      category: i.category || null, ref: i.ref || null, brand: String(i.brand || '').trim() || 'Unknown', location: LOCATION
    })).filter(i => i.title);
  }

  // 86 events for the Items page, in the shape normalize.js gives GrubCENTER
  // events: one per disabled item per capture day. Older events are kept.
  function catalogEvents(existing, catalog, capturedAt) {
    const at = capturedAt || Date.now();
    const key = e => [e.item, e.brand, new Date(e.at + DUBAI_OFFSET_MS).toISOString().slice(0, 10)].join('|');
    const out = (existing || []).slice();
    const seen = new Set(out.map(key));
    for (const i of catalog) {
      if (i.enabled) continue;
      const e = { item: i.title, brand: i.brand, cuisine: inferCuisine(i.brand), location: LOCATION, type: 'Menu Item', source: 'Atlas', at };
      if (seen.has(key(e))) continue;
      seen.add(key(e));
      out.push(e);
    }
    return out;
  }

  function summary(p) {
    if (p.kind === 'orders') {
      const os = p.orders || [];
      const tests = os.filter(isTest).length;
      const days = os.map(o => String(o.created).slice(0, 10)).sort();
      return `${os.length} orders${tests ? ` (${tests} test orders will be skipped)` : ''}${days.length ? `, ${days[0]} to ${days[days.length - 1]}` : ''}`;
    }
    if (p.kind === 'catalog') {
      const it = p.items || [];
      return `${it.length} catalogue items, ${it.filter(i => i.enabled === false).length} switched off`;
    }
    return '';
  }

  // GraphQL the Atlas pages use (atlas-backend.svc.urbanpiper.com/graphql).
  // atlas-capture.js carries its own copy because a bookmarklet is one file.
  const API = 'https://atlas-backend.svc.urbanpiper.com/graphql';
  const QUERIES = {
    list: 'query($limit:Int,$sort:SortInput,$filters:[ListFilterArgument],$brand:String,$cursor:String){ordersV2(limit:$limit,sort:$sort,filters:$filters,brand:$brand,cursor:$cursor){hasNext nextCursor objects{id created channel status store{title brand{name}}}}}',
    order: 'query($id:Int){order(id:$id){id type created status channel paymentMode subtotal discount totalCharges totalTaxes payableAmount charges{title value} customer{fullName} store{title brand{name}} statusUpdates{status created message} items{id title price quantity total discount}}}',
    // Same without the charge lines, for when Atlas does not offer them.
    orderBasic: 'query($id:Int){order(id:$id){id type created status channel paymentMode subtotal discount totalCharges totalTaxes payableAmount customer{fullName} store{title brand{name}} statusUpdates{status created message} items{id title price quantity total discount}}}',
    items: 'query($limit:Int,$offset:Int,$filters:[ListFilterArgument],$brand:String){items(limit:$limit,offset:$offset,filters:$filters,brand:$brand){count objects{id itemTitle itemPrice isEnabled merchantRefId category itemDiscreteCategory{name} brandsData{name}}}}'
  };

  // An Atlas order detail to the capture record (no customer details; a
  // test customer only sets test: true).
  function fromDetail(o) {
    const name = (o.customer && o.customer.fullName) || '';
    return {
      id: o.id, created: o.created, channel: o.channel, type: o.type,
      brand: o.store && o.store.brand ? o.store.brand.name : null, store: o.store ? o.store.title : null,
      paymentMode: o.paymentMode, status: o.status, subtotal: o.subtotal, discount: o.discount,
      totalCharges: o.totalCharges, totalTaxes: o.totalTaxes, payableAmount: o.payableAmount,
      charges: Array.isArray(o.charges) ? o.charges.map(c => ({ title: c.title, value: c.value })) : null,
      test: /test\s*order/i.test(name),
      statusUpdates: (o.statusUpdates || []).map(s => ({ status: s.status, created: s.created, message: s.message })),
      items: (o.items || []).map(t => ({ id: t.id, title: t.title, price: t.price, quantity: t.quantity, total: t.total, discount: t.discount }))
    };
  }
  // ---- UrbanPiper webhooks (api/up-webhook.js) ----
  // Epoch ms (or s, or an Atlas string) to Atlas's Dubai "YYYY-MM-DD HH:mm:ss".
  function dubaiString(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string' && atlasTime(v)) return v.replace('T', ' ').slice(0, 19);
    let n = +v;
    if (!isFinite(n)) { const t = Date.parse(v); if (!isFinite(t)) return null; n = t; }
    if (n < 1e12) n *= 1000;
    return new Date(n + DUBAI_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
  }
  // "Food Ready" -> FOOD_READY; customer_cancelled -> CANCELLED.
  function statusName(s) {
    const k = String(s || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    return k === 'CUSTOMER_CANCELLED' ? 'CANCELLED' : k;
  }
  // Order Relay payload to the capture record fromDetail() builds, so both
  // paths go through normalizeOrder(). Customer details are dropped here; a
  // test customer only sets test: true.
  function fromWebhook(payload) {
    const ord = payload && payload.order;
    const d = ord && ord.details;
    if (!d || d.id == null) return null;
    const cust = (payload.customer && payload.customer.name) || '';
    const plat = (d.ext_platforms || [])[0] || {};
    const items = (ord.items || []).map(t => ({
      id: t.id, title: t.title, price: t.price, quantity: t.quantity, total: t.total, discount: t.discount,
      options: (t.options_to_add || []).reduce((s, x) => s + num(x.total_price != null ? x.total_price : num(x.price) * (num(x.quantity) || 1)), 0)
    }));
    // Option prices are sometimes outside item `total`. Add them only when
    // that is what makes the items add up to Atlas's subtotal.
    const sub = num(d.order_subtotal), base = items.reduce((s, t) => s + num(t.total), 0);
    const opts = items.reduce((s, t) => s + t.options, 0), optsQ = items.reduce((s, t) => s + t.options * (num(t.quantity) || 1), 0);
    const addOpts = Math.abs(base - sub) > 0.01 && opts > 0 ? (Math.abs(base + opts - sub) <= 0.01 ? 1 : Math.abs(base + optsQ - sub) <= 0.01 ? 'q' : 0) : 0;
    const created = dubaiString(d.created);
    return {
      id: d.id, created, channel: d.channel || plat.name || null, type: d.order_type || null,
      brand: (d.brand && d.brand.name) || null, store: ord.store ? ord.store.name : null,
      paymentMode: ((ord.payment || [])[0] || {}).option || null,
      status: statusName(d.order_state || d.state || 'PLACED'),
      subtotal: d.order_subtotal, discount: d.discount, totalCharges: d.total_charges, totalTaxes: d.total_taxes, payableAmount: d.payable_amount,
      externalDiscount: d.total_external_discount != null ? num(d.total_external_discount) : null,
      charges: Array.isArray(d.charges) ? d.charges.map(c => ({ title: c.title, value: c.value })) : null,
      bizId: d.biz_id != null ? String(d.biz_id) : null,
      test: /test\s*order/i.test(cust), via: 'webhook',
      statusUpdates: [{ status: 'PLACED', created, message: '' }],
      items: items.map(t => ({ id: t.id, title: t.title, price: t.price, quantity: t.quantity, discount: t.discount,
        total: addOpts === 1 ? num(t.total) + t.options : addOpts === 'q' ? num(t.total) + t.options * (num(t.quantity) || 1) : t.total }))
    };
  }
  // Order Status Update payload to { orderId, status, created, message }.
  function statusFromWebhook(p) {
    if (!p || p.order_id == null || !p.new_state) return null;
    const msg = p.message || p.reason_code || '';
    return {
      orderId: String(p.order_id), status: statusName(p.new_state),
      created: dubaiString(p.timestamp_unix != null ? p.timestamp_unix : p.timestamp),
      message: statusName(p.new_state) === 'CANCELLED' && msg && !/reason:/i.test(msg) ? 'Reason: ' + msg : msg,
      bizId: p.biz_id != null ? String(p.biz_id) : null
    };
  }
  // Apply status updates to an order already stored in dashboard shape
  // (one that came from an Atlas sync), with the timing rules
  // normalizeOrder() uses: the first time a status is reached counts.
  function applyStatuses(order, updates) {
    const o = { ...order };
    const sorted = updates.slice().sort((a, b) => (atlasTime(a.created) || 0) - (atlasTime(b.created) || 0));
    for (const u of sorted) {
      const t = atlasTime(u.created), st = statusName(u.status);
      if (st === 'ACKNOWLEDGED' && !o.acceptedAt) o.acceptedAt = t;
      if (st === 'FOOD_READY' && !o.preparedAt) o.preparedAt = t;
      if (st === 'DISPATCHED' && !o.dispatchedAt) o.dispatchedAt = t;
      if (st === 'COMPLETED' && !o.deliveredAt) o.deliveredAt = t;
      if (st === 'CANCELLED') { o.cancelled = true; o.postCancelled = !!o.acceptedAt; o.reason = cancelReason(u.message) || o.reason || 'Unspecified'; }
      o.status = st;
    }
    return o;
  }

  const fromItem = i => ({
    id: i.id, title: i.itemTitle, price: i.itemPrice, enabled: i.isEnabled !== false,
    category: (i.itemDiscreteCategory && i.itemDiscreteCategory.name) || i.category || null,
    ref: i.merchantRefId || null, brand: i.brandsData && i.brandsData[0] ? i.brandsData[0].name : null
  });

  return { API, QUERIES, fromDetail, fromItem, LOCATION, CHANNELS, channelName, atlasTime, normalizeOrder, normalizeLines, validate, mergeOrders, normalizeCatalog, catalogEvents, summary, isTest, GO_LIVE, GO_LIVE_MS, dubaiString, statusName, fromWebhook, statusFromWebhook, applyStatuses };
});
