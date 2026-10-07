/* Kaykroo Dashboard · FoodHive Operations & Sales
 * Exact replica of Kaykroo Power BI dashboard:
 * - Dual-range date slicers & stage sliders
 * - Top & bottom sidebar toggles per page
 * - Full interactive cross-filtering on charts
 * - Auto-sync with GrubCENTER live API and local decrypted exports
 */
(() => {
'use strict';
const NZ = window.GCNormalize;
Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Segoe UI', Inter, Arial, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.plugins.datalabels.display = false;
// Animations off: Chart.js only builds its per-property Animation object when
// duration is truthy (see Animations._createAnimations); with it on, any
// property whose from/to/current value resolves to `undefined` (e.g. an
// element present in one render but not the next) hits
// `interpolators[cfg.type || typeof from]` with no matching key and throws
// "this._fn is not a function", aborting that paint -- which can also starve
// other charts queued in the same shared animation frame, leaving them blank.
Chart.defaults.animation = false;

const Y = '#FCD258', K = '#1d1d1d', GREY = '#666', BLUE = '#1b2a9b', LIGHT = '#FEE8AC';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const uniq = a => [...new Set(a)];
const pad = n => String(n).padStart(2, '0');
// The business runs on Asia/Dubai time (UTC+4, no DST). Using the raw
// Date getters here would bucket every chart by whatever timezone the
// *viewer's browser* happens to be set to, not Dubai's -- two people
// looking at the same dashboard from different timezones would see
// different day/hour groupings. Shifting by the fixed Dubai offset and
// reading back with the UTC getters makes this viewer-timezone-independent.
const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const dubaiDate = t => new Date(new Date(t).getTime() + DUBAI_OFFSET_MS);
const dkey = t => { const d = dubaiDate(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const dubaiHour = t => dubaiDate(t).getUTCHours();
const dubaiDOW = t => dubaiDate(t).getUTCDay();
const money = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'K' : n.toFixed(2);
const cnt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(Math.round(n));
const pc = (n, d = 1) => (n * 100).toFixed(d) + '%';
const trunc = (s, n = 15) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dowOf = t => DOW[(dubaiDOW(t) + 6) % 7];

function toCleanMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v + 4 * 3600000;
  const s = String(v).replace(/Z$/, '').replace('T', ' ');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return Date.parse(v) || null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
const mins = (a, b) => {
  const ma = toCleanMs(a), mb = toCleanMs(b);
  if (!ma || !mb) return null;
  const d = (mb - ma) / 60000;
  return d >= 0 && d <= 1440 ? d : null;
};
function prepOf(o) {
  return mins(o.startedAt, o.preparedAt) ?? mins(o.acceptedAt || o.receivedAt, o.preparedAt);
}
function orderRating(o) {
  if (o.rating != null && o.rating > 0) return o.rating;
  if (S.ui.rmode === 'strict') return null;
  const p = prepOf(o);
  if (p == null) return null;
  if (p <= 12) return 5;
  if (p <= 18) return 4;
  if (p <= 26) return 3;
  if (p <= 38) return 2;
  return 1;
}

// ---------------- state ----------------
const S = {
  orders: [], items: [], lineItems: [], source: 'none', page: 'sales', loadedRange: null,
  f: {
    from: '', to: '', channel: 'All', brand: 'All', location: 'All', payment: 'All',
    day: 'All', partner: 'All', reason: 'All', post: 'All', ratingFilter: 'all',
    onlyDelayed: false, slot: 'All', hour: 'All', star: 'All', item: 'All',
    source: 'All', type: 'All'
  },
  ui: {
    metric: 'sales', group: 'cuisine', grain: 'Daily', cmetric: 'orders',
    cgroup: 'brand', pgroup: 'brand', rgroup: 'cuisine', igroup: 'brand',
    dgroup: 'brand', rmode: 'estimated', activeStage: null, itemsView: '86'
  },
  rng: {}, selBrands: new Set(), selLocs: new Set()
};
const gk = (o, g) => (g === 'brand' ? o.brand : o.cuisine);

// ---------------- tooltip styling (Power BI Dark) ----------------
const pbiTooltip = {
  backgroundColor: '#1d1d1d',
  titleColor: '#FCD258',
  titleFont: { weight: 'bold', size: 12 },
  bodyColor: '#ffffff',
  bodyFont: { size: 11 },
  borderColor: '#555',
  borderWidth: 1,
  padding: 8,
  cornerRadius: 3,
  displayColors: true,
  boxWidth: 8,
  boxHeight: 8
};

// ---------------- charts ----------------
const charts = {};
window.charts = charts;
function destroyAllCharts() {
  Object.keys(charts).forEach(id => { charts[id].destroy(); delete charts[id]; });
}
// Tried animating the chart panel itself (the canvas's .pb parent) with
// Element.animate() on every mk() call as a "chart refreshed" flash. Verified
// in-browser that this reliably throws inside Chart.js's own event dispatch
// ("Cannot read properties of undefined (reading 'handleEvent')") during the
// destroy+recreate cycle mk() already does on every render -- confirmed by
// neutering Element.prototype.animate and watching the errors disappear.
// That .pb element is exactly what Chart.js's `responsive: true` resize
// handling watches, so animating it mid-recreate reintroduces the same class
// of crash commit 7455703 fixed (see the Chart.defaults.animation comment
// above). All chart-adjacent motion was removed for that reason; KPI tiles
// (plain DOM, never touched by Chart.js) are the safe place for motion.
function mk(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const el = document.getElementById(id); if (!el) return;
  const p = el.parentElement; $$('.empty', p).forEach(e => e.remove());
  if (cfg.__empty) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No data for current filters'; p.appendChild(e);
    return;
  }
  charts[id] = new Chart(el, cfg);
}
const baseOpts = (extra = {}) => Object.assign({
  responsive: true, maintainAspectRatio: false,
  layout: { padding: { top: 18, right: 4 } },
  plugins: { legend: { display: false }, tooltip: pbiTooltip }
}, extra);

const lbl = (fmt, o = {}) => Object.assign({ display: true, anchor: 'end', align: 'end', font: { size: 10, weight: '600' }, color: K, formatter: fmt, clamp: true }, o);
const pctLbl = () => ({ display: true, align: 'bottom', offset: 6, backgroundColor: 'rgba(255,255,255,.9)', borderRadius: 3, padding: 1, color: K, font: { size: 10, weight: '600' }, formatter: v => v.toFixed(1) + '%' });
const gridless = { grid: { display: false } };

/** Cross-filter on bar click */
function addBarClick(opts, kf, filterKey) {
  opts.onHover = (e, el) => {
    if (e.native && e.native.target) {
      e.native.target.style.cursor = el && el.length ? 'pointer' : 'default';
    }
  };
  opts.onClick = (e, elements, chart) => {
    if (!elements || !elements.length) return;
    const idx = elements[0].index;
    const label = chart ? chart.data.labels[idx] : null;
    if (label == null) return;
    const cur = S.f[filterKey];
    S.f[filterKey] = (String(cur) === String(label) ? 'All' : String(label));
    syncFilterUI();
    render();
  };
  return opts;
}

/** value bars + % of total line */
function combo(id, rows, { vk = 'v', name = 'Value', pctName = '%GT', fmt = money, horizontal = false, color = Y, filterKey } = {}) {
  if (!rows.length) return mk(id, { __empty: true });
  const total = sum(rows, r => r[vk]) || 1;
  const many = rows.length > 26;
  const curF = filterKey ? S.f[filterKey] : 'All';
  const colors = rows.map(r => (curF !== 'All' ? (String(r.k) === String(curF) ? '#1d1d1d' : '#FEEBB4') : color));

  const ds = [{
    type: 'bar', label: name, data: rows.map(r => r[vk]), backgroundColor: colors, order: 2, yAxisID: 'y',
    datalabels: many ? { display: false } : lbl(fmt)
  }];
  const scales = {
    x: { ...gridless, ticks: { maxRotation: 55, minRotation: 0, autoSkip: false, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 16); } } },
    y: { beginAtZero: true, ticks: { callback: fmt, maxTicksLimit: 5 }, grid: { color: '#eee' } }
  };
  if (!horizontal) {
    ds.push({
      type: 'line', label: pctName, data: rows.map(r => r[vk] / total * 100),
      borderColor: BLUE, backgroundColor: BLUE, borderWidth: 1.6, pointRadius: 2, tension: .35, yAxisID: 'y1', order: 1,
      datalabels: many ? { display: false } : pctLbl()
    });
    scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { callback: v => v + '%', maxTicksLimit: 5 } };
  }
  const opts = baseOpts({
    indexAxis: horizontal ? 'y' : 'x',
    scales: horizontal ? { y: { ...gridless, ticks: { font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 20); } } }, x: { beginAtZero: true, ticks: { callback: fmt, maxTicksLimit: 5 }, grid: { color: '#eee' } } } : scales,
    plugins: { legend: { display: !horizontal, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } }
  });
  if (filterKey) addBarClick(opts, r => r.k, filterKey);
  mk(id, { type: 'bar', data: { labels: rows.map(r => r.k), datasets: ds }, options: opts });
}

function hbar(id, rows, { fmt = money, color = Y, name = 'Value', filterKey } = {}) {
  if (!rows.length) return mk(id, { __empty: true });
  const curF = filterKey ? S.f[filterKey] : 'All';
  const colors = rows.map(r => (curF !== 'All' ? (String(r.k) === String(curF) ? '#1d1d1d' : '#FEEBB4') : color));
  const opts = baseOpts({
    indexAxis: 'y', layout: { padding: { right: 38, top: 2 } },
    scales: { y: { ...gridless, ticks: { font: { size: 10 }, autoSkip: false, callback(v) { return trunc(this.getLabelForValue(v), 20); } } }, x: { beginAtZero: true, ticks: { callback: fmt, maxTicksLimit: 5 }, grid: { color: '#eee' } } }
  });
  if (filterKey) addBarClick(opts, r => r.k, filterKey);
  mk(id, { type: 'bar', data: { labels: rows.map(r => r.k), datasets: [{ label: name, data: rows.map(r => r.v), backgroundColor: colors, datalabels: lbl(fmt, { align: 'end', anchor: 'end' }) }] }, options: opts });
}

function donut(id, rows, { fmt = money, colors, legend = 'right', pctLabels = true, filterKey } = {}) {
  if (!rows.length) return mk(id, { __empty: true });
  const pal = colors || ['#FCD258', '#3a3a3a', '#1e88e5', '#ff7043', '#8e24aa', '#ec407a', '#26a69a', '#7cb342', '#795548', '#9e9e9e'];
  const tot = sum(rows, r => r.v) || 1;
  const curF = filterKey ? S.f[filterKey] : 'All';
  const sliceColors = rows.map((r, i) => curF !== 'All' ? (String(r.k) === String(curF) ? pal[i % pal.length] : '#dedede') : pal[i % pal.length]);
  const opts = baseOpts({
    cutout: '58%', layout: { padding: 6 },
    plugins: {
      legend: {
        display: true, position: legend,
        labels: {
          boxWidth: 9, boxHeight: 9, font: { size: 10 },
          generateLabels: ch => ch.data.labels.map((l, i) => ({
            text: `${trunc(String(l), 16)} ${fmt(ch.data.datasets[0].data[i])} (${pc(ch.data.datasets[0].data[i] / tot)})`,
            fillStyle: ch.data.datasets[0].backgroundColor[i], strokeStyle: '#fff', index: i
          }))
        }
      }
    }
  });
  if (filterKey) addBarClick(opts, r => r.k, filterKey);
  mk(id, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => r.k),
      datasets: [{
        data: rows.map(r => r.v),
        backgroundColor: sliceColors,
        borderWidth: 1, borderColor: '#fff',
        datalabels: {
          display: pctLabels,
          color: ctx => ['#3a3a3a', '#1e88e5', '#8e24aa', '#795548', '#1d1d1d', '#e53935'].includes(ctx.dataset.backgroundColor[ctx.dataIndex]) ? '#fff' : K,
          font: { size: 10, weight: '600' },
          formatter: (v) => (v / tot > .04 ? pc(v / tot) : '')
        }
      }]
    },
    options: opts
  });
}

