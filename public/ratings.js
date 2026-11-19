/* Aggregator store ratings (Talabat, Deliveroo, Careem, Keeta, Noon), shared
   by the server (/api/brand-ratings on Vercel and in server.js) and the
   browser, like sources.js.

   GrubCENTER sends no customer ratings, so these come from each aggregator's
   partner portal: a capture bookmarklet run in a signed-in portal tab, or
   manual entry. One document holds the latest capture per channel:

   { updatedAt, aliases: { "<normalised store name>": "Brand" },
     byChannel: { Talabat: { capturedAt, rows: [{ brand, location, store, rating, count, stars }] } },
     history: [{ date, channel, brand, location, rating, count }] } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FHRatings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CHANNELS = ['Talabat', 'Deliveroo', 'Careem', 'Keeta 2.0', 'Noon'];
  const LOCATIONS = ['Motor City', 'Jaddaf'];
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const HISTORY_MAX = 5000;

  const empty = () => ({ updatedAt: 0, aliases: {}, byChannel: {}, history: [] });

  // Portal names often differ in case or punctuation, or carry a branch
  // suffix ("Alfredo Pasta - Motor City").
  const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  function splitLocation(store) {
    const n = norm(store);
    for (const loc of LOCATIONS) {
      const l = norm(loc);
      if (n.endsWith(' ' + l) || n === l) return { name: n.slice(0, n.length - l.length).trim(), location: loc };
      if (n.includes(' ' + l + ' ')) return { name: n.replace(' ' + l + ' ', ' ').trim(), location: loc };
    }
    return { name: n, location: null };
  }

  // Map a portal store name to a dashboard brand: saved alias first, then an
  // exact normalised match, then a unique prefix match. Returns brand null
  // when unsure, so the import preview asks.
  function matchStore(store, brands, aliases) {
    const { name, location } = splitLocation(store);
    const al = aliases || {};
    if (al[norm(store)]) return { brand: al[norm(store)], location };
    if (al[name]) return { brand: al[name], location };
    const byNorm = new Map();
    for (const b of brands || []) if (!byNorm.has(norm(b))) byNorm.set(norm(b), b);
    if (byNorm.has(name)) return { brand: byNorm.get(name), location };
    const pref = (brands || []).filter(b => { const nb = norm(b); return nb && (name.startsWith(nb + ' ') || nb.startsWith(name + ' ')); });
    if (pref.length === 1) return { brand: pref[0], location };
    return { brand: null, location };
  }

  // Validate a capture: { channel, capturedAt?, rows: [{ brand, location?, store?, rating, count?, stars? }], aliases? }.
  function validate(p) {
    if (!p || typeof p !== 'object') return 'Body must be a JSON object';
    if (!CHANNELS.includes(p.channel)) return `Unknown channel "${p.channel}". Use one of: ${CHANNELS.join(', ')}`;
    if (!Array.isArray(p.rows) || !p.rows.length) return 'rows must be a non-empty array';
    if (p.rows.length > 1000) return 'Too many rows (max 1000)';
    for (const [i, r] of p.rows.entries()) {
      if (!r || typeof r.brand !== 'string' || !r.brand.trim()) return `Row ${i + 1}: brand is required`;
      if (typeof r.rating !== 'number' || !(r.rating >= 1 && r.rating <= 5)) return `Row ${i + 1} (${r.brand}): rating must be between 1 and 5`;
      if (r.count != null && !(Number.isInteger(r.count) && r.count >= 0)) return `Row ${i + 1} (${r.brand}): count must be a whole number, 0 or more`;
      if (r.location != null && !LOCATIONS.includes(r.location)) return `Row ${i + 1} (${r.brand}): location must be ${LOCATIONS.join(' or ')}`;
      if (r.stars != null) {
        if (typeof r.stars !== 'object') return `Row ${i + 1}: stars must be an object like {"5": 120, "4": 30}`;
        for (const [k, v] of Object.entries(r.stars)) if (!/^[1-5]$/.test(k) || !(Number.isInteger(v) && v >= 0)) return `Row ${i + 1}: stars must map 1-5 to whole numbers`;
      }
    }
    if (p.capturedAt != null && !(Number.isFinite(+p.capturedAt) && +p.capturedAt > 0)) return 'capturedAt must be a timestamp';
    return null;
  }

  // The latest capture replaces that channel's rows; history keeps one point
  // per brand, location, channel and day.
  function merge(doc, p, now = Date.now()) {
    const d = { ...empty(), ...(doc || {}) };
    const capturedAt = Math.min(+p.capturedAt || now, now);
    const rows = p.rows.map(r => ({
      brand: r.brand.trim(), location: r.location || null, store: r.store || null,
      rating: Math.round(r.rating * 100) / 100, count: r.count == null ? null : r.count, stars: r.stars || null
    }));
    d.byChannel = { ...d.byChannel, [p.channel]: { capturedAt, rows } };
    d.aliases = { ...d.aliases };
    for (const [k, v] of Object.entries(p.aliases || {})) if (typeof v === 'string' && v.trim()) d.aliases[norm(k)] = v.trim();
    const day = new Date(capturedAt).toISOString().slice(0, 10);
    const key = h => [h.date, h.channel, h.brand, h.location || ''].join('|');
    const fresh = rows.map(r => ({ date: day, channel: p.channel, brand: r.brand, location: r.location, rating: r.rating, count: r.count }));
    const freshKeys = new Set(fresh.map(key));
    d.history = (d.history || []).filter(h => !freshKeys.has(key(h))).concat(fresh).slice(-HISTORY_MAX);
    d.updatedAt = now;
    return d;
  }

  // Count-weighted average; rows without a count weigh 1.
  function weighted(rows) {
    let w = 0, s = 0, n = 0;
    for (const r of rows) { const k = r.count > 0 ? r.count : 1; w += k; s += r.rating * k; n += r.count || 0; }
    return w ? { rating: s / w, count: n } : null;
  }

  const band = r => (r == null ? null : r < 4 ? 'bad' : r < 4.5 ? 'mid' : 'good');

  // brand × channel matrix. filter(row) narrows rows (brand / branch filters).
  function matrix(doc, filter = () => true) {
    const d = doc || empty();
    const cells = {}, brands = new Set();
    for (const ch of CHANNELS) {
      const c = d.byChannel && d.byChannel[ch];
      if (!c) continue;
      for (const r of c.rows.filter(filter)) {
        brands.add(r.brand);
        ((cells[r.brand] = cells[r.brand] || {})[ch] = cells[r.brand][ch] || []).push(r);
      }
    }
    const rows = [...brands].sort().map(b => {
      const per = {};
      for (const ch of CHANNELS) if (cells[b][ch]) per[ch] = { ...weighted(cells[b][ch]), rows: cells[b][ch] };
      return { brand: b, per, overall: weighted(Object.values(per).map(x => ({ rating: x.rating, count: x.count }))) };
    });
    const totals = {};
    for (const ch of CHANNELS) {
      const c = d.byChannel && d.byChannel[ch];
      const cellRows = rows.filter(r => r.per[ch]).map(r => r.per[ch]);
      totals[ch] = { capturedAt: c ? c.capturedAt : 0, stale: c ? Date.now() - c.capturedAt > STALE_MS : false, avg: weighted(cellRows) };
    }
    return { rows, totals };
  }

  const cellCount = doc => Object.values((doc && doc.byChannel) || {}).reduce((n, c) => n + new Set(c.rows.map(r => r.brand)).size, 0);
  const lastCapture = doc => Math.max(0, ...Object.values((doc && doc.byChannel) || {}).map(c => c.capturedAt || 0));

  return { CHANNELS, LOCATIONS, STALE_MS, empty, norm, splitLocation, matchStore, validate, merge, weighted, band, matrix, cellCount, lastCapture };
});
