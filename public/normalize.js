/* Shared by the browser (CSV/XLSX import) and the Node proxy (live Grubcenter API).
   Maps loosely-named Grubcenter fields to one internal order record. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCNormalize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  // internal field -> accepted source names (compared after key())
  const ALIASES = {
    id: ['orderid', 'uniqueorderid', 'id', 'ordernumber', 'orderno', 'ordernum', 'orderreference', 'externalorderid', 'externalid'],
    receivedAt: ['receivedat', 'orderreceivedat', 'ordercreatedtime', 'ordercreatedat', 'createdat', 'ordertime', 'orderdate', 'placedat', 'orderplacedat', 'date', 'datetime', 'receivedtime', 'occurredon', 'createdtime'],
    acceptedAt: ['acceptedat', 'acceptedtime', 'orderacceptedat'],
    startedAt: ['startedat', 'startedpreparingat', 'preparationstartedat', 'kitchenstartedat', 'startedtime'],
    preparedAt: ['preparedat', 'readyat', 'preparedtime', 'foodreadyat', 'readytime'],
    stdAt: ['senttodispatchertat', 'senttodispatcherat', 'senttodispatchat', 'senttodispatch', 'stdat', 'dispatchrequestedat', 'senttodriverat'],
    dispatchedAt: ['dispatchedat', 'dispatchedtime', 'pickedupat', 'outfordeliveryat'],
    deliveredAt: ['deliveredat', 'deliveredtime', 'completedat', 'deliverytime'],
    brand: ['brand', 'brandname', 'vendor', 'vendorname', 'restaurant', 'restaurantname', 'storename'],
    cuisine: ['cuisine', 'cuisinecluster', 'cuisinetype', 'cluster', 'category'],
    location: ['location', 'kitchenname', 'locationname', 'branch', 'branchname', 'kitchen', 'outlet', 'outletname', 'site'],
    channel: ['channel', 'orderchannel', 'channelname', 'source', 'ordersource', 'platform', 'aggregator', 'ordertype', 'ordermode'],
    payment: ['paymentmethod', 'payment', 'paymenttype', 'paymentmode'],
    partner: ['deliverypartnername', 'deliverypartner', 'deliveryprovider', 'courier', 'fleet', 'driverpartner'],
    netSales: ['netsales', 'netprice', 'netsale', 'netamount', 'netrevenue', 'net'],
    receiptTotal: ['receipttotal', 'totalreceipttotal', 'grossprice', 'totalprice', 'grosssales', 'grosstotal', 'total', 'ordertotal', 'totalamount', 'ordervalue', 'grossamount', 'subtotal'],
    discount: ['discount', 'discountedamount', 'discountamount', 'totaldiscount', 'discounts', 'promodiscount'],
    status: ['orderstatus', 'status', 'state', 'finalstatus'],
    reason: ['cancellationreason', 'cancelreason', 'reason', 'rejectionreason'],
    postCancelled: ['postcancelled', 'postcancel', 'cancelledafteraccept', 'cancelledafteracceptance'],
    rating: ['rating', 'orderrating', 'customerrating', 'stars', 'reviewrating', 'score'],
    estPrep: ['estimatedpreptime', 'estimatedpreparationtime', 'estprep', 'estimatedtime', 'preptimeestimate', 'brandestimatedtime']
  };

  const toDate = v => {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getTime();
    if (typeof v === 'number') return v > 1e11 ? v : (v > 20000 && v < 80000 ? Math.round((v - 25569) * 864e5) : v * 1000); // ms | excel serial | s
    const s = String(v).trim();
    const t = Date.parse(s);
    if (!isNaN(t)) return t;
    // dd/mm/yyyy [hh:mm[:ss]]
    const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return new Date(y, +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    }
    return null;
  };
  const num = v => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const str = v => (v == null ? '' : String(v).trim());
  const truthy = v => ['true', 'yes', 'y', '1'].includes(String(v).trim().toLowerCase());

  function buildMap(sampleKeys) {
    const lookup = {};
    sampleKeys.forEach(k => (lookup[key(k)] = k));
    const map = {};
    for (const f in ALIASES) for (const a of ALIASES[f]) if (lookup[a] !== undefined) { map[f] = lookup[a]; break; }
    return map;
  }

  function flatten(o, out) {
    out = out || {};
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, out);
      else if (!(k in out)) out[k] = v;
    }
    return out;
  }

  const BRAND_CUISINES = {
    'zaataria': 'Levantine', 'manoushestreet': 'Levantine', 'sofretbeirut': 'Levantine', 'fatayerji': 'Levantine',
    'immtalal': 'Levantine', 'koussablaban': 'Levantine', 'tabkhetsalma': 'Tabkha', 'dukkanalman': 'Levantine',
    'fatayerfakher': 'Levantine', 'fatayerbox': 'Levantine', 'fatayerfactory': 'Levantine', 'fateeraalhajar': 'Levantine',
    'furnalasala': 'Levantine', 'manakeesh': 'Levantine', 'simplymanakeesh': 'Levantine', 'themanooshelab': 'Levantine',
    'themanooshalab': 'Levantine', 'ruknalmanakeesh': 'Levantine',
    'yopasta': 'Italian', 'worldofpizza': 'Italian', 'woodstonepizza': 'Italian', 'thepastacompany': 'Italian',
    'thepastacup': 'Italian', 'pastaamore': 'Italian', 'societypizza': 'Italian', 'romapastaco': 'Italian',
    'republicofpizza': 'Italian', 'republicofpasta': 'Italian', 'fireboxpizza': 'Italian', 'alfredopasta': 'Italian',
    'arrabiatapasta': 'Italian',
    'theburgercompany': 'American / Fried', 'simplyburgers': 'American / Fried', 'thekrispyburger': 'American / Fried',
    'thecheeseburgerkitchen': 'American / Fried', 'thecheeseburgerco': 'American / Fried', 'burgero': 'American / Fried',
    'burgerhq': 'American / Fried', 'burgercom': 'American / Fried', 'naughtybird': 'American / Fried',
    'healthy': 'Healthy', 'healthfull': 'Healthy', 'acaiboost': 'Healthy', 'acailuv': 'Healthy',
    'fitgrillhouse': 'Healthy', 'grillproteinbowls': 'Healthy', 'grillbeastchicken': 'Healthy', 'grillflexco': 'Healthy',
    'musclegrillgreens': 'Healthy', 'muscleproteinco': 'Healthy', 'proteinflex': 'Healthy', 'purelyhealthybowls': 'Healthy',
    'thehealthymacro': 'Healthy', 'thehealthymarco': 'Healthy', 'thehealthyfork': 'Healthy', 'vitalclub': 'Healthy',
    'healthycartel': 'Healthy', 'healthydistrict': 'Healthy', 'healthyedge': 'Healthy', 'healthyfuel': 'Healthy',
    'bagelbloom': 'Wraps & Salads', 'wrapped': 'Wraps & Salads', 'overstuffedrolls': 'Wraps & Salads',
    'sweetspot': 'Desserts', 'bakerhouse': 'Desserts', 'desserts': 'Desserts'
  };

  function inferCuisine(brand, existing) {
    if (existing && existing !== 'No Cluster' && existing !== '(Blank)' && existing !== 'Other') return existing;
    const bk = key(brand);
    for (const k in BRAND_CUISINES) {
      if (bk.includes(k) || k.includes(bk)) return BRAND_CUISINES[k];
    }
    if (/manak|manoosh|fatay|levant|falafel|shawarma|zaatar|arabic|leban/i.test(brand)) return 'Levantine';
    if (/pizza|pasta|italian|lasag/i.test(brand)) return 'Italian';
    if (/burger|fry|fried|chicken|crispy|wings/i.test(brand)) return 'American / Fried';
    if (/health|diet|grill|salad|protein|macro|vital|acai/i.test(brand)) return 'Healthy';
    if (/bagel|roll|wrap|sandwich/i.test(brand)) return 'Wraps & Salads';
    if (/sweet|cake|dessert|bakery|bake|pastry|cookie/i.test(brand)) return 'Desserts';
    return 'Other';
  }

  function normalizeOrders(rows) {
    if (!rows.length) return [];
    const flat = rows.map(r => flatten(r));
    const map = buildMap(Object.keys(flat.reduce((a, r) => Object.assign(a, r), {})));
    return flat.map((r, i) => {
      const g = f => (map[f] !== undefined ? r[map[f]] : undefined);
      const status = str(g('status')).toLowerCase();
      const cancelled = typeof r.cancelled === 'boolean' ? r.cancelled : /cancel|reject|fail|void/.test(status);
      const receipt = num(g('receiptTotal'));
      const discount = Math.abs(num(g('discount')));
      const net = map.netSales !== undefined ? num(g('netSales')) : Math.max(receipt - discount, 0);
      const brandStr = str(g('brand')) || '(Blank)';
      const cuisineStr = inferCuisine(brandStr, str(g('cuisine')));
      return {
        id: str(g('id')) || 'row' + i,
        receivedAt: toDate(g('receivedAt')),
        acceptedAt: toDate(g('acceptedAt')),
        startedAt: toDate(g('startedAt')),
        preparedAt: toDate(g('preparedAt')),
        stdAt: toDate(g('stdAt')),
        dispatchedAt: toDate(g('dispatchedAt')),
        deliveredAt: toDate(g('deliveredAt')),
        brand: brandStr,
        cuisine: cuisineStr,
        location: str(g('location')) || '(Blank)',
        channel: str(g('channel')) || '(Blank)',
        payment: str(g('payment')) || '(Blank)',
        partner: str(g('partner')) || '(Blank)',
        netSales: net,
        receiptTotal: g('receiptTotal') !== undefined ? receipt : net + discount,
        discount,
        cancelled,
        postCancelled: cancelled && (map.postCancelled !== undefined ? truthy(g('postCancelled')) : (r.postCancelled || !!toDate(g('acceptedAt')))),
        reason: str(g('reason')) || (cancelled ? 'Unspecified' : ''),
        rating: num(g('rating')) || null,
        estPrep: num(g('estPrep')) || null
      };
    }).filter(o => o.receivedAt);
  }

  // item availability ("86") events
  const ITEM_ALIASES = {
    item: ['item', 'itemname', 'name', 'menuitem', 'product'],
    brand: ALIASES.brand,
    location: ALIASES.location,
    type: ['type', 'itemtype'],
    source: ['source', 'itemsource', 'updatedby', 'origin'],
    at: ['unavailableat', 'date', 'datetime', 'timestamp', 'occurredon', 'changedat', 'updatedat', 'createdat', 'time'],
    cuisine: ALIASES.cuisine
  };
  function isItemDataset(rows) {
    if (!rows.length) return false;
    const ks = Object.keys(rows[0]).map(key);
    return (ks.includes('itemname') || ks.includes('item')) && !ks.some(k => ALIASES.netSales.includes(k) || ALIASES.receiptTotal.includes(k));
  }
  function normalizeItems(rows) {
    if (!rows.length) return [];
    const lookup = {};
    Object.keys(rows[0]).forEach(k => (lookup[key(k)] = k));
    const map = {};
    for (const f in ITEM_ALIASES) for (const a of ITEM_ALIASES[f]) if (lookup[a]) { map[f] = lookup[a]; break; }
    return rows.map(r => ({
      item: str(r[map.item]) || '(Blank)',
      brand: str(r[map.brand]) || '(Blank)',
      cuisine: str(r[map.cuisine]) || 'No Cluster',
      location: str(r[map.location]) || '(Blank)',
      type: /modif/i.test(str(r[map.type])) ? 'Modifier' : 'Menu Item',
      source: str(r[map.source]) || 'Master',
      at: toDate(r[map.at])
    })).filter(x => x.at);
  }

  return { normalizeOrders, normalizeItems, isItemDataset, toDate, key };
});