function lineChart(id, labels, series, { fmt = money, smooth = true, fill = false, dl = false } = {}) {
  if (!labels.length) return mk(id, { __empty: true });
  mk(id, {
    type: 'line',
    data: {
      labels,
      datasets: series.map(s => ({
        label: s.name, data: s.data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2,
        pointRadius: labels.length > 60 ? 0 : 2, tension: smooth ? .35 : 0, fill,
        datalabels: dl ? lbl(fmt, { align: 'top', anchor: 'end' }) : { display: false }
      }))
    },
    options: baseOpts({
      plugins: { legend: { display: series.length > 1, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
      scales: { x: { ...gridless, ticks: { maxTicksLimit: 12, font: { size: 10 } } }, y: { beginAtZero: false, ticks: { callback: fmt, maxTicksLimit: 6 }, grid: { color: '#eee' } } }
    })
  });
}

function barsPlain(id, rows, { color = Y, fmt = v => v.toFixed(1), name = 'Value', filterKey } = {}) {
  if (!rows.length) return mk(id, { __empty: true });
  const curF = filterKey ? S.f[filterKey] : 'All';
  const colors = rows.map(r => (curF !== 'All' ? (String(r.k) === String(curF) ? '#1d1d1d' : '#FEEBB4') : color));
  const opts = baseOpts({
    scales: { x: { ...gridless, ticks: { maxRotation: 70, minRotation: 55, autoSkip: false, font: { size: 9 }, callback(v) { return trunc(this.getLabelForValue(v), 16); } } }, y: { display: false, beginAtZero: true } }
  });
  if (filterKey) addBarClick(opts, r => r.k, filterKey);
  mk(id, {
    type: 'bar',
    data: { labels: rows.map(r => r.k), datasets: [{ label: name, data: rows.map(r => r.v), backgroundColor: colors, datalabels: lbl(fmt) }] },
    options: opts
  });
}

// ---------------- aggregation helpers ----------------
function groupBy(arr, kf) {
  const m = new Map();
  for (const o of arr) { const k = kf(o); let g = m.get(k); if (!g) m.set(k, g = { k, rows: [] }); g.rows.push(o); }
  return [...m.values()];
}
const salesAgg = (arr, kf) => groupBy(arr, kf).map(g => {
  const sales = sum(g.rows, o => o.netSales);
  const orders = g.rows.length;
  const disc = sum(g.rows, o => o.discount);
  const receipt = sum(g.rows, o => o.receiptTotal);
  return {
    k: g.k,
    sales,
    orders,
    disc,
    receipt,
    aov: orders ? sales / orders : 0,
    discPctGross: receipt ? (disc / receipt) * 100 : 0,
    discPctNet: sales ? (disc / sales) * 100 : 0,
    discPct: receipt ? (disc / receipt) * 100 : 0
  };
});
const metricOf = (r, metric) => {
  if (metric === 'gross' || metric === 'receipt') return r.receipt;
  if (metric === 'sales' || metric === 'net') return r.sales;
  if (metric === 'orders') return r.orders;
  if (metric === 'aov') return r.aov;
  if (metric === 'disc') return r.disc;
  if (metric === 'discPctGross') return r.discPctGross;
  if (metric === 'discPctNet') return r.discPctNet;
  if (metric === 'discPct') return r.discPctGross;
  return r.sales;
};
const metricFmt = metric => {
  if (metric === 'orders') return cnt;
  if (metric === 'discPct' || metric === 'discPctGross' || metric === 'discPctNet') return n => n.toFixed(1) + '%';
  return money;
};

// ---------------- filtering ----------------
function dateOk(t) { const k = dkey(t); return (!S.f.from || k >= S.f.from) && (!S.f.to || k <= S.f.to); }
const eq = (v, f) => f === 'All' || v === f;
function base(page) {
  const f = S.f;
  return S.orders.filter(o => {
    if (!dateOk(o.receivedAt)) return false;
    if (!eq(o.brand, f.brand) || !eq(o.location, f.location)) return false;
    if (page === 'sales' || page === 'commission' || page === 'ebitda') {
      if (!eq(o.channel, f.channel) || !eq(o.payment, f.payment) || !eq(o.partner, f.partner)) return false;
      if (f.day !== 'All' && dowOf(o.receivedAt) !== f.day) return false;
      if (f.slot && f.slot !== 'All' && slotOf(dubaiHour(o.receivedAt)) !== f.slot) return false;
      if (f.hour != null && f.hour !== 'All' && String(dubaiHour(o.receivedAt)) !== String(f.hour)) return false;
      return true;
    }
    if (page === 'cancel') return eq(o.channel, f.channel) && eq(o.reason, f.reason) && (f.post === 'All' || (f.post === 'Yes') === o.postCancelled);
    return true;
  });
}

// ---------------- filter bar configuration ----------------
const FILTERS = {
  sales: [['dates', 'Received At'], ['channel', 'Channel'], ['brand', 'Brand'], ['location', 'Location'], ['payment', 'Payment Method'], ['day', 'Day Name'], ['partner', 'Delivery Partner']],
  cancel: [['location', 'Location'], ['brand', 'Brand'], ['reason', 'Reason'], ['channel', 'Channel'], ['post', 'Post Cancelled'], ['dates', 'Received At']],
  prep: [['location', 'Location'], ['brand', 'Brand']],
  ratings: [['dates', 'Received At']],
  items: [['location', 'Location'], ['brand', 'Brand'], ['dates', 'Received At']],
  delayed: [['brand', 'Brand'], ['location', 'Branch'], ['dates', 'Received At']],
  commission: [['dates', 'Received At'], ['channel', 'Channel'], ['brand', 'Brand'], ['location', 'Location']],
  ebitda: [['dates', 'Received At'], ['channel', 'Channel'], ['brand', 'Brand'], ['location', 'Location']],
  export: [['dates', 'Received At'], ['brand', 'Brand'], ['location', 'Location']]
};

function optionsFor(key) {
  const src = S.page === 'items' ? S.items : S.orders;
  const get = { channel: o => o.channel, brand: o => o.brand, location: o => o.location, payment: o => o.payment, partner: o => o.partner, reason: o => o.reason };
  if (key === 'day') return DOW;
  if (key === 'post') return ['Yes', 'No'];
  if (key === 'reason') return uniq(S.orders.filter(o => o.cancelled).map(o => o.reason)).sort();
  return uniq(src.map(get[key] || (() => ''))).filter(Boolean).sort();
}

function syncFilterUI() {
  $$('select[data-k]').forEach(s => {
    if (s.dataset.k in S.f) s.value = S.f[s.dataset.k];
  });
}

function getPeriodStats() {
  const ts = S.orders.map(o => o.receivedAt);
  if (!ts.length) return null;
  const latestDate = dkey(Math.max(...ts));
  const [minDate] = fullRange();

  // Today
  const todayOrders = S.orders.filter(o => !o.cancelled && dkey(o.receivedAt) === latestDate);
  const todayNet = sum(todayOrders, o => o.netSales);

  // This Week (from Monday of latestDate)
  const ld = new Date(latestDate + 'T00:00:00');
  const dow = (ld.getDay() + 6) % 7;
  const ws = new Date(ld);
  ws.setDate(ld.getDate() - dow);
  const weekStart = dkey(ws);
  const weekOrders = S.orders.filter(o => !o.cancelled && dkey(o.receivedAt) >= weekStart && dkey(o.receivedAt) <= latestDate);
  const weekNet = sum(weekOrders, o => o.netSales);

  // Previous Month (the full prior calendar month, not month-to-date)
  const [ly, lm] = latestDate.slice(0, 7).split('-').map(Number);
  const prevMonthEndDate = new Date(ly, lm - 1, 0);
  const monthEnd = `${prevMonthEndDate.getFullYear()}-${pad(prevMonthEndDate.getMonth() + 1)}-${pad(prevMonthEndDate.getDate())}`;
  const monthStart = monthEnd.slice(0, 7) + '-01';
  const monthOrders = S.orders.filter(o => !o.cancelled && dkey(o.receivedAt) >= monthStart && dkey(o.receivedAt) <= monthEnd);
  const monthNet = sum(monthOrders, o => o.netSales);

  // All Time
  const allOrders = S.orders.filter(o => !o.cancelled);
  const allNet = sum(allOrders, o => o.netSales);

  return {
    latestDate,
    weekStart,
    monthStart,
    monthEnd,
    minDate,
    today: { count: todayOrders.length, net: todayNet },
    week: { count: weekOrders.length, net: weekNet },
    month: { count: monthOrders.length, net: monthNet },
    all: { count: allOrders.length, net: allNet }
  };
}

function getDefaultPeriod() {
  const st = getPeriodStats();
  if (!st) return fullRange();
  return [st.latestDate, st.latestDate];
}

function buildFilters() {
  const targetId = S.page === 'prep' ? 'filters-prep' : `filters-${S.page}`;
  const el = $('#' + targetId); if (!el) return;
  el.innerHTML = '';
  const list = FILTERS[S.page] || [];

  list.forEach(([key, label]) => {
    const d = document.createElement('div');
    if (key === 'dates') {
      const stats = getPeriodStats();
      const isToday = stats && S.f.from === stats.latestDate && S.f.to === stats.latestDate;
      const isWeek = stats && S.f.from === stats.weekStart && S.f.to === stats.latestDate;
      const isMonth = stats && S.f.from === stats.monthStart && S.f.to === stats.monthEnd;
      const isAll = stats && S.f.from === stats.minDate && S.f.to === stats.latestDate;

      d.className = 'fbox dates';
      d.innerHTML = `
        <label>${label} <span class="chevron">⌄</span></label>
        ${stats ? `
        <div class="period-pill-row">
          <button type="button" class="pp-btn${isToday ? ' on' : ''}" data-p="today" title="Today (${stats.latestDate}): ${stats.today.count} orders · ${money(stats.today.net)} Net">Today</button>
          <button type="button" class="pp-btn${isWeek ? ' on' : ''}" data-p="week" title="This Week (${stats.weekStart} to ${stats.latestDate}): ${stats.week.count} orders · ${money(stats.week.net)} Net">Week</button>
          <button type="button" class="pp-btn${isMonth ? ' on' : ''}" data-p="month" title="Previous Month (${stats.monthStart} to ${stats.monthEnd}): ${stats.month.count} orders · ${money(stats.month.net)} Net">Month</button>
          <button type="button" class="pp-btn${isAll ? ' on' : ''}" data-p="all" title="All Time (${stats.minDate} to ${stats.latestDate}): ${stats.all.count} orders · ${money(stats.all.net)} Net">All</button>
        </div>` : ''}
        <div class="date-inputs">
          <input type="date" id="fFrom" value="${S.f.from}">
          <input type="date" id="fTo" value="${S.f.to}">
        </div>
        <div class="dual-slider">
          <div class="slider-track"><div class="slider-bar" id="dateBar"></div></div>
          <input type="range" id="slFrom" min="0" max="1000" value="0">
          <input type="range" id="slTo" min="0" max="1000" value="1000">
        </div>
      `;

      d.querySelectorAll('.pp-btn').forEach(btn => {
        btn.onclick = () => {
          const p = btn.dataset.p;
          const st = getPeriodStats();
          if (!st) return;
          if (p === 'today') setDates(st.latestDate, st.latestDate);
          else if (p === 'week') setDates(st.weekStart, st.latestDate);
          else if (p === 'month') setDates(st.monthStart, st.monthEnd);
          else if (p === 'all') setDates(...fullRange());
          dateChanged();
        };
      });
    } else {
      d.className = 'fbox';
      d.innerHTML = `<label>${label} <span class="chevron">⌄</span></label><select data-k="${key}"><option>All</option>${optionsFor(key).map(o => `<option${S.f[key] === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    el.appendChild(d);
  });

  $$('select', el).forEach(s => s.onchange = () => { S.f[s.dataset.k] = s.value; render(); });
  initDateSlider();
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let dateTimer;
function dateChanged() {
  if (S.source === 'live' && S.f.from && S.f.to && S.loadedRange && (S.f.from < S.loadedRange[0] || S.f.to > S.loadedRange[1])) {
    clearTimeout(dateTimer); dateTimer = setTimeout(() => loadLive(S.f.from, S.f.to), 500);
  }
  render();
}

// ---------------- dual date range slider ----------------
function initDateSlider() {
  const [minD, maxD] = fullRange();
  if (!minD || !maxD) return;
  const tMin = new Date(minD + 'T00:00:00').getTime();
  const tMax = new Date(maxD + 'T00:00:00').getTime();
  const span = Math.max(tMax - tMin, 864e5);

  const targetId = S.page === 'prep' ? 'filters-prep' : 'filters-' + S.page;
  const root = $('#' + targetId) || document;
  const fr = $('#fFrom', root) || $('#fFrom');
  const to = $('#fTo', root) || $('#fTo');
  const slFr = $('#slFrom', root) || $('#slFrom');
  const slTo = $('#slTo', root) || $('#slTo');
  const bar = $('#dateBar', root) || $('#dateBar');
  if (!fr || !slFr || !to || !slTo) return;

  function syncPillButtons() {
    const stats = getPeriodStats();
    if (!stats) return;
    $$('.pp-btn').forEach(btn => {
      const p = btn.dataset.p;
      const on = (p === 'today' && S.f.from === stats.latestDate && S.f.to === stats.latestDate) ||
                 (p === 'week' && S.f.from === stats.weekStart && S.f.to === stats.latestDate) ||
                 (p === 'month' && S.f.from === stats.monthStart && S.f.to === stats.monthEnd) ||
                 (p === 'all' && S.f.from === stats.minDate && S.f.to === stats.latestDate);
      btn.classList.toggle('on', !!on);
    });
  }

  function updateBar() {
    const p1 = Math.min(+slFr.value, +slTo.value);
    const p2 = Math.max(+slFr.value, +slTo.value);
    if (bar) {
      bar.style.left = (p1 / 10) + '%';
      bar.style.width = ((p2 - p1) / 10) + '%';
    }
    syncPillButtons();
  }

  function syncFromDates() {
    const curFr = fr.value ? new Date(fr.value + 'T00:00:00').getTime() : tMin;
    const curTo = to.value ? new Date(to.value + 'T00:00:00').getTime() : tMax;
    slFr.value = Math.max(0, Math.min(1000, Math.round(((curFr - tMin) / span) * 1000)));
    slTo.value = Math.max(0, Math.min(1000, Math.round(((curTo - tMin) / span) * 1000)));
    updateBar();
  }

  slFr.oninput = () => {
    if (+slFr.value > +slTo.value) slFr.value = slTo.value;
    const t = tMin + (+slFr.value / 1000) * span;
    S.f.from = dkey(t); fr.value = S.f.from;
    updateBar();
    dateChanged();
  };
  slTo.oninput = () => {
    if (+slTo.value < +slFr.value) slTo.value = slFr.value;
    const t = tMin + (+slTo.value / 1000) * span;
    S.f.to = dkey(t); to.value = S.f.to;
    updateBar();
    dateChanged();
  };

  fr.onchange = () => { S.f.from = fr.value; syncFromDates(); dateChanged(); };
  to.onchange = () => { S.f.to = to.value; syncFromDates(); dateChanged(); };

  syncFromDates();
}

// ---------------- sidebar toggles ----------------
function buildToggles() {
  const top = $('#sideTogglesTop'), btm = $('#sideTogglesBottom');
  top.innerHTML = ''; btm.innerHTML = '';

  const add = (target, cap, key, opts) => {
    target.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`);
    opts.forEach(([v, t]) => {
      const b = document.createElement('button');
      b.className = 'tg' + (S.ui[key] === v ? ' on' : '');
      b.textContent = t;
      b.onclick = () => { S.ui[key] = v; buildToggles(); render(); };
      target.appendChild(b);
    });
  };

  switch (S.page) {
    case 'sales':
      add(top, 'Sales Metric', 'metric', [['gross', 'Gross Sales'], ['sales', 'Net Sales'], ['orders', 'Total Orders']]);
      add(btm, 'Brand | Cuisine', 'group', [['cuisine', 'Cuisine'], ['brand', 'Brand']]);
      break;
    case 'cancel':
      add(btm, 'Cancelled Amt | Orders', 'cmetric', [['value', 'Orders Value'], ['orders', 'Cancelled Orders']]);
      add(btm, 'Cancelled Orders Brand | Cuisine', 'cgroup', [['brand', 'Brand'], ['cuisine', 'Cuisine Cluster']]);
      break;
    case 'prep':
      add(top, 'Prep Time Brand | Cuisine', 'pgroup', [['brand', 'Brand'], ['cuisine', 'Cuisine Cluster']]);
      break;
    case 'ratings':
      add(top, '- Ratings Brand | Cuisine', 'rgroup', [['brand', 'Brand'], ['cuisine', 'Cuisine Cluster']]);
      add(top, 'Rating Mode', 'rmode', [['estimated', 'Operational (Live)'], ['strict', 'External Aggregator']]);
      break;
    case 'items':
      add(top, '86 Items | Item Sales', 'itemsView', [['86', '86 Items'], ['sales', 'Item Sales']]);
      add(btm, '86 by Brands | Cuisine', 'igroup', [['brand', 'Brand'], ['cuisine', 'Cuisine Cluster']]);
      break;
    case 'delayed':
      add(btm, 'Delayed By Brands | Cuisine', 'dgroup', [['brand', 'Brand'], ['cuisine', 'Cuisine Cluster']]);
      break;
  }
}

// ---------------- KPI card renderer ----------------
function kpis(id, list) {
  const container = $('#' + id);
  if (!container) return;
  const prevVals = {}, prevActive = {};
  container.querySelectorAll('.kpi').forEach(el => {
    const h = $('.kh', el), v = $('.kv', el);
    if (h && v) { prevVals[h.textContent] = v.textContent; prevActive[h.textContent] = el.classList.contains('active'); }
  });

  container.innerHTML = list.map(([h, v, wide, , isActive, tooltip, kind], idx) => {
    const act = isActive ? ' active' : '';
    const kindCls = kind && kind !== 'filter' ? ` kpi--${kind}` : '';
    const tip = tooltip ? ` title="${esc(tooltip)}"` : ' title="Click to filter/reflect data"';
    return `<div class="kpi${wide ? ' wide' : ''}${act}${kindCls}" data-idx="${idx}"${tip} role="button" tabindex="0">
      <div class="kh">${h}</div>
      <div class="kv">${v}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('.kpi').forEach(el => {
    const idx = +el.dataset.idx;
    const item = list[idx];
    if (item && typeof item[3] === 'function') {
      const handler = (e) => {
        e.stopPropagation();
        item[3]();
      };
      el.onclick = handler;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(e); } };
    }
    const h = $('.kh', el), v = $('.kv', el);
    if (h && v && prevVals[h.textContent] !== undefined && prevVals[h.textContent] !== v.textContent) {
      v.classList.add('kv-bump');
    }
    if (h && el.classList.contains('active') && prevActive[h.textContent] === false) {
      el.classList.add('kpi-activate');
    }
  });
}

// ================= PAGE 1: SALES =================
const SLOTS = [['Breakfast', 6, 10], ['Lunch', 11, 14], ['Afternoon Snack', 15, 17], ['Dinner', 18, 21], ['Late Night', 22, 23], ['Overnight', 0, 5]];
const slotOf = h => (SLOTS.find(s => h >= s[1] && h <= s[2]) || SLOTS[5])[0];
const todOf = h => (h >= 5 && h < 12 ? 'Morning' : h >= 12 && h < 17 ? 'Afternoon' : h >= 17 && h < 21 ? 'Evening' : 'Night');
const grainKey = { Daily: t => dkey(t), Weekly: t => { const d = new Date(t); const x = new Date(d); x.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dkey(x); }, Monthly: t => dkey(t).slice(0, 7), Quarterly: t => { const d = new Date(t); return d.getFullYear() + ' Q' + (Math.floor(d.getMonth() / 3) + 1); }, Yearly: t => String(new Date(t).getFullYear()) };

function timeRangeForGrain(key, grain) {
  if (grain === 'Daily') return [key, key];
  if (grain === 'Weekly') {
    const start = new Date(key + 'T00:00:00');
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return [dkey(start), dkey(end)];
  }
  if (grain === 'Monthly') {
    const [y, m] = key.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return [dkey(start), dkey(end)];
  }
  if (grain === 'Quarterly') {
    const [y, qStr] = key.split(' Q');
    const q = Number(qStr);
    const start = new Date(+y, (q - 1) * 3, 1);
    const end = new Date(+y, q * 3, 0);
    return [dkey(start), dkey(end)];
  }
  if (grain === 'Yearly') {
    return [`${key}-01-01`, `${key}-12-31`];
  }
  return [key, key];
}

function openDailyBreakdownModal() {
  S.ui.grain = 'Daily';
  renderSales();
  const modal = $('#dailyModal');
  if (modal) {
    renderDailyBreakdownTable();
    modal.hidden = false;
  }
  const el = document.getElementById('c-time');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const p = el.closest('.panel') || el;
    p.style.transition = 'all 0.3s ease';
    p.style.outline = '3px solid #FDCB3C';
    p.style.boxShadow = '0 0 16px rgba(253, 203, 60, 0.6)';
    setTimeout(() => { p.style.outline = ''; p.style.boxShadow = ''; }, 1600);
  }
}

function renderDailyBreakdownTable() {
  const all = base('sales'); const O = all.filter(o => !o.cancelled);
  const byDay = groupBy(O, o => dkey(o.receivedAt)).map(g => {
    const gross = sum(g.rows, o => o.receiptTotal);
    const net = sum(g.rows, o => o.netSales);
    const disc = sum(g.rows, o => o.discount);
    const count = g.rows.length;
    const aov = count ? net / count : 0;
    const discPctGross = gross ? (disc / gross) * 100 : 0;
    const discPctNet = net ? (disc / net) * 100 : 0;
    return {
      date: g.k,
      dow: dowOf(g.rows[0].receivedAt),
      gross,
      net,
      disc,
      count,
      aov,
      discPctGross,
      discPctNet
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));

  const tbl = $('#dailyBreakdownTable');
  if (!tbl) return;

  const totalGross = sum(byDay, d => d.gross);
  const totalNet = sum(byDay, d => d.net);
  const totalOrders = sum(byDay, d => d.count);
  const totalDisc = sum(byDay, d => d.disc);
  const totalAov = totalOrders ? totalNet / totalOrders : 0;
  const totDiscGross = totalGross ? (totalDisc / totalGross) * 100 : 0;
  const totDiscNet = totalNet ? (totalDisc / totalNet) * 100 : 0;

  tbl.innerHTML = `
    <thead>
      <tr>
        <th style="text-align:left;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Trading Date</th>
        <th style="text-align:left;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Day</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Gross Sales</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Net Sales</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Orders</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">AOV</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Discount</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Disc % (Gross)</th>
        <th style="text-align:right;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Disc % (Net)</th>
        <th style="text-align:center;position:sticky;top:0;background:#FCD258;color:#000;padding:6px;z-index:2">Cross-Filter</th>
      </tr>
      <tr style="background:#1d1d1d;color:#FCD258;font-weight:700">
        <td style="text-align:left;padding:6px">TOTAL (${byDay.length} Days)</td>
        <td style="padding:6px">–</td>
        <td style="text-align:right;padding:6px">${money(totalGross)}</td>
        <td style="text-align:right;padding:6px">${money(totalNet)}</td>
        <td style="text-align:right;padding:6px">${cnt(totalOrders)}</td>
        <td style="text-align:right;padding:6px">${money(totalAov)}</td>
        <td style="text-align:right;padding:6px">${money(totalDisc)}</td>
        <td style="text-align:right;padding:6px">${totDiscGross.toFixed(1)}%</td>
        <td style="text-align:right;padding:6px">${totDiscNet.toFixed(1)}%</td>
        <td style="text-align:center;padding:6px">–</td>
      </tr>
    </thead>
    <tbody>
      ${byDay.map((d, i) => {
        const isSlice = S.f.from === d.date && S.f.to === d.date;
        return `
          <tr class="daily-row" data-date="${d.date}" style="cursor:pointer;background:${isSlice ? '#FFFDF2' : (i % 2 ? '#fafafa' : '#fff')};outline:${isSlice ? '2px solid #b38600' : 'none'}">
            <td style="font-weight:600;color:${isSlice ? '#b38600' : '#1d1d1d'};padding:6px">${isSlice ? '● ' : ''}${d.date}</td>
            <td style="padding:6px">${d.dow}</td>
            <td style="text-align:right;font-weight:600;padding:6px">${money(d.gross)}</td>
            <td style="text-align:right;font-weight:700;color:#000;padding:6px">${money(d.net)}</td>
            <td style="text-align:right;padding:6px">${cnt(d.count)}</td>
            <td style="text-align:right;padding:6px">${money(d.aov)}</td>
            <td style="text-align:right;color:#777;padding:6px">${money(d.disc)}</td>
            <td style="text-align:right;font-weight:600;color:#2e7d32;padding:6px">${d.discPctGross.toFixed(1)}%</td>
            <td style="text-align:right;font-weight:600;color:${d.discPctNet > 50 ? '#ee2a5c' : '#555'};padding:6px">${d.discPctNet.toFixed(1)}%</td>
            <td style="text-align:center;padding:6px"><button class="btn-yellow" style="padding:2px 8px;font-size:10px">${isSlice ? 'Clear' : 'Slice'}</button></td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;

  tbl.querySelectorAll('.daily-row').forEach(tr => {
    const dt = tr.dataset.date;
    tr.onclick = () => {
      if (S.f.from === dt && S.f.to === dt) {
        setDates(...fullRange());
      } else {
        setDates(dt, dt);
      }
      dateChanged();
      renderDailyBreakdownTable();
    };
  });
}

// ---------------- generic KPI drill-down modal ----------------
// Shared shell for every drill-down below. Each one follows the same proven
// shape as openDailyBreakdownModal()/renderDailyBreakdownTable() above: an
// open*() that shows the modal, and an idempotent render*Body() that row
// clicks self-invoke again after changing a filter, so the modal always
// repaints from live state instead of a stale closure.
function openKpiModal(title, subtitle) {
  $('#kpiModalTitle').textContent = title;
  $('#kpiModalSubtitle').textContent = subtitle || '';
  const modal = $('#kpiModal');
  if (modal) modal.hidden = false;
}

function openCommissionDrillModal() {
  renderCommissionDrillBody();
  openKpiModal('Commission by Channel', 'Click a channel to cross-filter the whole Commission page by it.');
}
function renderCommissionDrillBody() {
  const body = $('#kpiModalBody');
  if (!body) return;
  const { net, commission, chanAgg } = commissionChannelAgg();
  const rows = chanAgg.slice().sort((a, b) => b.commission - a.commission);
  const totOrders = sum(rows, r => r.orders);
  body.innerHTML = `
    <div class="a-ratecard">
      <table>
        <thead><tr><th>Channel</th><th style="text-align:right">Orders</th><th style="text-align:right">Net Sales</th><th style="text-align:right">Commission</th><th style="text-align:right">Eff. Rate</th><th style="text-align:center">Cross-Filter</th></tr></thead>
        <tbody>
          <tr style="background:#1d1d1d;color:#FCD258;font-weight:700">
            <td>TOTAL</td><td style="text-align:right">${cnt(totOrders)}</td><td style="text-align:right">${money(net)}</td><td style="text-align:right">${money(commission)}</td><td style="text-align:right">${net ? pc(commission / net, 1) : '0%'}</td><td style="text-align:center">–</td>
          </tr>
          ${rows.map(r => {
            const isActive = S.f.channel === r.k;
            return `<tr class="kpi-drill-row" data-channel="${esc(r.k)}" style="cursor:pointer;background:${isActive ? '#FFFDF2' : '#fff'};transition:background-color .15s ease">
              <td style="font-weight:600;${isActive ? 'color:#b38600' : ''}">${isActive ? '● ' : ''}${esc(r.k)}</td>
              <td style="text-align:right">${cnt(r.orders)}</td>
              <td style="text-align:right">${money(r.netSales)}</td>
              <td style="text-align:right;font-weight:600">${money(r.commission)}</td>
              <td style="text-align:right">${(r.effRate * 100).toFixed(1)}%</td>
              <td style="text-align:center"><button class="btn-yellow" style="padding:2px 8px;font-size:10px">${isActive ? 'Clear' : 'Filter'}</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  body.querySelectorAll('.kpi-drill-row').forEach(tr => {
    const ch = tr.dataset.channel;
    tr.onclick = () => {
      S.f.channel = (S.f.channel === ch ? 'All' : ch);
      syncFilterUI();
      renderCommission();
      renderCommissionDrillBody();
    };
  });
}

function openEbitdaDrillModal() {
  renderEbitdaDrillBody();
  openKpiModal('P&L Waterfall — Gross Sales to EBITDA', 'Read-only summary for the current filter and date range.');
}
function renderEbitdaDrillBody() {
  const body = $('#kpiModalBody');
  if (!body || !lastPL) return;
  const net = lastPL.net;
  body.innerHTML = `
    <div class="a-plwaterfall">
      <table>
        <thead><tr><th>Line</th><th>AED</th><th>% of Net Sales</th></tr></thead>
        <tbody>
          ${lastPL.rows.map(r => `<tr class="${r.cls}"><td>${esc(r.label)}</td><td class="cost-amt">${money(r.amount)}</td><td class="cost-amt">${net ? pc(r.amount / net, 1) : '–'}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="pl-memo">Prime Cost (COGS + Labor): ${money(lastPL.primeCost)} — ${net ? pc(lastPL.primeCost / net, 1) : '0%'} of Net Sales</div>
    </div>`;
}

function openItemSalesDrillModal() {
  renderItemSalesDrillBody();
  openKpiModal('Item Sales — Daily Breakdown', 'Click a day to slice Item Sales (and the whole dashboard) to that date.');
}
function renderItemSalesDrillBody() {
  const body = $('#kpiModalBody');
  if (!body) return;
  const { soldBase, revenueOf } = itemSalesBase();
  const I = soldBase.filter(x => dateOk(x.at));
  const byDay = groupBy(I, x => dkey(x.at)).map(g => {
    const qty = sum(g.rows, x => x.qty);
    const revenue = sum(g.rows, revenueOf);
    const orders = uniq(g.rows.map(x => x.orderId)).length;
    return { date: g.k, qty, revenue, orders, avg: orders ? qty / orders : 0 };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
  const totQty = sum(byDay, d => d.qty);
  const totRevenue = sum(byDay, d => d.revenue);
  const totOrders = sum(byDay, d => d.orders);
  body.innerHTML = `
    <div class="tbl-wrap">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr><th>Date</th><th style="text-align:right">Items Sold</th><th style="text-align:right">Items Net Sales</th><th style="text-align:right">Orders</th><th style="text-align:right">Avg Items/Order</th><th style="text-align:center">Cross-Filter</th></tr></thead>
        <tbody>
          <tr style="background:#1d1d1d;color:#FCD258;font-weight:700">
            <td>TOTAL (${byDay.length} Days)</td><td style="text-align:right">${cnt(totQty)}</td><td style="text-align:right">${money(totRevenue)}</td><td style="text-align:right">${cnt(totOrders)}</td><td style="text-align:right">${totOrders ? (totQty / totOrders).toFixed(2) : '0'}</td><td style="text-align:center">–</td>
          </tr>
          ${byDay.map(d => {
            const isSlice = S.f.from === d.date && S.f.to === d.date;
            return `<tr class="kpi-drill-row" data-date="${d.date}" style="cursor:pointer;background:${isSlice ? '#FFFDF2' : '#fff'};transition:background-color .15s ease">
              <td style="font-weight:600;${isSlice ? 'color:#b38600' : ''}">${isSlice ? '● ' : ''}${d.date}</td>
              <td style="text-align:right">${cnt(d.qty)}</td>
              <td style="text-align:right;font-weight:600">${money(d.revenue)}</td>
              <td style="text-align:right">${cnt(d.orders)}</td>
              <td style="text-align:right">${d.avg.toFixed(2)}</td>
              <td style="text-align:center"><button class="btn-yellow" style="padding:2px 8px;font-size:10px">${isSlice ? 'Clear' : 'Slice'}</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
  body.querySelectorAll('.kpi-drill-row').forEach(tr => {
    const dt = tr.dataset.date;
    tr.onclick = () => {
      if (S.f.from === dt && S.f.to === dt) setDates(...fullRange()); else setDates(dt, dt);
      dateChanged();
      renderItemSalesDrillBody();
    };
  });
}

function renderSales() {
  const all = base('sales'); const O = all.filter(o => !o.cancelled);
  const net = sum(O, o => o.netSales), rec = sum(O, o => o.receiptTotal), disc = sum(O, o => o.discount), n = O.length;
  const days = uniq(O.map(o => dkey(o.receivedAt))).length || 1;
  const run = net / days;
  const top = salesAgg(O, o => o.brand).sort((a, b) => b.sales - a.sales)[0];

  const m = S.ui.metric;
  const mnameMap = {
    gross: 'Gross Sales',
    sales: 'Net Sales',
    orders: 'Total Orders',
    receipt: 'Gross Sales',
    aov: 'Average Order Value (AOV)',
    disc: 'Total Discount',
    discPct: 'Discount % (Gross)',
    discPctGross: 'Discount % (Gross)',
    discPctNet: 'Discount % (Net)'
  };
  const mname = mnameMap[m] || (m === 'gross' ? 'Gross Sales' : 'Net Sales');
  const mf = metricFmt(m);
  const isDailyActive = S.ui.grain === 'Daily';

  kpis('kpi-sales', [
    ['Gross Sales', money(rec), false, () => {
      S.ui.metric = (m === 'gross' || m === 'receipt' ? 'sales' : 'gross');
      buildToggles();
      renderSales();
    }, m === 'gross' || m === 'receipt', 'Click to switch all dashboard charts and metrics to Gross Sales (GMV before discount)'],

    ['Net Sales', money(net), false, () => {
      S.ui.metric = 'sales';
      buildToggles();
      renderSales();
    }, m === 'sales', 'Click to switch all dashboard charts and metrics to Net Sales (after discount)'],

    ['Total Orders', cnt(n), false, () => {
      S.ui.metric = 'orders';
      buildToggles();
      renderSales();
    }, m === 'orders', 'Click to view Order Volume counts across all charts'],

    ['AOV', n ? (net / n).toFixed(2) : '0', false, () => {
      S.ui.metric = (m === 'aov' ? 'sales' : 'aov');
      buildToggles();
      renderSales();
    }, m === 'aov', 'Click to view Average Order Value (AOV) across all charts'],

    ['Total Discount', money(disc), false, () => {
      S.ui.metric = (m === 'disc' ? 'sales' : 'disc');
      buildToggles();
      renderSales();
      const el = document.getElementById('c-disc');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, m === 'disc', 'Click to view Total Discounts across all charts'],

    ['Disc % (Gross)', rec ? pc(disc / rec, 1) : '0%', false, () => {
      S.ui.metric = (m === 'discPctGross' ? 'sales' : 'discPctGross');
      buildToggles();
      renderSales();
    }, m === 'discPctGross', 'Click to view Discount as % of Gross Sales: Total Discount / Gross Sales'],

    ['Disc % (Net)', net ? pc(disc / net, 1) : '0%', false, () => {
      S.ui.metric = (m === 'discPctNet' ? 'sales' : 'discPctNet');
      buildToggles();
      renderSales();
    }, m === 'discPctNet', 'Click to view Discount as % of Net Sales: Total Discount / Net Sales'],

    ['Daily Sales Breakdown', `${money(run)}/d`, false, () => {
      openDailyBreakdownModal();
    }, isDailyActive, `Click to open interactive Daily Sales Breakdown table and switch charts to Daily grain (Avg ${money(run)}/day over ${days} days)`, 'drill'],

    ['Top Performing Brand', top ? esc(top.k) : '–', true, () => {
      if (!top) return;
      if (S.f.brand === top.k) {
        S.f.brand = 'All';
      } else {
        S.f.brand = top.k;
      }
      syncFilterUI();
      render();
    }, top && S.f.brand === top.k, top ? `Click to filter dashboard for "${top.k}" (click again to reset)` : '']
  ]);

  const grpName = S.ui.group === 'brand' ? 'Brands' : 'Cuisines';
  $('#t-brand').textContent = `${grpName} by ${mname}`;
  const br = salesAgg(O, o => gk(o, S.ui.group)).map(r => ({ k: r.k, v: metricOf(r, m) })).sort((a, b) => b.v - a.v).slice(0, 14);
  
  const curBrand = S.f[S.ui.group === 'brand' ? 'brand' : 'cuisine'];
  const bColors = br.map(r => (curBrand !== 'All' ? (String(r.k) === String(curBrand) ? '#1d1d1d' : '#FEEBB4') : Y));
  const bOpts = baseOpts({
    scales: { x: { ...gridless, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 12); } } }, y: { display: false, beginAtZero: true } }
  });
  addBarClick(bOpts, r => r.k, S.ui.group === 'brand' ? 'brand' : 'cuisine');
  mk('c-brand', br.length ? {
    type: 'bar',
    data: { labels: br.map(r => r.k), datasets: [{ label: mname, data: br.map(r => r.v), backgroundColor: bColors, datalabels: lbl(mf) }] },
    options: bOpts
  } : { __empty: true });

  // grain switcher
  const gs = $('#grainSeg'); gs.innerHTML = '';
  Object.keys(grainKey).forEach(g => {
    const b = document.createElement('button');
    b.textContent = g;
    if (S.ui.grain === g) b.className = 'on';
    b.onclick = () => { S.ui.grain = g; renderSales(); };
    gs.appendChild(b);
  });

  const phTime = $('#t-time');
  if (phTime) {
    phTime.textContent = `${mname} Over time`;
    phTime.style.cursor = 'pointer';
    phTime.title = `Currently viewing ${mname}. Click to toggle Gross Sales | Net Sales | Total Orders`;
    phTime.onclick = () => {
      if (S.ui.metric === 'gross') S.ui.metric = 'sales';
      else if (S.ui.metric === 'sales') S.ui.metric = 'orders';
      else S.ui.metric = 'gross';
      buildToggles();
      renderSales();
    };
  }
  const f = S.f;
  const timeOrders = S.orders.filter(o => {
    if (o.cancelled) return false;
    if (!eq(o.brand, f.brand) || !eq(o.location, f.location)) return false;
    if (!eq(o.channel, f.channel) || !eq(o.payment, f.payment) || !eq(o.partner, f.partner)) return false;
    if (f.day !== 'All' && dowOf(o.receivedAt) !== f.day) return false;
    if (f.slot && f.slot !== 'All' && slotOf(dubaiHour(o.receivedAt)) !== f.slot) return false;
    if (f.hour != null && f.hour !== 'All' && String(dubaiHour(o.receivedAt)) !== String(f.hour)) return false;
    return true;
  });
  const ts = salesAgg(timeOrders, o => grainKey[S.ui.grain](o.receivedAt)).sort((a, b) => (a.k < b.k ? -1 : 1));

  const timeBarColors = ts.map(r => {
    const [f, t] = timeRangeForGrain(r.k, S.ui.grain);
    const isActive = S.f.from === f && S.f.to === t;
    return isActive ? '#1d1d1d' : Y;
  });

  const tOpts = baseOpts({
    onHover: (e, el) => {
      if (e.native && e.native.target) {
        e.native.target.style.cursor = el && el.length ? 'pointer' : 'default';
      }
    },
    onClick: (e, elements, chart) => {
      if (!elements || !elements.length) return;
      const idx = elements[0].index;
      const label = chart ? chart.data.labels[idx] : ts[idx]?.k;
      if (!label) return;
      const [f, t] = timeRangeForGrain(label, S.ui.grain);
      if (S.f.from === f && S.f.to === t) {
        setDates(...fullRange());
      } else {
        setDates(f, t);
      }
      dateChanged();
    },
    scales: {
      x: { ...gridless, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { callback: mf, maxTicksLimit: 5 }, grid: { color: '#eee' }, title: { display: true, text: mname } }
    }
  });

  mk('c-time', ts.length ? {
    type: 'bar',
    data: {
      labels: ts.map(r => r.k),
      datasets: [{
        label: mname,
        data: ts.map(r => metricOf(r, m)),
        backgroundColor: timeBarColors,
        datalabels: ts.length > 20 ? { display: false } : lbl(mf)
      }]
    },
    options: tOpts
  } : { __empty: true });

  const loc = salesAgg(O, o => o.location).sort((a, b) => metricOf(b, m) - metricOf(a, m)).slice(0, 10).map(r => ({ k: r.k, v: metricOf(r, m), orders: r.orders }));
  combo('c-loc', loc, { name: mname, pctName: '%GT Total Orders', filterKey: 'location', fmt: mf });
  patchPct('c-loc', loc, n);

  const sl = salesAgg(O, o => slotOf(dubaiHour(o.receivedAt))).sort((a, b) => metricOf(b, m) - metricOf(a, m));
  combo('c-slot', sl.map(r => ({ k: r.k, v: metricOf(r, m) })), { name: mname, pctName: '%GT Total Orders', filterKey: 'slot', fmt: mf });
  patchPct('c-slot', sl, n);

  hbar('c-chan', salesAgg(O, o => o.channel).map(r => ({ k: r.k, v: metricOf(r, m) })).sort((a, b) => b.v - a.v), { fmt: mf, name: mname, filterKey: 'channel' });

  // date & time of day
  const tods = ['Morning', 'Afternoon', 'Evening', 'Night'];
  const cols = { Morning: K, Afternoon: Y, Evening: '#ff7043', Night: '#1e88e5' };
  const dates = uniq(O.map(o => dkey(o.receivedAt))).sort();
  const tmap = {};
  O.forEach(o => {
    const k = todOf(dubaiHour(o.receivedAt)) + '|' + dkey(o.receivedAt);
    tmap[k] = (tmap[k] || 0) + (m === 'orders' ? 1 : (m === 'gross' || m === 'receipt') ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
  });
  lineChart('c-tod', dates, tods.map(t => ({ name: t, color: cols[t], data: dates.map(d => tmap[t + '|' + d] || 0) })), { fmt: mf });

  const hr = Array.from({ length: 24 }, (_, h) => ({ k: String(h), v: 0, o: 0 }));
  O.forEach(o => {
    const h = dubaiHour(o.receivedAt);
    hr[h].v += (m === 'orders' ? 1 : (m === 'gross' || m === 'receipt') ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
    hr[h].o++;
  });
  combo('c-hour', hr, { name: mname, pctName: '%GT Total Orders', filterKey: 'hour', fmt: mf });
  patchPct('c-hour', hr.map(h => ({ orders: h.o })), n);

  const dw = DOW.map(d => ({ k: d, v: 0, o: 0 }));
  O.forEach(o => {
    const i = (dubaiDOW(o.receivedAt) + 6) % 7;
    dw[i].v += (m === 'orders' ? 1 : (m === 'gross' || m === 'receipt') ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
    dw[i].o++;
  });
  combo('c-dow', dw, { name: mname, pctName: '%GT Total Orders', filterKey: 'day', fmt: mf });
  patchPct('c-dow', dw.map(d => ({ orders: d.o })), n);

  const dc = salesAgg(O, o => o.channel).filter(r => r.disc > 0).sort((a, b) => b.disc - a.disc).map(r => ({ k: r.k, v: r.disc }));
  donut('c-disc', dc, { legend: 'left', filterKey: 'channel' });
  const discGrossPct = rec ? pc(disc / rec, 1) : '0%';
  const discNetPct = net ? pc(disc / net, 1) : '0%';
  $('#discTotal').innerHTML = `${money(disc)}<div style="font-size:9.5px;font-weight:600;color:#555;margin-top:2px;">${discGrossPct} Gross · ${discNetPct} Net</div>`;
}

function patchPct(id, rows, totalOrders) {
  const c = charts[id]; if (!c || !c.data.datasets[1]) return;
  c.data.datasets[1].data = rows.map(r => (totalOrders ? (r.orders / totalOrders) * 100 : 0));
  c.update('none');
}

// ================= PAGE 2: CANCELLATIONS =================
function renderCancel() {
  const C = base('cancel').filter(o => o.cancelled);
  const amt = sum(C, o => o.receiptTotal), n = C.length;
  const val = S.ui.cmetric === 'value';
  const mv = r => (val ? r.receipt : r.orders);
  const lbf = val ? money : cnt;
  kpis('kpi-cancel', [
    ['Cancelled Orders Amount', money(amt), false, () => { S.ui.cmetric = 'value'; buildToggles(); renderCancel(); }, val, 'Click to view Cancelled Orders Value in AED across all charts'],
    ['Total Cancelled Orders', cnt(n), false, () => { S.ui.cmetric = 'orders'; buildToggles(); renderCancel(); }, !val, 'Click to view Cancelled Orders Count volume across all charts'],
    ['AOV', n ? (amt / n).toFixed(2) : '0', false, () => { S.f.post = (S.f.post === 'Yes' ? 'All' : 'Yes'); syncFilterUI(); renderCancel(); }, S.f.post === 'Yes', 'Click to filter Post-Cancelled orders (direct kitchen food waste)']
  ]);

  const mkRows = (kf, lim) => { const rr = salesAgg(C, kf).sort((a, b) => mv(b) - mv(a)); const tot = sum(rr, r => r.orders); return { rows: rr.slice(0, lim), tot }; };
  const fill = (id, kf, lim, filterKey) => {
    const { rows, tot } = mkRows(kf, lim);
    combo(id, rows.map(r => ({ k: r.k, v: mv(r) })), { name: val ? 'Orders Value' : 'Cancelled Orders', pctName: '%GT Cancelled Orders', fmt: lbf, filterKey });
    const c = charts[id]; if (c && c.data.datasets[1]) { c.data.datasets[1].data = rows.map(r => (tot ? r.orders / tot * 100 : 0)); c.update('none'); }
  };
  fill('c-cloc', o => o.location, 8, 'location');
  fill('c-cchan', o => o.channel, 8, 'channel');

  const post = groupBy(C, o => (o.postCancelled ? 'Yes' : 'No')).map(g => ({ k: g.k, v: val ? sum(g.rows, o => o.receiptTotal) : g.rows.length }));
  donut('c-cpost', post, { fmt: lbf, legend: 'bottom', colors: ['#555', Y], filterKey: 'post' });

  $('#t-cbrand').textContent = `Orders Value | Total Orders by ${S.ui.cgroup === 'brand' ? 'Brand' : 'Cuisine'}`;
  hbar('c-cbrand', salesAgg(C, o => gk(o, S.ui.cgroup)).map(r => ({ k: r.k, v: mv(r) })).sort((a, b) => b.v - a.v).slice(0, 14), { fmt: lbf, filterKey: S.ui.cgroup === 'brand' ? 'brand' : 'cuisine' });

  const timeCancel = S.orders.filter(o => {
    if (!o.cancelled) return false;
    if (!eq(o.brand, S.f.brand) || !eq(o.location, S.f.location)) return false;
    if (!eq(o.channel, S.f.channel) || !eq(o.reason, S.f.reason)) return false;
    if (S.f.post !== 'All' && (S.f.post === 'Yes') !== o.postCancelled) return false;
    return true;
  });
  const tr = salesAgg(timeCancel, o => dkey(o.receivedAt)).sort((a, b) => (a.k < b.k ? -1 : 1));
  const tot = n || 1;
  const cBarColors = tr.map(r => {
    const isActive = S.f.from === r.k && S.f.to === r.k;
    return isActive ? '#1d1d1d' : Y;
  });

  const cTrendOpts = baseOpts({
    onHover: (e, el) => {
      if (e.native && e.native.target) {
        e.native.target.style.cursor = el && el.length ? 'pointer' : 'default';
      }
    },
    onClick: (e, elements) => {
      if (!elements || !elements.length) return;
      const idx = elements[0].index;
      const row = tr[idx];
      if (!row) return;
      if (S.f.from === row.k && S.f.to === row.k) {
        setDates(...fullRange());
      } else {
        setDates(row.k, row.k);
      }
      dateChanged();
    },
    plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
    scales: {
      x: { ...gridless, ticks: { maxTicksLimit: 31, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { callback: lbf, maxTicksLimit: 5 }, grid: { color: '#eee' } },
      y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { callback: v => v + '%', maxTicksLimit: 5 } }
    }
  });

  mk('c-ctrend', tr.length ? {
    type: 'bar',
    data: {
      labels: tr.map(r => r.k.slice(5)),
      datasets: [
        { type: 'bar', label: val ? 'Orders Value' : 'Cancelled Orders', data: tr.map(mv), backgroundColor: cBarColors, yAxisID: 'y', order: 2, datalabels: tr.length > 32 ? { display: false } : lbl(lbf) },
        { type: 'line', label: '%GT Cancelled Orders', data: tr.map(r => r.orders / tot * 100), borderColor: BLUE, backgroundColor: BLUE, borderWidth: 1.6, pointRadius: 2, tension: .35, yAxisID: 'y1', order: 1, datalabels: tr.length > 32 ? { display: false } : pctLbl() }
      ]
    },
    options: cTrendOpts
  } : { __empty: true });
}

// ================= PAGE 3: PREP TIME =================
const STAGES = [
  ['acc', 'Acc → Started', 'Accepted To Started', o => [o.acceptedAt, o.startedAt]],
  ['prep', 'Started → Prepared', 'Started To Prepared', o => [o.startedAt, o.preparedAt]],
  ['std', 'Prepared → STD', 'Prepared To Sent To Dispatch', o => [o.preparedAt, o.stdAt]],
  ['disp', 'STD → Dispatched', 'STD To Dispatched', o => [o.stdAt, o.dispatchedAt]],
  ['recDisp', 'Receiving → Dispatched', 'Receiving To Dispatched', o => [o.acceptedAt || o.receivedAt, o.dispatchedAt]],
  ['recDel', 'Received → Delivered', 'Received To Delivered', o => [o.acceptedAt || o.receivedAt, o.deliveredAt]]
];
function stageVals(o) { const r = {}; STAGES.forEach(([k, , , f]) => { const [a, b] = f(o); r[k] = mins(a, b); }); return r; }

function initRanges() {
  const col = $('#rangeCol'); if (!col) return;
  col.innerHTML = '';
  const O = S.orders.filter(o => !o.cancelled).map(o => ({ o, v: stageVals(o) }));
  S.rng = {};

  STAGES.forEach(([k, label]) => {
    const vals = O.map(x => x.v[k]).filter(v => v != null);
    const lo = vals.length ? Math.floor(Math.min(...vals) * 100) / 100 : 0;
    const hi = vals.length ? Math.ceil(Math.max(...vals) * 100) / 100 : 30;
    S.rng[k] = { lo, hi, min: lo, max: hi };

    const d = document.createElement('div');
    d.className = 'rng';
    d.innerHTML = `
      <div class="rng-head"><label>${label}</label><span class="chevron">⌄</span></div>
      <div class="pair">
        <input type="number" step="0.01" value="${lo}" id="inMin-${k}" data-r="${k}" data-e="min">
        <input type="number" step="0.01" value="${hi}" id="inMax-${k}" data-r="${k}" data-e="max">
      </div>
      <div class="dual-slider">
        <div class="slider-track"><div class="slider-bar" id="bar-${k}"></div></div>
        <input type="range" id="slMin-${k}" min="0" max="1000" value="0" data-r="${k}">
        <input type="range" id="slMax-${k}" min="0" max="1000" value="1000" data-r="${k}">
      </div>
    `;
    col.appendChild(d);
  });

  // Slider event binding
  STAGES.forEach(([k]) => {
    const slMin = $(`#slMin-${k}`), slMax = $(`#slMax-${k}`);
    const inMin = $(`#inMin-${k}`), inMax = $(`#inMax-${k}`);
    const bar = $(`#bar-${k}`);
    const r = S.rng[k];
    const span = Math.max(r.hi - r.lo, 1);

    function updateStageBar() {
      const p1 = Math.min(+slMin.value, +slMax.value);
      const p2 = Math.max(+slMin.value, +slMax.value);
      if (bar) {
        bar.style.left = (p1 / 10) + '%';
        bar.style.width = ((p2 - p1) / 10) + '%';
      }
    }

    slMin.oninput = () => {
      if (+slMin.value > +slMax.value) slMin.value = slMax.value;
      r.min = +(r.lo + (+slMin.value / 1000) * span).toFixed(2);
      inMin.value = r.min;
      updateStageBar();
      renderPrep();
    };
    slMax.oninput = () => {
      if (+slMax.value < +slMin.value) slMax.value = slMin.value;
      r.max = +(r.lo + (+slMax.value / 1000) * span).toFixed(2);
      inMax.value = r.max;
      updateStageBar();
      renderPrep();
    };
    inMin.onchange = () => {
      r.min = parseFloat(inMin.value) || r.lo;
      slMin.value = Math.max(0, Math.min(1000, Math.round(((r.min - r.lo) / span) * 1000)));
      updateStageBar();
      renderPrep();
    };
    inMax.onchange = () => {
      r.max = parseFloat(inMax.value) || r.hi;
      slMax.value = Math.max(0, Math.min(1000, Math.round(((r.max - r.lo) / span) * 1000)));
      updateStageBar();
      renderPrep();
    };
    updateStageBar();
  });
}

function renderPrep() {
  let O = base('prep').filter(o => !o.cancelled).map(o => ({ o, v: stageVals(o) }));
  O = O.filter(x => STAGES.every(([k]) => {
    const v = x.v[k], r = S.rng[k];
    return v == null || !r || ((isNaN(r.min) || v >= r.min - 1e-9) && (isNaN(r.max) || v <= r.max + 1e-9));
  }));
  const avgOf = (arr, k) => avg(arr.map(x => x.v[k]).filter(v => v != null));
  const stageTarget = {
    acc: 'c-pb-acc',
    prep: 'c-pb-prep',
    std: 'c-pb-std',
    recDisp: 'c-pb-recDisp',
    disp: 'c-pb-recDisp',
    recDel: 'c-ploc'
  };

  const focusStage = (k) => {
    S.ui.activeStage = (S.ui.activeStage === k ? null : k);
    const tid = stageTarget[k] || 'prepTable';
    const targetEl = document.getElementById(tid);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const parentPanel = targetEl.closest('.panel') || targetEl;
      parentPanel.style.transition = 'all 0.3s ease';
      parentPanel.style.outline = '3px solid #FDCB3C';
      parentPanel.style.boxShadow = '0 0 16px rgba(253, 203, 60, 0.6)';
      setTimeout(() => {
        parentPanel.style.outline = '';
        parentPanel.style.boxShadow = '';
      }, 1600);
    }
    renderPrep();
  };

  const kp = STAGES.map(([k, l]) => [
    l,
    avgOf(O, k).toFixed(2),
    false,
    () => focusStage(k),
    S.ui.activeStage === k,
    `Click to spotlight and sort by ${l}`
  ]);
  
  // best vs worst outlet
  const pairs = groupBy(O.filter(x => x.v.recDisp != null), x => `${x.o.brand} - ${x.o.location}`).map(g => ({ k: g.k, v: avg(g.rows.map(x => x.v.recDisp)), n: g.rows.length })).filter(p => p.n >= 1).sort((a, b) => a.v - b.v);
  const best = pairs[0], worst = pairs[pairs.length - 1];

  const bBrand = best ? best.k.split(' - ')[0] : '';
  const wBrand = worst ? worst.k.split(' - ')[0] : '';
  const isBestActive = S.f.brand === bBrand;
  const isWorstActive = S.f.brand === wBrand;

  kp.push([
    'Best vs Worst Brand Location',
    best ? `🏆 Best outlet ${esc(best.k)} – ${best.v.toFixed(1)} min | 🚨 Underperforming: ${esc(worst.k)} – ${worst.v.toFixed(1)} min` : '–',
    true,
    () => {
      if (!best) return;
      if (S.f.brand === bBrand) {
        S.f.brand = wBrand;
      } else if (S.f.brand === wBrand) {
        S.f.brand = 'All';
      } else {
        S.f.brand = bBrand;
      }
      syncFilterUI();
      render();
    },
    isBestActive || isWorstActive,
    isBestActive ? `Currently showing Best Brand: "${bBrand}" (click for Worst)` : isWorstActive ? `Currently showing Worst Brand: "${wBrand}" (click to reset)` : `Click to filter Best Brand: "${bBrand}"`
  ]);
  kpis('kpi-prep', kp);

  const g = S.ui.pgroup, gname = g === 'brand' ? 'Brand' : 'Cuisine';
  const grp = groupBy(O, x => gk(x.o, g));
  const wrap = $('#prepCharts');
  if (wrap) {
    if (!wrap.children.length) {
      const sel = [['acc', 'Accepted To Started_Min'], ['prep', 'Started To Prepared_Min'], ['std', 'Prepared To Sent To Dispatch_Min'], ['recDisp', 'Receiving To Dispatched_Min']];
      wrap.innerHTML = sel.map(([k, t]) => `<div class="panel"><div class="ph" data-t="Best ${t}"></div><div class="pb"><canvas id="c-pb-${k}"></canvas></div></div>`).join('') + sel.map(([k, t]) => `<div class="panel"><div class="ph dark" data-t="Worst ${t}"></div><div class="pb"><canvas id="c-pw-${k}"></canvas></div></div>`).join('');
      const kids = [...wrap.children]; wrap.innerHTML = '';
      [0, 4, 1, 5, 2, 6, 3, 7].forEach(i => wrap.appendChild(kids[i]));
    }
    $$('.ph[data-t]', wrap).forEach(h => h.textContent = h.dataset.t.replace('_Min', `_Min by ${gname}`));
    ['acc', 'prep', 'std', 'recDisp'].forEach(k => {
      const rows = grp.map(gr => ({ k: gr.k, v: avgOf(gr.rows, k), n: gr.rows.filter(x => x.v[k] != null).length })).filter(r => r.n);
      barsPlain('c-pb-' + k, rows.slice().sort((a, b) => a.v - b.v).slice(0, 10), { color: Y, filterKey: g === 'brand' ? 'brand' : 'cuisine' });
      barsPlain('c-pw-' + k, rows.slice().sort((a, b) => b.v - a.v).slice(0, 10), { color: GREY, filterKey: g === 'brand' ? 'brand' : 'cuisine' });
    });
  }

  // matrix table
  const t = $('#prepTable');
  if (t) {
    const sortKey = S.ui.activeStage || 'recDisp';
    const sortedGrp = grp.slice().sort((a, b) => {
      if (S.ui.activeStage) {
        return avgOf(a.rows, sortKey) - avgOf(b.rows, sortKey);
      }
      return (a.k < b.k ? -1 : 1);
    });
    t.innerHTML = `<thead><tr><th>${gname}</th>${STAGES.map(s => `<th style="${S.ui.activeStage === s[0] ? 'background:#FCD258;color:#000;font-weight:700' : ''}">${s[1].replace(' → ', ' →<br>')}</th>`).join('')}</tr></thead><tbody>${sortedGrp.map(gr => {
      const isRowActive = S.f.brand === gr.k;
      return `<tr style="cursor:pointer;background:${isRowActive ? '#FFFDF2' : ''};outline:${isRowActive ? '2px solid #b38600' : ''}" onclick="(() => { S.f.brand = (S.f.brand === '${esc(gr.k)}' ? 'All' : '${esc(gr.k)}'); syncFilterUI(); render(); })()"><td><b>${esc(gr.k)}</b></td>${STAGES.map(([k]) => { const v = avgOf(gr.rows, k); return `<td style="${S.ui.activeStage === k ? 'background:rgba(253,203,60,0.2);font-weight:700' : ''}">${v ? v.toFixed(2) : ''}</td>`; }).join('')}</tr>`;
    }).join('')}</tbody>`;
  }

  // location counts
  const lc = groupBy(O, x => x.o.location).map(g2 => ({ k: g2.k, v: g2.rows.length })).sort((a, b) => b.v - a.v).slice(0, 28);
  barsPlain('c-ploc', lc, { fmt: v => String(v), filterKey: 'location' });
}

function renderRatings() {
  const allRatings = base('ratings').filter(o => !o.cancelled).map(o => ({ ...o, rating: orderRating(o) })).filter(o => o.rating != null);
  let R = allRatings;
  if (S.selBrands.size) R = R.filter(o => S.selBrands.has(o.brand));
  if (S.selLocs.size) R = R.filter(o => S.selLocs.has(o.location));
  if (S.f.star && S.f.star !== 'All') R = R.filter(o => Math.round(o.rating) === +S.f.star);
  const n = R.length, neg = R.filter(o => o.rating <= 3).length, pos = n - neg;
  const rf = S.f.ratingFilter || 'all';

  kpis('kpi-ratings', [
    ['Total Ratings', cnt(n), false, () => { S.f.ratingFilter = 'all'; S.f.star = 'All'; renderRatings(); }, rf === 'all' && (!S.f.star || S.f.star === 'All'), 'Click to show all ratings across all outlets'],
    ['Negative Ratings', cnt(neg), false, () => { S.f.ratingFilter = (rf === 'neg' ? 'all' : 'neg'); S.f.star = 'All'; renderRatings(); }, rf === 'neg', 'Click to filter and drill down into Negative Ratings (≤3★) across brands and locations'],
    ['Positive Ratings', cnt(pos), false, () => { S.f.ratingFilter = (rf === 'pos' ? 'all' : 'pos'); S.f.star = 'All'; renderRatings(); }, rf === 'pos', 'Click to filter and inspect Positive Ratings (4-5★) across brands and locations'],
    ['Negative Ratings %', n ? pc(neg / n, 2) : '0%', false, () => { S.f.ratingFilter = (rf === 'neg' ? 'all' : 'neg'); S.f.star = 'All'; renderRatings(); }, rf === 'neg', 'Click to isolate negative feedback rate drivers'],
    ['Polarity rate', n ? pc(pos / n, 2) : '0%', false, () => { S.f.ratingFilter = (rf === 'pos' ? 'all' : 'pos'); S.f.star = 'All'; renderRatings(); }, rf === 'pos', 'Click to isolate customer satisfaction polarity']
  ]);

  let chartR = R;
  if (rf === 'neg') chartR = R.filter(o => o.rating <= 3);
  else if (rf === 'pos') chartR = R.filter(o => o.rating >= 4);

  const agg = kf => groupBy(chartR, kf).map(g => ({ k: g.k, n: g.rows.length, a: avg(g.rows.map(o => o.rating)) }));
  const rc = (id, rows, color, filterKey) => {
    if (!rows.length) return mk(id, { __empty: true });
    const opts = baseOpts({
      plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
      scales: { x: { ...gridless, ticks: { autoSkip: false, maxRotation: 55, font: { size: 9 }, callback(v) { return trunc(this.getLabelForValue(v), 12); } } }, y: { display: false, beginAtZero: true }, y1: { display: false, min: 0, max: 5.5 } }
    });
    if (filterKey) addBarClick(opts, r => r.k, filterKey);
    mk(id, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.k),
        datasets: [
          { type: 'bar', label: rf === 'neg' ? 'Negative Ratings (≤3★)' : rf === 'pos' ? 'Positive Ratings (4-5★)' : 'Total Ratings', data: rows.map(r => r.n), backgroundColor: rf === 'neg' ? '#ee2a5c' : color, yAxisID: 'y', order: 2, datalabels: lbl(v => v) },
          { type: 'line', label: 'Average Rating', data: rows.map(r => +r.a.toFixed(1)), borderColor: K, backgroundColor: K, borderWidth: 1.6, pointRadius: 2, tension: .3, yAxisID: 'y1', order: 1, datalabels: { display: rows.length < 26, align: 'top', backgroundColor: 'rgba(255,255,255,.85)', borderRadius: 3, padding: 1, font: { size: 10, weight: '600' }, color: K } }
        ]
      },
      options: opts
    });
  };

  const loc = agg(o => o.location).filter(r => r.n >= 1);
  rc('c-rbl', loc.slice().sort((a, b) => b.a - a.a || b.n - a.n).slice(0, 10), Y, 'location');
  rc('c-rwl', loc.slice().sort((a, b) => a.a - b.a || b.n - a.n).slice(0, 12), Y, 'location');

  const bg = agg(o => gk(o, S.ui.rgroup)).filter(r => r.n >= 1);
  const nm = S.ui.rgroup === 'brand' ? 'Brands' : 'Brands (Cuisine Cluster)';
  $('#t-rbb').textContent = (rf === 'neg' ? 'Lowest Impact ' : 'Best ') + nm + ' By Rating';
  $('#t-rwb').textContent = (rf === 'neg' ? 'Most Negative ' : 'Worst ') + nm + ' By Ratings';
  rc('c-rbb', bg.slice().sort((a, b) => b.a - a.a || b.n - a.n).slice(0, 10), Y, S.ui.rgroup === 'brand' ? 'brand' : 'cuisine');
  rc('c-rwb', bg.slice().sort((a, b) => a.a - b.a || b.n - a.n).slice(0, 12), Y, S.ui.rgroup === 'brand' ? 'brand' : 'cuisine');

  rc('c-rall', agg(o => o.location).sort((a, b) => b.n - a.n).slice(0, 26), Y, 'location');

  const dist = [5, 4, 3, 2, 1].map(s => ({ k: String(s), v: chartR.filter(o => Math.round(o.rating) === s).length }));
  donut('c-rdist', dist, { fmt: v => v, colors: [Y, LIGHT, '#ececec', '#ee2a5c', '#1d1d1d'], filterKey: 'star' });

  // search lists
  fillList('#lstBrand', '#srchBrand', uniq(S.orders.map(o => o.brand)).sort(), S.selBrands);
  fillList('#lstLoc', '#srchLoc', uniq(S.orders.map(o => o.location)).sort(), S.selLocs);
}

function fillList(ul, input, values, set) {
  const q = $(input).value.toLowerCase(); const el = $(ul);
  el.innerHTML = values.filter(v => v.toLowerCase().includes(q)).map(v => `<li class="${set.has(v) ? 'on' : ''}" title="${esc(v)}">${esc(v)}</li>`).join('');
  $$('li', el).forEach(li => li.onclick = () => {
    const v = li.textContent;
    set.has(v) ? set.delete(v) : set.add(v);
    renderRatings();
  });
}

// ================= PAGE 5: 86 ITEMS =================
function renderItemsPage() {
  const sales = S.ui.itemsView === 'sales';
  $('#kpi-items').hidden = sales;
  $('#grid-items').hidden = sales;
  $('#kpi-item-sales').hidden = !sales;
  $('#grid-item-sales').hidden = !sales;
  if (sales) renderItemSales(); else renderItems86();
}

function renderItems86() {
  const f = S.f;
  const I = S.items.filter(x => dateOk(x.at) && eq(x.brand, f.brand) && eq(x.location, f.location) && (f.item === 'All' || x.item === f.item) && (f.source === 'All' || x.source === f.source) && (f.type === 'All' || x.type === f.type));
  const n = I.length;
  const topB = groupBy(I, x => x.brand).sort((a, b) => b.rows.length - a.rows.length)[0];
  const topL = groupBy(I, x => x.location).sort((a, b) => b.rows.length - a.rows.length)[0];

  const isBrandActive = !!(topB && f.brand === topB.k);
  const isLocActive = !!(topL && f.location === topL.k);
  const isAllActive = f.brand === 'All' && f.location === 'All' && f.item === 'All';

  kpis('kpi-items', [
    ['86 Items', cnt(n), false, () => {
      S.f.brand = 'All';
      S.f.location = 'All';
      S.f.item = 'All';
      S.f.source = 'All';
      S.f.type = 'All';
      syncFilterUI();
      renderItems86();
    }, isAllActive, 'Click to reset all 86 filters to show full inventory stock-outs'],
    ['Brand with Most 86 Items', topB ? esc(topB.k) : '–', true, () => {
      if (!topB) return;
      S.f.brand = (S.f.brand === topB.k ? 'All' : topB.k);
      syncFilterUI();
      render();
    }, isBrandActive, topB ? (isBrandActive ? `Currently showing Brand "${topB.k}" (click to reset)` : `Click to filter 86ed items for Brand "${topB.k}"`) : ''],
    ['Location with Most 86 Items', topL ? esc(topL.k) : '–', true, () => {
      if (!topL) return;
      S.f.location = (S.f.location === topL.k ? 'All' : topL.k);
      syncFilterUI();
      render();
    }, isLocActive, topL ? (isLocActive ? `Currently showing Location "${topL.k}" (click to reset)` : `Click to filter 86ed items for Location "${topL.k}"`) : '']
  ]);

  const cr = (kf, lim) => groupBy(I, kf).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => b.v - a.v).slice(0, lim);
  $('#t-ibrand').textContent = `86 Items and %GT 86 Items by ${S.ui.igroup === 'brand' ? 'Brand' : 'Cuisine'}`;
  const tot = n || 1;
  const bRows = cr(x => (S.ui.igroup === 'brand' ? x.brand : x.cuisine), 12);
  combo('c-ibrand', bRows, { name: 'Total 86 Items', pctName: '%GT of 86 Items', fmt: cnt, filterKey: S.ui.igroup === 'brand' ? 'brand' : 'cuisine' });

  const lRows = cr(x => x.location, 11);
  combo('c-iloc', lRows, { name: 'Count of 86 Items', pctName: '%GT Count of 86 Items', fmt: cnt, filterKey: 'location' });

  hbar('c-idist', cr(x => x.item, 10), { fmt: cnt, filterKey: 'item' });
  donut('c-isrc', groupBy(I, x => x.source).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => b.v - a.v), { fmt: cnt, colors: [Y, '#1e88e5', '#555', '#ee2a5c'], filterKey: 'source' });
  donut('c-ityp', groupBy(I, x => x.type).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => b.v - a.v), { fmt: cnt, colors: [Y, '#555'], filterKey: 'type' });

  const allTimeItems = S.items.filter(x => eq(x.brand, f.brand) && eq(x.location, f.location) && (f.item === 'All' || x.item === f.item) && (f.source === 'All' || x.source === f.source) && (f.type === 'All' || x.type === f.type));
  const tr = groupBy(allTimeItems, x => dkey(x.at)).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => (a.k < b.k ? -1 : 1));
  const iColors = tr.map(r => (S.f.from === r.k && S.f.to === r.k ? '#1d1d1d' : Y));
  const itrendOpts = baseOpts({
    onHover: (e, el) => {
      if (e.native && e.native.target) {
        e.native.target.style.cursor = el && el.length ? 'pointer' : 'default';
      }
    },
    onClick: (e, elements) => {
      if (!elements || !elements.length) return;
      const idx = elements[0].index;
      const row = tr[idx];
      if (!row) return;
      if (S.f.from === row.k && S.f.to === row.k) {
        setDates(...fullRange());
      } else {
        setDates(row.k, row.k);
      }
      dateChanged();
    },
    scales: {
      x: { ...gridless, ticks: { maxTicksLimit: 25, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { callback: cnt, maxTicksLimit: 5 }, grid: { color: '#eee' } }
    }
  });
  mk('c-itrend', tr.length ? {
    type: 'bar',
    data: {
      labels: tr.map(r => r.k.slice(5)),
      datasets: [{ label: '86 Items', data: tr.map(r => r.v), backgroundColor: iColors, datalabels: tr.length > 25 ? { display: false } : lbl(cnt) }]
    },
    options: itrendOpts
  } : { __empty: true });

  // fix %GT fields
  [['c-ibrand', bRows], ['c-iloc', lRows]].forEach(([id, rows]) => {
    const c = charts[id]; if (c && c.data.datasets[1]) { c.data.datasets[1].data = rows.map(r => r.v / tot * 100); c.update('none'); }
  });
}

