/* Read-only data audit against a running dashboard (production by default).
   node scripts/audit-data.js [--base https://foodhive-ops-dashboard.vercel.app] [--from 2026-08-17]
   Prints every check and exits 1 if any check fails. Writes nothing. */
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const BASE = (arg('base') || 'https://foodhive-ops-dashboard.vercel.app').replace(/\/$/, '');
const FROM = arg('from') || '2026-08-17';
const GO_LIVE = '2026-11-10';
const day = ms => new Date(ms + 4 * 3600e3).toISOString().slice(0, 10);
const r2 = n => Math.round(n * 100) / 100;

(async () => {
  const today = day(Date.now());
  const get = async p => { const r = await fetch(BASE + p + (p.includes('?') ? '&' : '?') + 'r=' + Date.now()); if (!r.ok) throw new Error(p + ' HTTP ' + r.status); return r.json(); };
  const [oj, lj, aj, sj] = await Promise.all([get(`/api/orders?from=${FROM}&to=${today}`), get(`/api/order-items?from=${FROM}&to=${today}`), get('/api/availability'), get('/api/sources')]);
  const O = oj.orders, L = lj.items, AV = aj.items;
  let fails = 0;
  const check = (name, okv, detail) => { if (!okv) fails++; console.log(`${okv ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
  const info = (name, detail) => console.log(`INFO  ${name} — ${detail}`);
  console.log(`Audit of ${BASE}, ${FROM} to ${today}: ${O.length} orders, ${L.length} item lines, ${AV.length} 86 events\n`);

  // Orders
  const ids = new Map(); O.forEach(o => ids.set(o.id, (ids.get(o.id) || 0) + 1));
  check('No duplicate order ids', [...ids.values()].every(v => v === 1));
  check('Every order has source and location', O.every(o => o.source && o.location));
  check('No order in the future', O.every(o => o.receivedAt <= Date.now() + 60e3));
  check('No negative amounts', O.every(o => o.netSales >= 0 && o.receiptTotal >= 0 && o.discount >= 0));
  check('Discount never above gross', O.every(o => o.discount <= o.receiptTotal + 0.01));
  const netOff = src => O.filter(o => o.source === src && !o.cancelled && Math.abs(o.netSales - Math.max((o.receiptTotal - o.discount) / 1.05, 0)) > 0.01);
  check('Jaddaf net = (gross − discount) ÷ 1.05', netOff('urbanpiper').length === 0, `${netOff('urbanpiper').length} off`);
  const gcOff = netOff('grubcenter');
  info('Motor City net vs (gross − discount) ÷ 1.05', `${gcOff.length} orders differ (GrubCENTER's own net; max ${r2(Math.max(0, ...gcOff.map(o => Math.abs(o.netSales - (o.receiptTotal - o.discount) / 1.05))))} AED)`);
  check('Cancelled orders have a reason', O.every(o => !o.cancelled || o.reason));
  check('Active orders have no cancel reason', O.every(o => o.cancelled || !o.reason));
  const seq = ['receivedAt', 'acceptedAt', 'preparedAt', 'dispatchedAt', 'deliveredAt'];
  const badSeq = O.filter(o => { let last = 0; return seq.some(f => { const v = o[f]; if (!v) return false; const b = v < last - 60e3; last = v; return b; }); });
  check('Order timings in order (received → accepted → prepared → dispatched → delivered)', badSeq.length <= 2, `${badSeq.length} out of order`);
  const jd = O.filter(o => o.source === 'urbanpiper');
  check(`No Jaddaf orders before go-live (${GO_LIVE})`, jd.every(o => day(o.receivedAt) >= GO_LIVE), `${jd.filter(o => day(o.receivedAt) < GO_LIVE).length} found`);
  check('Jaddaf orders carry charges', jd.every(o => typeof o.charges === 'number'), `${jd.filter(o => typeof o.charges !== 'number').length} without`);

  // Days
  const gcDays = new Map(); O.filter(o => o.source === 'grubcenter').forEach(o => gcDays.set(day(o.receivedAt), (gcDays.get(day(o.receivedAt)) || 0) + 1));
  const allDays = []; for (let t = Date.parse(FROM + 'T00:00:00Z'); day(t - 4 * 3600e3) <= today; t += 864e5) allDays.push(new Date(t).toISOString().slice(0, 10));
  const gap = allDays.filter(d => !gcDays.has(d));
  info('Motor City days with no orders', gap.length ? gap.join(', ') : 'none');

  // Line items
  const byOrder = new Map(); L.forEach(l => { const k = String(l.orderId); if (!byOrder.has(k)) byOrder.set(k, []); byOrder.get(k).push(l); });
  const lastSync = oj.lastSync || 0;
  const noLines = O.filter(o => !o.cancelled && day(o.receivedAt) >= (lj.coveredFrom || FROM) && o.receivedAt < lastSync - 15 * 60e3 && !byOrder.has(String(o.id)));
  const nlDays = {}; noLines.forEach(o => { const k = `${o.location} ${day(o.receivedAt)}`; nlDays[k] = (nlDays[k] || 0) + 1; });
  check('Every active order (older than the last sync) has item lines', noLines.length === 0, noLines.length ? JSON.stringify(nlDays) : '');
  const ordById = new Map(O.map(o => [String(o.id), o]));
  const orphan = [...byOrder.keys()].filter(k => !ordById.has(k));
  info('Item lines whose order is not in the range', `${orphan.length} orders`);
  const brandOff = L.filter(l => ordById.has(String(l.orderId)) && l.brand !== ordById.get(String(l.orderId)).brand);
  info('Item lines labelled with another brand by the source', `${brandOff.length} (the dashboard shows them under the order's brand)`);
  const jdLineOff = jd.filter(o => !o.cancelled && byOrder.has(o.id)).filter(o => {
    // Line totals are after any item-level discount (Atlas item `total`).
    const s = byOrder.get(o.id).reduce((t, l) => t + l.lineTotal, 0);
    const itemDisc = byOrder.get(o.id).reduce((t, l) => t + (l.discount || 0), 0);
    const want = o.receiptTotal - (o.charges || 0);
    return Math.abs(s - want) > 0.01 && Math.abs(s + itemDisc - want) > 0.01;
  });
  check('Jaddaf item lines = gross − charges (before item discounts)', jdLineOff.length === 0, jdLineOff.length ? `${jdLineOff.length} differ, e.g. ${jdLineOff.slice(0, 3).map(o => o.id).join(', ')}` : '');

  // 86 events
  const avKey = new Set(); let avDup = 0; AV.forEach(a => { const k = [a.item, a.brand, a.location, a.at].join('|'); if (avKey.has(k)) avDup++; avKey.add(k); });
  check('No duplicate 86 events', avDup === 0, `${avDup}`);

  // Sources
  sj.sources.forEach(s => (['ok', 'waiting', 'off'].includes(s.status) ? info : (n, d) => check(n, false, d))(`Source ${s.name}`, `${s.status}${s.error ? ': ' + s.error : ''}`));

  console.log(`\n${fails ? fails + ' check(s) failed' : 'All checks passed'}.`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('Audit could not run:', e.message); process.exit(2); });