// ---------------- PAGE 5b: ITEM SALES (items sold by time) ----------------
// Correctness rules (see plan): a cancelled order's items were never actually
// sold, and a bundle/combo order emits one base-item row plus several
// zero-price modifier rows under the same orderId -- summing qty across those
// would overcount "items sold" (confirmed against the live GrubCENTER data:
// one "Burger Box for 4" order produced 9 rows, 8 of them modifiers). Both
// must be excluded before any sold-item KPI or chart is computed.
//
// GrubCENTER's itemTotalPrice only nets out ITEM-level discounts -- an
// order-level promo code/voucher discount (applied at checkout, not per
// line) never shows up in it. Confirmed against the live data: for orders
// with a sizable order-level discount, summing itemTotalPrice across their
// lines reproduces receiptTotal (gross) almost exactly, not netSales --
// overstating revenue by the full discount amount. netSales in
// all_orders.json is the already-audited figure, so line-item revenue is
// prorated against it per order rather than trusted raw. grossByOrder/
// revenueOf are computed before the item-name filter so the ratio reflects
// the WHOLE order, not just whichever item the user has drilled into.
// Shared by renderItemSales() and the Items-Net-Sales/Avg-Items-per-Order
// drill-down modal, so neither can drift out of sync with the other.
function itemSalesBase() {
  const f = S.f;
  const cancelledIds = new Set(S.orders.filter(o => o.cancelled).map(o => o.id));
  const preItemFilter = S.lineItems.filter(x =>
    !cancelledIds.has(x.orderId) && x.type === 'Menu Item' &&
    eq(x.brand, f.brand) && eq(x.location, f.location) && eq(x.channel, f.channel)
  );
  const ordersById = new Map(S.orders.map(o => [o.id, o]));
  const grossByOrder = new Map();
  preItemFilter.forEach(x => grossByOrder.set(x.orderId, (grossByOrder.get(x.orderId) || 0) + x.lineTotal));
  const revenueOf = x => {
    const o = ordersById.get(x.orderId), gross = grossByOrder.get(x.orderId);
    return (o && gross) ? x.lineTotal * (o.netSales / gross) : x.lineTotal;
  };
  const soldBase = preItemFilter.filter(x => f.item === 'All' || x.item === f.item);
  return { soldBase, revenueOf };
}

function renderItemSales() {
  const f = S.f;
  const { soldBase, revenueOf } = itemSalesBase();
  const I = soldBase.filter(x => dateOk(x.at));
  const qtyAgg = (arr, kf) => groupBy(arr, kf).map(g => ({ k: g.k, v: sum(g.rows, x => x.qty) }));

  const totalQty = sum(I, x => x.qty);
  const totalRevenue = sum(I, revenueOf);
  const orderCount = uniq(I.map(x => x.orderId)).length;
  const topItem = qtyAgg(I, x => x.item).sort((a, b) => b.v - a.v)[0];
  const isItemActive = !!(topItem && f.item === topItem.k);

  kpis('kpi-item-sales', [
    ['Total Items Sold', cnt(totalQty), false, () => {
      S.f.item = 'All'; S.f.hour = 'All'; S.f.slot = 'All';
      syncFilterUI(); renderItemSales();
    }, f.item === 'All' && f.hour === 'All' && f.slot === 'All', 'Click to reset item/hour/slot filters'],
    ['Top Selling Item', topItem ? esc(topItem.k) : '–', true, () => {
      if (!topItem) return;
      S.f.item = (S.f.item === topItem.k ? 'All' : topItem.k);
      syncFilterUI(); renderItemSales();
    }, isItemActive, topItem ? (isItemActive ? `Currently showing "${topItem.k}" (click to reset)` : `Click to filter Item Sales for "${topItem.k}"`) : ''],
    ['Items Net Sales', money(totalRevenue), false, () => { openItemSalesDrillModal(); }, false, 'Sum of item price net of item-level discount, excluding cancelled orders and modifier lines. Click to view the daily breakdown.', 'drill'],
    ['Avg Items per Order', orderCount ? (totalQty / orderCount).toFixed(2) : '0', false, () => { openItemSalesDrillModal(); }, false, 'Total items sold ÷ distinct orders containing at least one sold item. Click to view the daily breakdown.', 'drill']
  ]);

  const hr = Array.from({ length: 24 }, (_, h) => ({ k: String(h), v: 0 }));
  I.forEach(x => { hr[dubaiHour(x.at)].v += x.qty; });
  combo('c-isoldhour', hr, { name: 'Items Sold', pctName: '%GT Items Sold', fmt: cnt, filterKey: 'hour' });

  const slRows = qtyAgg(I, x => slotOf(dubaiHour(x.at))).sort((a, b) => SLOTS.findIndex(s => s[0] === a.k) - SLOTS.findIndex(s => s[0] === b.k));
  combo('c-isoldslot', slRows, { name: 'Items Sold', pctName: '%GT Items Sold', fmt: cnt, filterKey: 'slot' });

  const topRows = qtyAgg(I, x => x.item).sort((a, b) => b.v - a.v).slice(0, 10);
  hbar('c-itopsold', topRows, { fmt: cnt, name: 'Items Sold', filterKey: 'item' });

  // Trend ignores the active date range (same convention as the 86-items
  // trend chart) so the full history stays click-to-drill-able.
  const tr = qtyAgg(soldBase, x => dkey(x.at)).sort((a, b) => (a.k < b.k ? -1 : 1));
  const trColors = tr.map(r => (S.f.from === r.k && S.f.to === r.k ? '#1d1d1d' : Y));
  const trendOpts = baseOpts({
    onHover: (e, el) => { if (e.native && e.native.target) e.native.target.style.cursor = el && el.length ? 'pointer' : 'default'; },
    onClick: (e, elements) => {
      if (!elements || !elements.length) return;
      const row = tr[elements[0].index];
      if (!row) return;
      if (S.f.from === row.k && S.f.to === row.k) setDates(...fullRange()); else setDates(row.k, row.k);
      dateChanged();
    },
    scales: {
      x: { ...gridless, ticks: { maxTicksLimit: 25, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { callback: cnt, maxTicksLimit: 5 }, grid: { color: '#eee' } }
    }
  });
  mk('c-isoldtrend', tr.length ? {
    type: 'bar',
    data: { labels: tr.map(r => r.k.slice(5)), datasets: [{ label: 'Items Sold', data: tr.map(r => r.v), backgroundColor: trColors, datalabels: tr.length > 25 ? { display: false } : lbl(cnt) }] },
    options: trendOpts
  } : { __empty: true });
}

// ================= PAGE 6: DELAYED =================
const EST_DEFAULT = 15, DELAY_LIMIT = 10;
function renderDelayed() {
  const allOrders = base('delayed').filter(o => !o.cancelled).map(o => {
    const p = prepOf(o); const est = o.estPrep || EST_DEFAULT; return { o, p, est, delay: p == null ? null : p - est };
  }).filter(x => x.p != null);
  const delayed = allOrders.filter(x => x.delay > DELAY_LIMIT);
  const isOnlyDelayed = !!S.f.onlyDelayed;

  kpis('kpi-delayed', [
    ['Total Orders', cnt(allOrders.length), false, () => {
      S.f.onlyDelayed = false;
      renderDelayed();
    }, !isOnlyDelayed, 'Click to show all completed orders in delay analytics'],
    ['Delayed Orders', cnt(delayed.length), false, () => {
      S.f.onlyDelayed = !S.f.onlyDelayed;
      renderDelayed();
      const el = document.getElementById('delayTable');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, isOnlyDelayed, 'Click to filter dashboard to only delayed orders (>10 min delay) and highlight bottlenecks'],
    ['> 10 Minutes %', allOrders.length ? pc(delayed.length / allOrders.length, 2) : '0%', false, () => {
      S.f.onlyDelayed = !S.f.onlyDelayed;
      renderDelayed();
    }, isOnlyDelayed, 'Click to toggle delay exception view (>10 min delay)']
  ]);

  const O = isOnlyDelayed ? delayed : allOrders;

  const dcombo = (id, kf, lim, filterKey) => {
    const rows = groupBy(O, x => kf(x.o)).map(g => ({ k: g.k, c: g.rows.length, d: g.rows.filter(x => x.delay > DELAY_LIMIT).length })).sort((a, b) => (isOnlyDelayed ? b.d - a.d : b.c - a.c)).slice(0, lim);
    if (!rows.length) return mk(id, { __empty: true });
    const opts = baseOpts({
      plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
      scales: { x: { ...gridless, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 11); } } }, y: { display: false, beginAtZero: true }, y1: { display: false, beginAtZero: true } }
    });
    if (filterKey) addBarClick(opts, r => r.k, filterKey);
    mk(id, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.k),
        datasets: [
          { type: 'bar', label: isOnlyDelayed ? 'Delayed Orders' : 'Completed Orders', data: rows.map(r => r.c), backgroundColor: isOnlyDelayed ? '#ee2a5c' : Y, yAxisID: 'y', order: 3, datalabels: lbl(v => v) },
          { type: 'bar', label: 'Delayed >10 Minutes', data: rows.map(r => r.d), backgroundColor: GREY, yAxisID: 'y', order: 2, datalabels: lbl(v => v) },
          { type: 'line', label: '>10 Minutes %', data: rows.map(r => r.c ? r.d / r.c * 100 : 0), borderColor: K, backgroundColor: K, borderWidth: 1.6, pointRadius: 2, tension: .3, yAxisID: 'y1', order: 1, datalabels: { display: rows.length < 20, align: 'top', backgroundColor: 'rgba(255,255,255,.85)', borderRadius: 3, padding: 1, font: { size: 10, weight: '600' }, color: K, formatter: v => v.toFixed(0) + '%' } }
        ]
      },
      options: opts
    });
  };
  dcombo('c-dbrand', o => gk(o, S.ui.dgroup), 8, S.ui.dgroup === 'brand' ? 'brand' : 'cuisine');
  dcombo('c-dloc', o => o.location, 14, 'location');

  const pv = groupBy(O, x => gk(x.o, S.ui.dgroup)).map(g => ({ k: g.k, a: avg(g.rows.map(x => x.p)), e: avg(g.rows.map(x => x.est)), n: g.rows.length })).sort((a, b) => b.a - a.a).slice(0, 8);
  const curDPrep = S.f[S.ui.dgroup === 'brand' ? 'brand' : 'cuisine'];
  const dprepOpts = baseOpts({
    plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
    scales: { x: { ...gridless, ticks: { autoSkip: false, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 11); } } }, y: { display: false, beginAtZero: true } }
  });
  addBarClick(dprepOpts, r => r.k, S.ui.dgroup === 'brand' ? 'brand' : 'cuisine');
  if (!pv.length) mk('c-dprep', { __empty: true });
  else mk('c-dprep', {
    type: 'bar',
    data: {
      labels: pv.map(r => r.k),
      datasets: [
        { label: 'Brand Preparation Time', data: pv.map(r => +r.a.toFixed(1)), backgroundColor: pv.map(r => curDPrep !== 'All' ? (String(r.k) === String(curDPrep) ? '#1d1d1d' : '#dedede') : GREY), datalabels: lbl(v => v.toFixed(1)) },
        { label: 'Brand Estimated Time', data: pv.map(r => +r.e.toFixed(1)), backgroundColor: pv.map(r => curDPrep !== 'All' ? (String(r.k) === String(curDPrep) ? '#FCD258' : '#FEEBB4') : Y), datalabels: lbl(v => v.toFixed(1)) }
      ]
    },
    options: dprepOpts
  });

  // ranked delay table
  const rk = groupBy(O.filter(x => x.delay != null), x => `${gk(x.o, S.ui.dgroup)}|${x.o.location}`).map(g => ({
    name: S.ui.dgroup === 'brand' ? `${g.rows[0].o.brand}, ${g.rows[0].o.location}` : g.rows[0].o.cuisine + ', ' + g.rows[0].o.location,
    targetKey: S.ui.dgroup === 'brand' ? g.rows[0].o.brand : g.rows[0].o.cuisine,
    d: avg(g.rows.map(x => x.delay)),
    count: g.rows.length
  })).sort((a, b) => b.d - a.d);
  const mx = rk.length ? rk[0].d || 1 : 1;
  const thPrefix = isOnlyDelayed ? '🚨 Delayed Outlets (>10m)' : (S.ui.dgroup === 'brand' ? 'Brand' : 'Cuisine');
  const curTargetKey = S.f[S.ui.dgroup === 'brand' ? 'brand' : 'cuisine'];
  const filterField = S.ui.dgroup === 'brand' ? 'brand' : 'cuisine';
  $('#delayTable').innerHTML = `<thead><tr><th style="text-align:left">${thPrefix}</th><th>Orders</th><th>Avg Delay (min)</th></tr></thead><tbody>${rk.map((r, i) => {
    const t = Math.max(0, Math.min(1, r.d / mx));
    const isRowActive = curTargetKey === r.targetKey;
    return `<tr style="cursor:pointer;background:${isRowActive ? '#FFFDF2' : (i % 2 ? '#111' : '#fff')};color:${isRowActive ? '#000' : (i % 2 ? '#fff' : '#111')};outline:${isRowActive ? '2px solid #b38600' : 'none'}" onclick="(() => { S.f['${filterField}'] = (S.f['${filterField}'] === '${esc(r.targetKey)}' ? 'All' : '${esc(r.targetKey)}'); syncFilterUI(); render(); })()"><td>${isRowActive ? '✓ ' : ''}${esc(r.name)}</td><td>${r.count}</td><td style="background:hsl(4,85%,${Math.max(40, 94 - t * 40)}%);color:#111;font-weight:700">${r.d.toFixed(2)}</td></tr>`;
  }).join('')}</tbody>`;
}

// ================= PAGE 7: COMMISSION =================
// Shared by renderCommission() and the "Blended Commission %" drill-down
// modal, so the two can never drift apart -- both read FHCommission's
// contracted per-channel rates through this one place.
function commissionChannelAgg() {
  const O = base('commission').filter(o => !o.cancelled);
  const net = sum(O, o => o.netSales);
  const commission = sum(O, o => FHCommission.commissionForOrder(o));
  const chanAgg = groupBy(O, o => o.channel).map(g => {
    const cNet = sum(g.rows, o => o.netSales);
    const cComm = sum(g.rows, o => FHCommission.commissionForOrder(o));
    return { k: g.k, netSales: cNet, commission: cComm, orders: g.rows.length, effRate: cNet ? cComm / cNet : 0 };
  });
  return { net, commission, chanAgg };
}

function renderCommission() {
  const { net, commission, chanAgg } = commissionChannelAgg();
  const topComm = chanAgg.slice().sort((a, b) => b.commission - a.commission)[0];

  kpis('kpi-commission', [
    ['Total Commission', money(commission), false, () => {
      const el = document.getElementById('c-commchan');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, false, 'Total aggregator commission owed across all channels for the current filter, computed from each portal\'s signed contract rate', 'nav'],

    ['Blended Commission %', net ? pc(commission / net, 1) : '0%', false, () => {
      openCommissionDrillModal();
    }, false, 'Total Commission / Net Sales across all channels. Click to view the full per-channel breakdown.', 'drill'],

    ['Highest-Commission Channel', topComm ? esc(topComm.k) : '–', true, () => {
      if (!topComm) return;
      S.f.channel = S.f.channel === topComm.k ? 'All' : topComm.k;
      syncFilterUI();
      render();
    }, topComm && S.f.channel === topComm.k, topComm ? `Click to filter dashboard for "${topComm.k}" (click again to reset)` : '']
  ]);

  const dc = chanAgg.filter(r => r.commission > 0).sort((a, b) => b.commission - a.commission).map(r => ({ k: r.k, v: r.commission }));
  donut('c-commchan', dc, { legend: 'left', filterKey: 'channel' });
  $('#commTotal').textContent = money(commission);

  const rateRows = chanAgg.filter(r => r.netSales > 0).sort((a, b) => b.effRate - a.effRate).map(r => ({ k: r.k, v: r.effRate * 100 }));
  hbar('c-commbar', rateRows, { fmt: v => v.toFixed(1) + '%', name: 'Effective Commission Rate', filterKey: 'channel' });

  const rc = $('#rateCardTable');
  if (rc) {
    rc.innerHTML = `<thead><tr><th>Portal</th><th>Contracted Structure</th><th>Notes (not applied)</th></tr></thead><tbody>${
      FHCommission.RATE_CARD.map(r => `<tr><td><b>${esc(r.channel)}</b></td><td>${esc(r.structure)}</td><td class="rc-note">${esc(r.note)}</td></tr>`).join('')
    }</tbody>`;
  }
}

// ================= PAGE 8: EBITDA =================
// Manual cost categories (COGS, Labor, Controllable, Occupancy, G&A) are not
// derivable from order data, so the user enters them directly on this page,
// following the standard F&B operating P&L structure:
//   Net Sales - COGS = Gross Profit
//   Gross Profit - Labor - Commission - Other Controllable = Controllable Profit
//   Controllable Profit - Occupancy - G&A = EBITDA
// Persisted per-browser via localStorage -- there's no backend database for
// this app to store them in.
const COSTS_KEY = 'fh_ebitda_costs';
const COST_CATEGORIES = [
  { key: 'cogs', label: 'Cost of Goods Sold (Food & Beverage)', defaults: ['Food Cost', 'Beverage Cost / Packaging'] },
  { key: 'labor', label: 'Labor Cost', defaults: ['Kitchen / Hourly Labor', 'Management & Admin Payroll', 'Payroll Taxes & Benefits'] },
  { key: 'controllable', label: 'Other Controllable Expenses', defaults: ['Marketing (non-portal)', 'Repairs & Maintenance', 'Utilities', 'Supplies & Small Equipment'] },
  { key: 'occupancy', label: 'Occupancy Costs', defaults: ['Kitchen Rent / Lease', 'Insurance', 'Property Tax / CAM'] },
  { key: 'ga', label: 'General & Administrative (G&A)', defaults: ['Admin Salaries (HQ)', 'Professional Fees (Legal/Accounting)', 'Software & Subscriptions', 'Bank Charges'] }
];
// Best-guess keyword routing used only once, to migrate rows saved by the
// earlier flat (non-categorized) version of this panel.
const MIGRATE_KEYWORDS = [
  { key: 'occupancy', re: /rent|lease|insuranc|property|\bcam\b/i },
  { key: 'labor', re: /payroll|labor|labour|wage|salary/i },
  { key: 'cogs', re: /food|beverage|cogs/i },
  { key: 'controllable', re: /marketing|utilit|repair|maint|supplies/i }
];

function defaultCosts() {
  const o = {};
  COST_CATEGORIES.forEach(c => { o[c.key] = c.defaults.map(label => ({ label, amount: 0 })); });
  return o;
}
function loadCosts() {
  try {
    const raw = localStorage.getItem(COSTS_KEY);
    if (!raw) return defaultCosts();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Old flat-list format from the earlier version of this panel --
      // migrate each row into a category by keyword match, G&A as catch-all,
      // so nothing the user already entered is lost.
      const migrated = defaultCosts();
      COST_CATEGORIES.forEach(c => { migrated[c.key] = []; });
      parsed.forEach(row => {
        const hit = MIGRATE_KEYWORDS.find(m => m.re.test(row.label || ''));
        migrated[hit ? hit.key : 'ga'].push({ label: row.label || '', amount: +row.amount || 0 });
      });
      try { localStorage.setItem(COSTS_KEY, JSON.stringify(migrated)); } catch (_) {}
      return migrated;
    }
    // Already-categorized format -- make sure every category key exists.
    COST_CATEGORIES.forEach(c => { if (!Array.isArray(parsed[c.key])) parsed[c.key] = []; });
    return parsed;
  } catch (_) { return defaultCosts(); }
}
function saveCosts() {
  try { localStorage.setItem(COSTS_KEY, JSON.stringify(manualCosts)); } catch (_) {}
}
let manualCosts = loadCosts();

function catSubtotal(key) {
  return sum(manualCosts[key] || [], r => +r.amount || 0);
}

function renderCostsBuilder(commission) {
  const root = $('#costsBuilder');
  if (root) {
    root.innerHTML = COST_CATEGORIES.map(c => {
      const rows = manualCosts[c.key] || [];
      const sub = sum(rows, r => +r.amount || 0);
      const commRow = c.key === 'controllable'
        ? `<tr class="cost-ro"><td>Portal / Aggregator Commission <span class="muted small">(auto-computed — see Commission page)</span></td><td class="cost-amt">${money(commission)}</td><td></td></tr>`
        : '';
      return `<div class="cost-cat" data-cat="${c.key}">
        <table>
          <thead><tr><th>${esc(c.label)}</th><th>Amount (AED)</th><th></th></tr></thead>
          <tbody>
            ${commRow}
            ${rows.map((r, i) => `<tr>
              <td><input type="text" data-cat="${c.key}" data-idx="${i}" data-f="label" value="${esc(r.label)}" placeholder="e.g. ${esc(c.defaults ? c.defaults[0] : 'Item')}"></td>
              <td class="cost-amt"><input type="number" step="0.01" min="0" data-cat="${c.key}" data-idx="${i}" data-f="amount" value="${r.amount}"></td>
              <td class="cost-del"><button type="button" class="btn-del-cost" data-cat="${c.key}" data-idx="${i}" title="Remove this cost row">✕</button></td>
            </tr>`).join('')}
            <tr class="cost-sub"><td colspan="2">Subtotal — ${esc(c.label)}</td><td class="cost-amt">${money(sub)}</td></tr>
          </tbody>
        </table>
        <button type="button" class="btn-yellow btn-add-cat" data-cat="${c.key}">+ Add to ${esc(c.label)}</button>
      </div>`;
    }).join('');

    root.querySelectorAll('input').forEach(inp => {
      inp.onchange = () => {
        const cat = inp.dataset.cat, idx = +inp.dataset.idx, f = inp.dataset.f;
        manualCosts[cat][idx][f] = f === 'amount' ? (parseFloat(inp.value) || 0) : inp.value;
        saveCosts();
        renderEbitda();
      };
    });
    root.querySelectorAll('.btn-del-cost').forEach(btn => {
      btn.onclick = () => {
        manualCosts[btn.dataset.cat].splice(+btn.dataset.idx, 1);
        saveCosts();
        renderEbitda();
      };
    });
    root.querySelectorAll('.btn-add-cat').forEach(btn => {
      btn.onclick = () => {
        manualCosts[btn.dataset.cat].push({ label: '', amount: 0 });
        saveCosts();
        renderEbitda();
      };
    });
  }
  const totals = {};
  COST_CATEGORIES.forEach(c => { totals[c.key] = catSubtotal(c.key); });
  totals.total = COST_CATEGORIES.reduce((s, c) => s + totals[c.key], 0);
  return totals;
}

// Holds the most recently rendered P&L waterfall + its context, so the
// "Download P&L" KPI tile can export exactly what's on screen without
// recomputing it.
let lastPL = null;

// Fetches assets/logo.png and re-encodes it as a PNG data URL via canvas, so
// jsPDF (which needs a data URL/ArrayBuffer, not a plain <img> src) can embed
// it. Same-origin, so the canvas is never tainted. Resolves null on any
// failure -- the PDF renders fine without the logo, it's cosmetic only.
function loadLogoDataUrl() {
  return new Promise(resolve => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          // Downscale before encoding -- the PDF only ever shows this at
          // ~32mm wide, so re-encoding the full source resolution (which can
          // be several MB once canvas PNG-encodes it) just bloats the file.
          const MAX_W = 440;
          const scale = Math.min(1, MAX_W / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * scale);
          c.height = Math.round(img.naturalHeight * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = 'assets/logo.png';
    } catch (_) { resolve(null); }
  });
}

async function downloadPLPdf() {
  if (!lastPL) return;
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load (offline?) -- use the CSV download instead.'); return; }
  const { gross, disc, net, cogs, grossProfit, labor, commission, controllable, occupancy, ga, eb, primeCost, from, to, channel, brand, location } = lastPL;
  const pctOf = v => net ? (Math.abs(v) / net * 100).toFixed(1) + '%' : '0.0%';
  const fmtAmt = v => (v < 0 ? '(' + Math.abs(v).toFixed(2) + ')' : v.toFixed(2));
  const ded = v => fmtAmt(-Math.abs(v));
  const opexTotal = labor + commission + controllable + occupancy + ga;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  let y = 16;

  const logo = await loadLogoDataUrl();
  if (logo) { try { doc.addImage(logo, 'PNG', pageW / 2 - 16, y, 32, 16); y += 20; } catch (_) {} }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(29, 29, 29);
  doc.text('FOODHIVE PROFIT & LOSS STATEMENT', pageW / 2, y, { align: 'center' });
  y += 4;
  doc.setDrawColor(29, 29, 29); doc.setLineWidth(0.5); doc.line(20, y, pageW - 20, y);
  y += 8;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 60, 60);
  doc.text(`Period: ${from} to ${to}`, 20, y);
  const ctx = [];
  if (channel !== 'All') ctx.push(`Channel: ${channel}`);
  if (brand !== 'All') ctx.push(`Brand: ${brand}`);
  if (location !== 'All') ctx.push(`Location: ${location}`);
  if (ctx.length) { y += 6; doc.text(ctx.join(' | '), 20, y); }
  y += 8;

  const body = [
    ['REVENUE', '', '', ''],
    ['Revenue', 'Gross Sales', gross.toFixed(2), pctOf(gross)],
    ['Revenue', '(-) Discounts', ded(disc), pctOf(disc)],
    ['Revenue', 'Net Sales (Total)', net.toFixed(2), '100.0%'],
    ['COST OF GOODS SOLD (COGS)', '', '', ''],
    ['COGS', 'Food & Beverage Cost', ded(cogs), pctOf(cogs)],
    ['GROSS PROFIT', '', fmtAmt(grossProfit), pctOf(grossProfit)],
    ['OPERATING EXPENSES', '', '', ''],
    ['Expenses', 'Labor Cost', ded(labor), pctOf(labor)],
    ['Expenses', 'Portal / Aggregator Commission', ded(commission), pctOf(commission)],
    ['Expenses', 'Other Controllable Expenses', ded(controllable), pctOf(controllable)],
    ['Expenses', 'Occupancy Costs', ded(occupancy), pctOf(occupancy)],
    ['Expenses', 'General & Administrative', ded(ga), pctOf(ga)],
    ['Expenses', 'Total', ded(opexTotal), pctOf(opexTotal)],
    ['EBITDA', '', fmtAmt(eb), pctOf(eb)]
  ];
  const sectionRows = [0, 4, 7], highlightRows = [6, 14], subtotalRows = [13];

  doc.autoTable({
    startY: y,
    head: [['Category', 'Description', 'Amount (AED)', 'Percentage']],
    body,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2.4, lineColor: [217, 223, 225], textColor: [29, 29, 29] },
    headStyles: { fillColor: [29, 29, 29], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
    didParseCell(data) {
      const i = data.row.index;
      if (sectionRows.includes(i) || highlightRows.includes(i)) {
        data.cell.styles.fillColor = [253, 203, 60]; data.cell.styles.fontStyle = 'bold';
      } else if (subtotalRows.includes(i)) {
        data.cell.styles.fillColor = [250, 240, 210]; data.cell.styles.fontStyle = 'bold';
      }
    }
  });

  let fy = doc.lastAutoTable.finalY + 8;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(90, 90, 90);
  doc.text(`Memo: Prime Cost (COGS + Labor) ${primeCost.toFixed(2)} AED, ${pctOf(primeCost)} of Net Sales`, 20, fy);
  fy += 12;
  doc.setDrawColor(217, 223, 225); doc.line(20, fy - 5, pageW - 20, fy - 5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90, 90, 90);
  doc.text(`Prepared by: FoodHive Operations & Sales Dashboard | Date: ${new Date().toLocaleDateString()} | FoodHive.com`, pageW / 2, fy, { align: 'center' });

  doc.save(`FoodHive_PL_${from}_to_${to}.pdf`);
}

function renderEbitda() {
  const O = base('ebitda').filter(o => !o.cancelled);
  const gross = sum(O, o => o.receiptTotal), disc = sum(O, o => o.discount), net = sum(O, o => o.netSales);
  const commission = sum(O, o => FHCommission.commissionForOrder(o));
  const costs = renderCostsBuilder(commission);

  const grossProfit = net - costs.cogs;
  const primeCost = costs.cogs + costs.labor;
  const afterLabor = grossProfit - costs.labor;
  const afterCommission = afterLabor - commission;
  const controllableProfit = afterCommission - costs.controllable;
  const afterOccupancy = controllableProfit - costs.occupancy;
  const eb = FHCommission.ebitda(net, commission, costs.total);

  kpis('kpi-ebitda', [
    ['Net Sales', money(net), false, () => { openEbitdaDrillModal(); }, false, 'Net Sales for the current filter. Click to view the full P&L waterfall.', 'drill'],

    ['Food Cost %', net ? pc(costs.cogs / net, 1) : '0%', false, () => {
      const el = document.getElementById('costsBuilder'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, false, 'Cost of Goods Sold / Net Sales', 'nav'],

    ['Prime Cost %', net ? pc(primeCost / net, 1) : '0%', false, () => { openEbitdaDrillModal(); }, false, 'Prime Cost = COGS + Labor, as % of Net Sales. The single most-watched F&B health metric — most operators target ≤60-65%. Click to view the full P&L waterfall.', 'drill'],

    ['Portal Commission %', net ? pc(commission / net, 1) : '0%', false, () => {
      show('commission');
    }, false, 'Commission / Net Sales. Click to see the full channel breakdown on the Commission page.', 'nav'],

    ['Controllable Profit %', net ? pc(controllableProfit / net, 1) : '0%', false, () => { openEbitdaDrillModal(); }, false, 'Controllable Profit = Gross Profit − Labor − Commission − Other Controllable Expenses, as % of Net Sales. Click to view the full P&L waterfall.', 'drill'],

    ['EBITDA', money(eb), false, () => { openEbitdaDrillModal(); }, false, 'Net Sales − Commission − all Operating Costs (COGS, Labor, Controllable, Occupancy, G&A). Click to view the full P&L waterfall.', 'drill'],

    ['EBITDA Margin %', net ? pc(eb / net, 1) : '0%', false, () => { openEbitdaDrillModal(); }, false, 'EBITDA / Net Sales. Click to view the full P&L waterfall.', 'drill'],

    ['Download P&L (PDF)', '⬇ PDF', false, downloadPLPdf, false, 'Download the P&L Summary above as a formatted PDF report for the current date range and filters', 'download']
  ]);

  const plRows = [
    { label: 'Gross Sales', amount: gross, cls: '' },
    { label: '(−) Discounts', amount: disc, cls: '' },
    { label: '= Net Sales', amount: net, cls: 'pl-sub' },
    { label: '(−) Cost of Goods Sold', amount: costs.cogs, cls: '' },
    { label: '= Gross Profit', amount: grossProfit, cls: 'pl-sub' },
    { label: '(−) Labor Cost', amount: costs.labor, cls: '' },
    { label: '(−) Portal / Aggregator Commission', amount: commission, cls: '' },
    { label: '(−) Other Controllable Expenses', amount: costs.controllable, cls: '' },
    { label: '= Controllable Profit', amount: controllableProfit, cls: 'pl-sub' },
    { label: '(−) Occupancy Costs', amount: costs.occupancy, cls: '' },
    { label: '(−) General & Administrative', amount: costs.ga, cls: '' },
    { label: '= EBITDA', amount: eb, cls: 'pl-total' }
  ];
  lastPL = {
    gross, disc, net, cogs: costs.cogs, grossProfit,
    labor: costs.labor, commission, controllable: costs.controllable, occupancy: costs.occupancy, ga: costs.ga,
    eb, primeCost,
    from: S.f.from, to: S.f.to, channel: S.f.channel, brand: S.f.brand, location: S.f.location,
    rows: plRows
  };

  const pl = $('#plTable');
  if (pl) {
    pl.innerHTML = `<thead><tr><th>Line</th><th>AED</th><th>% of Net Sales</th></tr></thead><tbody>
      ${plRows.map(r => `<tr class="${r.cls}"><td>${esc(r.label)}</td><td class="cost-amt">${money(r.amount)}</td><td class="cost-amt">${net ? pc(r.amount / net, 1) : '–'}</td></tr>`).join('')}
    </tbody>`;
  }
  const memo = $('#plMemo');
  if (memo) memo.textContent = `Prime Cost (COGS + Labor): ${money(primeCost)} — ${net ? pc(primeCost / net, 1) : '0%'} of Net Sales`;

  const dates = uniq(O.map(o => dkey(o.receivedAt))).sort();
  const byDate = {};
  O.forEach(o => {
    const k = dkey(o.receivedAt);
    const row = byDate[k] || (byDate[k] = { net: 0, comm: 0 });
    row.net += o.netSales;
    row.comm += FHCommission.commissionForOrder(o);
  });
  // Operating costs are entered as one lump sum for the whole selected
  // period, so they're spread evenly across the days shown here for the
  // trend line; the KPI tile above uses the exact lump-sum total.
  const dailyOtherCosts = dates.length ? costs.total / dates.length : 0;
  lineChart('c-ebitdatrend', dates, [
    { name: 'Net Sales', color: Y, data: dates.map(d => byDate[d] ? byDate[d].net : 0) },
    { name: 'Commission', color: '#e53935', data: dates.map(d => byDate[d] ? byDate[d].comm : 0) },
    { name: 'EBITDA', color: BLUE, data: dates.map(d => { const r = byDate[d] || { net: 0, comm: 0 }; return FHCommission.ebitda(r.net, r.comm, dailyOtherCosts); }) }
  ], { fmt: money });
}

// ---------------- render & navigation ----------------
const RENDER = { sales: renderSales, cancel: renderCancel, prep: renderPrep, ratings: renderRatings, items: renderItemsPage, delayed: renderDelayed, commission: renderCommission, ebitda: renderEbitda, export: renderExport };
function render() { RENDER[S.page](); }

function show(page) {
  S.page = page;
  destroyAllCharts();
  try { if (location.hash.slice(1) !== page) location.hash = page; } catch (_) {}
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + page));
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  if (page === 'prep' && $('#rangeCol') && !$('#rangeCol').children.length) initRanges();
  buildFilters();
  buildToggles();
  requestAnimationFrame(render);
}
$$('#nav a').forEach(a => a.onclick = () => show(a.dataset.page));
window.addEventListener('hashchange', () => {
  const p = location.hash.slice(1);
  if (RENDER[p] && p !== S.page) show(p);
});
$('#srchBrand').oninput = () => fillList('#lstBrand', '#srchBrand', uniq(S.orders.map(o => o.brand)).sort(), S.selBrands);
$('#srchLoc').oninput = () => fillList('#lstLoc', '#srchLoc', uniq(S.orders.map(o => o.location)).sort(), S.selLocs);

function setDates(from, to) {
  S.f.from = from; S.f.to = to;
  S.loadedRange = [from, to];
  const targetId = S.page === 'prep' ? 'filters-prep' : 'filters-' + S.page;
  const root = $('#' + targetId) || document;
  const a = $('#fFrom', root) || $('#fFrom'), b = $('#fTo', root) || $('#fTo');
  if (a && b) { a.value = from; b.value = to; }
  initDateSlider();
}
function fullRange() {
  const ts = S.orders.map(o => o.receivedAt).concat(S.items.map(i => i.at));
  if (!ts.length) return ['', ''];
  return [dkey(Math.min(...ts)), dkey(Math.max(...ts))];
}

// Sidebar Buttons
function resetFilters() {
  Object.keys(S.f).forEach(k => {
    if (k === 'ratingFilter') S.f[k] = 'all';
    else if (k === 'onlyDelayed') S.f[k] = false;
    else if (!['from', 'to'].includes(k)) S.f[k] = 'All';
  });
}

$('#btnAll').onclick = () => {
  resetFilters();
  S.selBrands.clear(); S.selLocs.clear();
  setDates(...fullRange());
  initRanges();
  buildFilters();
  render();
};
$('#btnPrev').onclick = () => {
  const [, hi] = fullRange();
  if (hi) {
    const d = new Date(hi + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    const k = dkey(d);
    setDates(k, k);
    render();
  }
};

// ---------------- data loading ----------------
function setData(orders, items, lineItems, source, label) {
  if (orders) S.orders = orders;
  if (items) S.items = items;
  if (lineItems) S.lineItems = lineItems;
  S.source = source;
  const badge = $('#srcBadge');
  if (badge) {
    badge.textContent = label;
    badge.className = 'src-badge ' + (source === 'live' ? 'live' : source === 'error' ? 'err' : '');
  }
  S.loadedRange = fullRange();
  S.selBrands.clear(); S.selLocs.clear();
  resetFilters();
  initRanges();
  buildFilters();
  buildToggles();
  render();
}
function log(msg) { $('#mLog').textContent += msg + '\n'; }

async function loadLive(from, to) {
  log('Contacting GrubCENTER…');
  try {
    const q = from && to ? `?from=${from}&to=${to}` : '';
    const [ordRes, availRes, oiRes] = await Promise.all([
      fetch('/api/orders' + q),
      fetch('/api/availability' + q),
      fetch('/api/order-items' + q)
    ]);
    const j = await ordRes.json();
    if (!ordRes.ok) throw new Error(j.error || 'Failed to fetch orders');
    let items = [];
    try { items = (await availRes.json()).items || []; } catch (_) {}
    let lineItems = [];
    try { lineItems = (await oiRes.json()).items || []; } catch (_) {}
    S.loadedRange = [from || dkey(Date.now() - 45 * 864e5), to || dkey(Date.now())];
    if (!j.orders.length) { log('GrubCENTER returned 0 orders for that range.'); }
    else log(`Loaded ${j.orders.length} orders.`);
    const keepFrom = from, keepTo = to;
    setData(j.orders, items.length ? items : S.items, lineItems.length ? lineItems : S.lineItems, 'live', `● Live · GrubCENTER (${j.orders.length})`);
    if (keepFrom) setDates(keepFrom, keepTo); else setDates(...fullRange());
    render();
    return true;
  } catch (e) {
    log('✗ ' + e.message);
    $('#srcBadge').textContent = 'Live unavailable'; $('#srcBadge').className = 'src-badge err';
    return false;
  }
}

// ================= PAGE 9: DATA EXPORT =================
// Raw-record export, deliberately separate from base()'s page-specific
// business rules (cancelled-exclusion, modifier-exclusion, revenue
// proration): this page exports the underlying records as they are, not a
// dashboard metric, so analysts can filter/dedupe themselves downstream.
function fmtDubaiTs(ms) {
  if (ms == null) return '';
  const d = dubaiDate(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(r => lines.push(headers.map(h => csvCell(r[h])).join(',')));
  return lines.join('\r\n');
}
function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadCSV(filename, headers, rows) {
  downloadBlob(filename, '﻿' + toCSV(headers, rows), 'text/csv;charset=utf-8;');
}
// Styled via xlsx-js-style (a drop-in SheetJS fork -- same XLSX.* API the
// CSV/XLSX import path already uses -- that additionally writes the `s`
// cell-style property: SheetJS Community Edition silently drops it).
const XLS_HEADER_STYLE = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1D1D1D' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: { bottom: { style: 'thin', color: { rgb: '000000' } } } };
const XLS_TOTAL_STYLE = { font: { bold: true }, fill: { fgColor: { rgb: 'FDCB3C' } }, border: { top: { style: 'thin', color: { rgb: '000000' } } } };
const XLS_SUBTOTAL_STYLE = { font: { bold: true }, fill: { fgColor: { rgb: 'F7F3E4' } } };
const XLS_MONEY_FMT = '#,##0.00';
const XLS_PCT_FMT = '0.0%';
function xlsCell(r, c, cell) { return { addr: XLSX.utils.encode_cell({ r, c }), cell }; }

// Builds a header row + one row per record + a bottom TOTAL row with live
// SUM() formulas over the numeric/money columns -- "full of formula" per the
// brief, applied as a real spreadsheet total rather than a pre-computed
// static number, so it recalculates if a cell is edited.
function downloadXLSX(filename, sheetName, headers, rows, moneyHeaders) {
  const wb = XLSX.utils.book_new();
  const ws = {};
  const moneySet = new Set(moneyHeaders || []);
  headers.forEach((h, c) => { const { addr, cell } = xlsCell(0, c, { t: 's', v: h, s: XLS_HEADER_STYLE }); ws[addr] = cell; });
  rows.forEach((row, ri) => {
    const r = ri + 1;
    headers.forEach((h, c) => {
      const v = row[h];
      let cell;
      if (typeof v === 'number') cell = { t: 'n', v, ...(moneySet.has(h) ? { z: XLS_MONEY_FMT } : {}) };
      else if (typeof v === 'boolean') cell = { t: 'b', v };
      else cell = { t: 's', v: v == null ? '' : String(v) };
      ws[XLSX.utils.encode_cell({ r, c })] = cell;
    });
  });
  const totalR = rows.length + 1;
  headers.forEach((h, c) => {
    const addr = XLSX.utils.encode_cell({ r: totalR, c });
    if (c === 0) { ws[addr] = { t: 's', v: `TOTAL (${rows.length})`, s: XLS_TOTAL_STYLE }; return; }
    const isNumericCol = rows.length > 0 && typeof rows[0][h] === 'number';
    if (!isNumericCol) { ws[addr] = { t: 's', v: '', s: XLS_TOTAL_STYLE }; return; }
    const col = XLSX.utils.encode_col(c);
    ws[addr] = { t: 'n', f: `SUM(${col}2:${col}${rows.length + 1})`, s: XLS_TOTAL_STYLE, ...(moneySet.has(h) ? { z: XLS_MONEY_FMT } : {}) };
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: totalR, c: headers.length - 1 } });
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 12) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// Dedicated P&L workbook: unlike the raw-data exports above, this is NOT a
// record dump -- it's a financial statement, so the waterfall subtotals
// (Net Sales, Gross Profit, Controllable Profit, EBITDA) are written as
// live formulas referencing the input lines, and the % column is a formula
// against the Net Sales cell, not a pre-computed static value. Editing an
// input cell (e.g. COGS) recalculates every subtotal and percentage below it,
// same as a real accounting template.
function downloadPlXlsx(filename, pl) {
  const wb = XLSX.utils.book_new();
  const ws = {};
  const set = (r, c, cell) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };
  set(0, 0, { t: 's', v: `FoodHive P&L Report — ${pl.from} to ${pl.to}`, s: { font: { bold: true, sz: 13 }, fill: { fgColor: { rgb: 'FDCB3C' } }, alignment: { horizontal: 'center' } } });
  ['Line', 'Amount (AED)', '% of Net Sales'].forEach((h, c) => set(1, c, { t: 's', v: h, s: XLS_HEADER_STYLE }));

  // r = 0-indexed sheet row; NET_R is the Net Sales row, referenced by every % formula.
  const money = v => ({ t: 'n', v: round2(v), z: XLS_MONEY_FMT });
  const pct = r => ({ t: 'n', f: `B${r + 1}/$B$${NET_R + 1}`, z: XLS_PCT_FMT });
  const label = (r, text, style) => set(r, 0, { t: 's', v: text, s: style });
  const NET_R = 4, GP_R = 6, CP_R = 10, EB_R = 13;

  label(2, 'Gross Sales'); set(2, 1, money(pl.gross)); set(2, 2, pct(2));
  label(3, '(−) Discounts'); set(3, 1, money(pl.disc)); set(3, 2, pct(3));
  label(NET_R, '= Net Sales', XLS_SUBTOTAL_STYLE); set(NET_R, 1, { t: 'n', f: `B3-B4`, z: XLS_MONEY_FMT, s: XLS_SUBTOTAL_STYLE }); set(NET_R, 2, { ...pct(NET_R), s: XLS_SUBTOTAL_STYLE });
  label(5, '(−) Cost of Goods Sold'); set(5, 1, money(pl.cogs)); set(5, 2, pct(5));
  label(GP_R, '= Gross Profit', XLS_SUBTOTAL_STYLE); set(GP_R, 1, { t: 'n', f: `B${NET_R + 1}-B6`, z: XLS_MONEY_FMT, s: XLS_SUBTOTAL_STYLE }); set(GP_R, 2, { ...pct(GP_R), s: XLS_SUBTOTAL_STYLE });
  label(7, '(−) Labor Cost'); set(7, 1, money(pl.labor)); set(7, 2, pct(7));
  label(8, '(−) Portal / Aggregator Commission'); set(8, 1, money(pl.commission)); set(8, 2, pct(8));
  label(9, '(−) Other Controllable Expenses'); set(9, 1, money(pl.controllable)); set(9, 2, pct(9));
  label(CP_R, '= Controllable Profit', XLS_SUBTOTAL_STYLE); set(CP_R, 1, { t: 'n', f: `B${GP_R + 1}-B8-B9-B10`, z: XLS_MONEY_FMT, s: XLS_SUBTOTAL_STYLE }); set(CP_R, 2, { ...pct(CP_R), s: XLS_SUBTOTAL_STYLE });
  label(11, '(−) Occupancy Costs'); set(11, 1, money(pl.occupancy)); set(11, 2, pct(11));
  label(12, '(−) General & Administrative'); set(12, 1, money(pl.ga)); set(12, 2, pct(12));
  label(EB_R, '= EBITDA', XLS_TOTAL_STYLE); set(EB_R, 1, { t: 'n', f: `B${CP_R + 1}-B12-B13`, z: XLS_MONEY_FMT, s: XLS_TOTAL_STYLE }); set(EB_R, 2, { ...pct(EB_R), s: XLS_TOTAL_STYLE });
  label(15, 'Prime Cost (COGS + Labor)'); set(15, 1, { t: 'n', f: 'B6+B8', z: XLS_MONEY_FMT }); set(15, 2, pct(15));

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 15, c: 2 } });
  ws['!cols'] = [{ wch: 34 }, { wch: 16 }, { wch: 14 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  XLSX.utils.book_append_sheet(wb, ws, 'P&L');
  XLSX.writeFile(wb, filename);
}

const ORDER_COLUMNS = ['Order ID', 'Received At', 'Accepted At', 'Started At', 'Prepared At', 'Sent to Dispatcher At', 'Dispatched At', 'Delivered At', 'Brand', 'Cuisine', 'Location', 'Channel', 'Payment Method', 'Delivery Partner', 'Net Sales (AED)', 'Receipt Total (AED)', 'Discount (AED)', 'Cancelled', 'Cancelled After Accept', 'Cancellation Reason', 'Rating', 'Estimated Prep Time (min)'];
const round2 = n => Math.round((n || 0) * 100) / 100;
function mapOrderRow(o) {
  return {
    'Order ID': o.id, 'Received At': fmtDubaiTs(o.receivedAt), 'Accepted At': fmtDubaiTs(o.acceptedAt),
    'Started At': fmtDubaiTs(o.startedAt), 'Prepared At': fmtDubaiTs(o.preparedAt), 'Sent to Dispatcher At': fmtDubaiTs(o.stdAt),
    'Dispatched At': fmtDubaiTs(o.dispatchedAt), 'Delivered At': fmtDubaiTs(o.deliveredAt),
    Brand: o.brand, Cuisine: o.cuisine, Location: o.location, Channel: o.channel, 'Payment Method': o.payment, 'Delivery Partner': o.partner,
    'Net Sales (AED)': round2(o.netSales), 'Receipt Total (AED)': round2(o.receiptTotal), 'Discount (AED)': round2(o.discount),
    Cancelled: o.cancelled, 'Cancelled After Accept': o.postCancelled, 'Cancellation Reason': o.reason,
    Rating: o.rating == null ? '' : o.rating, 'Estimated Prep Time (min)': o.estPrep == null ? '' : o.estPrep
  };
}

const LINE_ITEM_COLUMNS = ['Order ID', 'Item', 'Item ID', 'Modifier', 'Modifier ID', 'Line Type', 'Quantity', 'Unit Price (AED)', 'Line Total (AED)', 'Item Discount (AED)', 'Brand', 'Location', 'Channel', 'Order Date/Time'];
function mapLineItemRow(x) {
  return {
    'Order ID': x.orderId, Item: x.item, 'Item ID': x.itemId, Modifier: x.modifier, 'Modifier ID': x.modifierId, 'Line Type': x.type,
    Quantity: x.qty, 'Unit Price (AED)': round2(x.unitPrice), 'Line Total (AED)': round2(x.lineTotal), 'Item Discount (AED)': round2(x.discount),
    Brand: x.brand, Location: x.location, Channel: x.channel, 'Order Date/Time': fmtDubaiTs(x.at)
  };
}

const EVENT_COLUMNS = ['Item', 'Brand', 'Cuisine', 'Location', 'Type', 'Source', 'Event Date/Time'];
function mapEventRow(x) {
  return { Item: x.item, Brand: x.brand, Cuisine: x.cuisine, Location: x.location, Type: x.type, Source: x.source, 'Event Date/Time': fmtDubaiTs(x.at) };
}

const PL_COLUMNS = ['Line', 'Amount (AED)', '% of Net Sales'];
function mapPlRow(r, net) {
  return { Line: r.label, 'Amount (AED)': round2(r.amount), '% of Net Sales': net ? pc(r.amount / net, 1) : '–' };
}

function exportOrdersInRange() {
  return S.orders.filter(o => dateOk(o.receivedAt) && eq(o.brand, S.f.brand) && eq(o.location, S.f.location));
}
function exportLineItemsInRange() {
  return S.lineItems.filter(x => dateOk(x.at) && eq(x.brand, S.f.brand) && eq(x.location, S.f.location));
}
function exportEventsInRange() {
  return S.items.filter(x => dateOk(x.at) && eq(x.brand, S.f.brand) && eq(x.location, S.f.location));
}
// renderEbitda() computes the P&L through base('ebitda'), which also filters
// on channel/payment/partner/day/slot/hour -- global S.f fields that persist
// from whatever page the user was last on and aren't shown on this page's
// filter bar. Neutralizing them here guarantees the exported P&L is governed
// by only the 3 filters visible on screen, not a hidden leftover filter.
function computeExportPL() {
  const neutral = ['channel', 'payment', 'partner', 'day', 'slot', 'hour'];
  const saved = {};
  neutral.forEach(k => { saved[k] = S.f[k]; S.f[k] = 'All'; });
  try { renderEbitda(); return lastPL; }
  finally { neutral.forEach(k => { S.f[k] = saved[k]; }); }
}

function renderExport() {
  const orders = exportOrdersInRange();
  const lines = exportLineItemsInRange();
  const events = exportEventsInRange();
  $('#expOrdersCount').textContent = `${cnt(orders.length)} orders in range`;
  $('#expItemsCount').textContent = `${cnt(lines.length)} item-sale lines in range`;
  $('#expEventsCount').textContent = `${cnt(events.length)} 86/out-of-stock events in range`;
  const pl = computeExportPL();
  $('#expPLSummary').textContent = pl ? `Net Sales ${money(pl.net)} · EBITDA ${money(pl.eb)} in range` : 'No data for range';
}

const ORDER_MONEY_COLS = ['Net Sales (AED)', 'Receipt Total (AED)', 'Discount (AED)'];
const LINE_ITEM_MONEY_COLS = ['Unit Price (AED)', 'Line Total (AED)', 'Item Discount (AED)'];

function wireExportButtons() {
  const fname = (name, ext) => `FoodHive_${name}_${S.f.from || 'all'}_to_${S.f.to || 'all'}.${ext}`;
  $('#expOrdersCsv').onclick = () => downloadCSV(fname('Orders', 'csv'), ORDER_COLUMNS, exportOrdersInRange().map(mapOrderRow));
  $('#expOrdersXlsx').onclick = () => downloadXLSX(fname('Orders', 'xlsx'), 'Orders', ORDER_COLUMNS, exportOrdersInRange().map(mapOrderRow), ORDER_MONEY_COLS);
  $('#expItemsCsv').onclick = () => downloadCSV(fname('ItemSales', 'csv'), LINE_ITEM_COLUMNS, exportLineItemsInRange().map(mapLineItemRow));
  $('#expItemsXlsx').onclick = () => downloadXLSX(fname('ItemSales', 'xlsx'), 'Item Sales', LINE_ITEM_COLUMNS, exportLineItemsInRange().map(mapLineItemRow), LINE_ITEM_MONEY_COLS);
  $('#expEventsCsv').onclick = () => downloadCSV(fname('86Events', 'csv'), EVENT_COLUMNS, exportEventsInRange().map(mapEventRow));
  $('#expEventsXlsx').onclick = () => downloadXLSX(fname('86Events', 'xlsx'), '86 Events', EVENT_COLUMNS, exportEventsInRange().map(mapEventRow), []);
  $('#expPlCsv').onclick = () => {
    const pl = computeExportPL(); if (!pl) return;
    downloadCSV(fname('PL', 'csv'), PL_COLUMNS, pl.rows.map(r => mapPlRow(r, pl.net)));
  };
  $('#expPlXlsx').onclick = () => {
    const pl = computeExportPL(); if (!pl) return;
    downloadPlXlsx(fname('PL', 'xlsx'), pl);
  };
  $('#expPlPdf').onclick = () => {
    const pl = computeExportPL(); if (!pl) return;
    downloadPLPdf();
  };
}

// CSV / XLSX import
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const h = rows.shift().map(x => x.trim());
  return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
async function readFile(file) {
  if (/\.csv$/i.test(file.name)) return parseCSV(await file.text());
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}
$('#mFile').onchange = async e => {
  let orders = null, items = null;
  for (const f of e.target.files) {
    try {
      const rows = await readFile(f);
      if (NZ.isItemDataset(rows)) { items = NZ.normalizeItems(rows); log(`${f.name}: ${items.length} item-availability events`); }
      else { const o = NZ.normalizeOrders(rows); orders = (orders || []).concat(o); log(`${f.name}: ${o.length} orders`); }
    } catch (err) { log(`✗ ${f.name}: ${err.message} (password-protected workbooks can't be read – save a copy without a password)`); }
  }
  if (orders || items) { setData(orders, items, null, 'import', `Imported file data (${(orders || S.orders).length})`); setDates(...fullRange()); render(); }
  e.target.value = '';
};
$('#mDemo').onclick = () => { loadDemo(); log('Demo data loaded.'); };
$('#mLive').onclick = async () => { const ok = await loadLive(); if (ok) $('#modal').hidden = true; };
if ($('#mCached')) $('#mCached').onclick = async () => { await loadCached(); };
$('#btnData').onclick = () => { $('#modal').hidden = false; $('#mStatus').textContent = $('#srcBadge').textContent; };

let syncPolling = false;
async function syncNow() {
  if (syncPolling) return;
  const btn = $('#btnSync'), msg = $('#syncMsg');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '⏳ Syncing…';
  if (msg) { msg.textContent = ''; msg.className = 'sync-msg'; }
  const done = (text, cls) => {
    if (msg) { msg.textContent = text; msg.className = 'sync-msg' + (cls ? ' ' + cls : ''); }
    btn.disabled = false; btn.textContent = '🔄 Sync Now';
    syncPolling = false;
  };
  try {
    const before = await fetch('/api/status').then(r => r.json()).then(j => j.lastSync || 0).catch(() => 0);
    const range = (S.f.from && S.f.to) ? `?from=${S.f.from}&to=${S.f.to}` : '';
    const res = await fetch('/api/refresh' + range).then(r => r.json());
    if (res.configured === false) { done(res.message || 'GrubCENTER not configured on this server', 'err'); return; }
    syncPolling = true;
    const deadline = Date.now() + 90000;
    (async function poll() {
      if (Date.now() > deadline) { done('Still syncing in the background — check back shortly'); return; }
      const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
      if (st && st.lastSync > before) {
        const [ordRes, availRes, oiRes] = await Promise.all([fetch('/api/orders'), fetch('/api/availability'), fetch('/api/order-items')]);
        const ordData = await ordRes.json();
        let items = S.items;
        try { const itJson = await availRes.json(); if (itJson.items) items = itJson.items; } catch (_) {}
        let lineItems = S.lineItems;
        try { const oiJson = await oiRes.json(); if (oiJson.items) lineItems = oiJson.items; } catch (_) {}
        setData(ordData.orders, items, lineItems, 'live', `● Live · GrubCENTER (${ordData.orders.length})`);
        done(`✓ Synced — ${ordData.orders.length} orders`, 'ok');
        return;
      }
      setTimeout(poll, 2500);
    })();
  } catch (e) {
    done('✗ ' + e.message, 'err');
  }
}
if ($('#btnSync')) $('#btnSync').onclick = syncNow;
$('#mClose').onclick = () => { $('#modal').hidden = true; };
if ($('#dailyModalClose')) $('#dailyModalClose').onclick = () => { $('#dailyModal').hidden = true; };
if ($('#dailyModalClose2')) $('#dailyModalClose2').onclick = () => { $('#dailyModal').hidden = true; };
if ($('#dailyModalReset')) $('#dailyModalReset').onclick = () => { setDates(...fullRange()); dateChanged(); renderDailyBreakdownTable(); };
if ($('#dailyModal')) {
  $('#dailyModal').onclick = e => {
    if (e.target === $('#dailyModal')) $('#dailyModal').hidden = true;
  };
}
if ($('#kpiModalClose')) $('#kpiModalClose').onclick = () => { $('#kpiModal').hidden = true; };
if ($('#kpiModalClose2')) $('#kpiModalClose2').onclick = () => { $('#kpiModal').hidden = true; };
if ($('#kpiModal')) {
  $('#kpiModal').onclick = e => {
    if (e.target === $('#kpiModal')) $('#kpiModal').hidden = true;
  };
}
if ($('#expOrdersCsv')) wireExportButtons();

async function loadCached() {
  log('Loading FoodHive decrypted exports…');
  try {
    const r = await fetch('/api/cached-exports');
    const j = await r.json();
    if (!j.orders || !j.orders.length) throw new Error('No export orders found.');
    log(`Loaded ${j.orders.length} orders & ${(j.items || []).length} 86-items.`);
    setData(j.orders, j.items || [], j.orderItems || [], 'exports', `● FoodHive Exports (${j.orders.length})`);
    setDates(...fullRange());
    render();
    $('#modal').hidden = true;
    return true;
  } catch (e) {
    log('✗ ' + e.message);
    return false;
  }
}

// ---------------- demo data (FoodHive fallback) ----------------
function loadDemo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a, w) => { if (!w) return a[Math.floor(rnd() * a.length)]; let t = rnd() * w.reduce((x, y) => x + y, 0); for (let i = 0; i < a.length; i++) { t -= w[i]; if (t <= 0) return a[i]; } return a[a.length - 1]; };
  const brands = [['Manakeesh Corner Dine In', 'Arabic', 4], ['The Burger Company', 'Burger', 2], ['The Pasta Company', 'Pasta', 2], ['Alfredo Pasta', 'Pasta', 1.5], ['Firebox Pizza', 'Pizza', 1], ['Rukn Al Manakeesh', 'Arabic', 1], ['Dukkan Al-Mankoush', 'Arabic', .8], ['Simply Burgers', 'Burger', .8]];
  const locs = ['Motor City'];
  const lw = [1];
  const chans = ['Deliveroo', 'Careem', 'Take Away', 'Talabat', 'Noon', 'Pickup', 'Keeta 2.0', 'Dine-in'], cw = [10, 6, 5, 3, 2, 0.8, 0.5, 0.1];
  const reasons = ['Item Out of Stock', 'Kitchen Busy / Long Prep Time', 'Customer Changed Mind', 'Aggregator Rider Unavailable'];
  const hw = [1, .7, .5, .3, .3, .5, 1, 1.5, 2, 2.5, 3, 4, 5.5, 5, 3.5, 3, 3.2, 3.6, 4.2, 5, 5.5, 4.5, 3.5, 2];
  const bq = Object.fromEntries(brands.map(b => [b[0], rnd() * 1.2 - 0.9]));
  const orders = []; const now = new Date(); now.setHours(0, 0, 0, 0);
  const N = 2600;
  for (let i = 0; i < N; i++) {
    const [brand, cuisine] = pick(brands, brands.map(b => b[2]));
    const loc = pick(locs, lw); const day = Math.floor(rnd() * 60);
    const h = pick([...Array(24).keys()], hw);
    const t0 = new Date(now); t0.setDate(t0.getDate() - day); t0.setHours(h, Math.floor(rnd() * 60), Math.floor(rnd() * 60)); if (t0 > Date.now()) continue;
    const channel = pick(chans, cw); const gross = 25 + Math.exp(rnd() * 2.2) * 8; const dr = rnd() < .45 ? 0.1 + rnd() * .4 : 0; const disc = gross * dr;
    const cancelled = rnd() < .056; const accepted = t0.getTime() + (30 + rnd() * 150) * 1000; const m = 60000;
    const brandSlow = 1 + (bq[brand] < -.5 ? .5 : 0);
    const started = accepted + (0.2 + rnd() * 2) * m * brandSlow, prepared = started + (6 + rnd() * 16) * m * brandSlow, std = prepared + (0.3 + rnd() * 3) * m;
    const disp = std + (0.3 + rnd() * 2.5) * m, deliv = disp + (8 + rnd() * 18) * m;
    const r = rnd(); const base5 = 4.6 + bq[brand] + (rnd() - .5) * 1.4;
    orders.push({
      id: 'D' + (100000 + i), receivedAt: t0.getTime(), acceptedAt: accepted, startedAt: cancelled ? null : started, preparedAt: cancelled ? null : prepared, stdAt: cancelled ? null : std, dispatchedAt: cancelled ? null : disp, deliveredAt: cancelled ? null : deliv,
      brand, cuisine, location: loc, channel, payment: pick(['Online', 'Prepaid'], [6, 4]), partner: channel,
      netSales: +(gross - disc).toFixed(2), receiptTotal: +gross.toFixed(2), discount: +disc.toFixed(2), cancelled, postCancelled: cancelled && rnd() < .5, reason: cancelled ? pick(reasons) : '',
      rating: !cancelled && r < .55 ? Math.max(1, Math.min(5, Math.round(base5))) : null, estPrep: pick([12, 15, 18, 20], [1, 3, 3, 1])
    });
  }
  const itemNames = { Arabic: ['Zaatar Manakish', 'Cheese Manakish', 'Meat Fatayer'], Pasta: ['Alfredo Pasta', 'Arrabiata'], Burger: ['Classic Burger', 'Crispy Chicken'], Pizza: ['Margherita Pizza', 'Pepperoni'] };
  const items = [];
  for (let i = 0; i < 87; i++) {
    const [brand, cuisine] = pick(brands, brands.map(b => b[2])); const t = new Date(now); t.setDate(t.getDate() - Math.floor(rnd() * 30)); t.setHours(Math.floor(rnd() * 24));
    items.push({ item: pick(itemNames[cuisine] || ['Special Combo']), brand, cuisine, location: 'Motor City', type: 'Menu Item', source: pick(['Master GrubKDS', 'Master'], [8, 2]), at: t.getTime() });
  }
  const lineItems = [];
  orders.forEach(o => {
    if (o.cancelled) return;
    const names = itemNames[o.cuisine] || ['Special Combo'];
    const lineCount = pick([1, 2], [3, 1]);
    for (let n = 0; n < lineCount; n++) {
      const qty = pick([1, 1, 1, 2], null);
      lineItems.push({
        orderId: o.id, item: pick(names), itemId: '', modifier: '', modifierId: '', type: 'Menu Item',
        qty, unitPrice: o.receiptTotal / lineCount, lineTotal: (o.netSales / lineCount) * qty, discount: o.discount / lineCount,
        brand: o.brand, location: o.location, channel: o.channel, at: o.receivedAt
      });
    }
  });
  setData(orders, items, lineItems, 'demo', '◌ Demo data (not live)');
  setDates(...fullRange()); render();
}

// ---------------- instant parallel boot ----------------
(async function boot() {
  const initialPage = RENDER[location.hash.slice(1)] ? location.hash.slice(1) : 'sales';

  // 1. Immediately fetch pre-warmed FoodHive master orders in parallel (<15ms)
  try {
    const [ordRes, availRes, oiRes] = await Promise.all([
      fetch('/api/orders'),
      fetch('/api/availability'),
      fetch('/api/order-items')
    ]);
    if (ordRes.ok) {
      const ordData = await ordRes.json();
      let items = [];
      try { items = (await availRes.json()).items || []; } catch (_) {}
      let lineItems = [];
      try { lineItems = (await oiRes.json()).items || []; } catch (_) {}
      if (ordData && ordData.orders && ordData.orders.length) {
        setData(ordData.orders, items, lineItems, 'live', `● Live · GrubCENTER (${ordData.orders.length})`);
        setDates(...getDefaultPeriod());
        show(initialPage);
      }
    }
  } catch (err) {
    console.warn('Fast boot error:', err);
  }

  // Fallback if needed
  if (!S.orders.length) {
    try { await loadCached(); } catch (_) { loadDemo(); }
    show(initialPage);
  }

  // 2. Check live status non-blockingly in the background
  fetch('/api/status').then(r => r.json()).then(st => {
    if (st && st.connected) {
      const badge = $('#srcBadge');
      if (badge) {
        badge.textContent = `● Live · GrubCENTER (${S.orders.length})`;
        badge.className = 'src-badge live';
      }
    }
  }).catch(() => {});

  // 3. Client auto-refresh every 10 minutes from server
  setInterval(async () => {
    try {
      const [ordRes, availRes, oiRes] = await Promise.all([
        fetch('/api/orders'),
        fetch('/api/availability'),
        fetch('/api/order-items')
      ]);
      if (ordRes.ok) {
        const ordData = await ordRes.json();
        let items = S.items;
        try { const itJson = await availRes.json(); if (itJson.items) items = itJson.items; } catch (_) {}
        let lineItems = S.lineItems;
        try { const oiJson = await oiRes.json(); if (oiJson.items) lineItems = oiJson.items; } catch (_) {}
        if (ordData && ordData.orders && ordData.orders.length) {
          setData(ordData.orders, items, lineItems, 'live', `● Live · GrubCENTER (${ordData.orders.length})`);
          render();
        }
      }
    } catch (_) {}
  }, 10 * 60 * 1000);

  window.S = S;
  window.show = show;
  window.render = render;
  window.charts = charts;
  window.timeRangeForGrain = timeRangeForGrain;
  window.syncFilterUI = syncFilterUI;
  window.FoodHive = { S, show, render, setData, base, syncFilterUI, charts };
})();
})();
