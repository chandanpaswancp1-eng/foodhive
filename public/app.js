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
  return d >= 0 && d <= 180 ? d : null;
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
  orders: [], items: [], source: 'none', page: 'sales', loadedRange: null,
  f: { from: '', to: '', channel: 'All', brand: 'All', location: 'All', payment: 'All', day: 'All', partner: 'All', reason: 'All', post: 'All', ratingFilter: 'all', onlyDelayed: false },
  ui: { metric: 'sales', group: 'cuisine', grain: 'Daily', cmetric: 'orders', cgroup: 'brand', pgroup: 'brand', rgroup: 'cuisine', igroup: 'brand', dgroup: 'brand', rmode: 'estimated' },
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
function mk(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const el = document.getElementById(id); if (!el) return;
  const p = el.parentElement; $$('.empty', p).forEach(e => e.remove());
  if (cfg.__empty) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No data for current filters'; p.appendChild(e); return;
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
  opts.onClick = (e, elements, chart) => {
    if (!elements || !elements.length) return;
    const idx = elements[0].index;
    const label = chart.data.labels[idx];
    if (!label) return;
    const cur = S.f[filterKey];
    S.f[filterKey] = (cur === label ? 'All' : label);
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
  const colors = rows.map(r => (curF !== 'All' && r.k !== curF ? '#FEEBB4' : color));

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
  const colors = rows.map(r => (curF !== 'All' && r.k !== curF ? '#FEEBB4' : color));
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
        backgroundColor: rows.map((r, i) => pal[i % pal.length]),
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
  const colors = rows.map(r => (curF !== 'All' && r.k !== curF ? '#FEEBB4' : color));
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
    discPct: sales ? (disc / sales) * 100 : 0
  };
});
const metricOf = (r, metric) => {
  if (metric === 'sales') return r.sales;
  if (metric === 'orders') return r.orders;
  if (metric === 'receipt') return r.receipt;
  if (metric === 'aov') return r.aov;
  if (metric === 'disc') return r.disc;
  if (metric === 'discPct') return r.discPct;
  return r.sales;
};
const metricFmt = metric => {
  if (metric === 'orders') return cnt;
  if (metric === 'discPct') return n => n.toFixed(1) + '%';
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
    if (page === 'sales') return eq(o.channel, f.channel) && eq(o.payment, f.payment) && eq(o.partner, f.partner) && (f.day === 'All' || dowOf(o.receivedAt) === f.day);
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
  delayed: [['brand', 'Brand'], ['location', 'Branch'], ['dates', 'Received At']]
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

function buildFilters() {
  const targetId = S.page === 'prep' ? 'filters-prep' : `filters-${S.page}`;
  const el = $('#' + targetId); if (!el) return;
  el.innerHTML = '';
  const list = FILTERS[S.page] || [];

  list.forEach(([key, label]) => {
    const d = document.createElement('div');
    if (key === 'dates') {
      d.className = 'fbox dates';
      d.innerHTML = `
        <label>${label} <span class="chevron">⌄</span></label>
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

  function updateBar() {
    const p1 = Math.min(+slFr.value, +slTo.value);
    const p2 = Math.max(+slFr.value, +slTo.value);
    if (bar) {
      bar.style.left = (p1 / 10) + '%';
      bar.style.width = ((p2 - p1) / 10) + '%';
    }
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
      add(top, 'Net Sales | Total Orders', 'metric', [['sales', 'Net Sales'], ['orders', 'Total Orders']]);
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
  container.innerHTML = list.map(([h, v, wide, , isActive, tooltip], idx) => {
    const act = isActive ? ' active' : '';
    const tip = tooltip ? ` title="${esc(tooltip)}"` : ' title="Click to filter/reflect data"';
    return `<div class="kpi${wide ? ' wide' : ''}${act}" data-idx="${idx}"${tip} role="button" tabindex="0">
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

function renderSales() {
  const all = base('sales'); const O = all.filter(o => !o.cancelled);
  const net = sum(O, o => o.netSales), rec = sum(O, o => o.receiptTotal), disc = sum(O, o => o.discount), n = O.length;
  const days = uniq(O.map(o => dkey(o.receivedAt))).length || 1;
  const run = net / days;
  const top = salesAgg(O, o => o.brand).sort((a, b) => b.sales - a.sales)[0];

  const m = S.ui.metric;
  const mnameMap = {
    sales: 'Net Sales',
    orders: 'Total Orders',
    receipt: 'Receipt Total',
    aov: 'Average Order Value (AOV)',
    disc: 'Total Discount',
    discPct: 'Discount %'
  };
  const mname = mnameMap[m] || 'Net Sales';
  const mf = metricFmt(m);

  kpis('kpi-sales', [
    ['Net Sales', money(net), false, () => { S.ui.metric = 'sales'; buildToggles(); renderSales(); }, m === 'sales', 'Click to view Net Sales across all charts'],
    ['Receipt Total', money(rec), false, () => { S.ui.metric = (m === 'receipt' ? 'sales' : 'receipt'); buildToggles(); renderSales(); }, m === 'receipt', 'Click to view Receipt Total (Gross) across all charts'],
    ['Total Orders', cnt(n), false, () => { S.ui.metric = 'orders'; buildToggles(); renderSales(); }, m === 'orders', 'Click to view Order Volume counts across all charts'],
    ['AOV', n ? (net / n).toFixed(2) : '0', false, () => { S.ui.metric = (m === 'aov' ? 'sales' : 'aov'); buildToggles(); renderSales(); }, m === 'aov', 'Click to view Average Order Value (AOV) across all charts'],
    ['Total Discount', money(disc), false, () => {
      S.ui.metric = (m === 'disc' ? 'sales' : 'disc');
      buildToggles();
      renderSales();
      const el = document.getElementById('c-disc');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, m === 'disc', 'Click to view Total Discounts across all charts'],
    ['Discount %', net ? pc(disc / net, 2) : '0%', false, () => { S.ui.metric = (m === 'discPct' ? 'sales' : 'discPct'); buildToggles(); renderSales(); }, m === 'discPct', 'Click to view Discount % burn across all charts'],
    ['Avg RunRate', money(run), false, () => {
      S.ui.grain = (S.ui.grain === 'Daily' ? 'Monthly' : 'Daily');
      renderSales();
      const el = document.getElementById('c-time');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, false, 'Click to toggle Daily vs Monthly run-rate in trend chart'],
    ['Projected RR', money(run * 30), false, () => {
      S.ui.grain = (S.ui.grain === 'Monthly' ? 'Daily' : 'Monthly');
      renderSales();
      const el = document.getElementById('c-time');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, false, 'Click to toggle 30-day projected run-rate view'],
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
  
  const bOpts = baseOpts({
    scales: { x: { ...gridless, ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 12); } } }, y: { display: false, beginAtZero: true } }
  });
  addBarClick(bOpts, r => r.k, S.ui.group === 'brand' ? 'brand' : 'cuisine');
  mk('c-brand', br.length ? {
    type: 'bar',
    data: { labels: br.map(r => r.k), datasets: [{ label: mname, data: br.map(r => r.v), backgroundColor: Y, datalabels: lbl(mf) }] },
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
    phTime.title = `Currently viewing ${mname}. Click to toggle Net Sales | Total Orders`;
    phTime.onclick = () => {
      S.ui.metric = (S.ui.metric === 'sales' ? 'orders' : 'sales');
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
  combo('c-slot', sl.map(r => ({ k: r.k, v: metricOf(r, m) })), { name: mname, pctName: '%GT Total Orders', fmt: mf });
  patchPct('c-slot', sl, n);

  hbar('c-chan', salesAgg(O, o => o.channel).map(r => ({ k: r.k, v: metricOf(r, m) })).sort((a, b) => b.v - a.v), { fmt: mf, name: mname, filterKey: 'channel' });

  // date & time of day
  const tods = ['Morning', 'Afternoon', 'Evening', 'Night'];
  const cols = { Morning: K, Afternoon: Y, Evening: '#ff7043', Night: '#1e88e5' };
  const dates = uniq(O.map(o => dkey(o.receivedAt))).sort();
  const tmap = {};
  O.forEach(o => {
    const k = todOf(dubaiHour(o.receivedAt)) + '|' + dkey(o.receivedAt);
    tmap[k] = (tmap[k] || 0) + (m === 'orders' ? 1 : m === 'receipt' ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
  });
  lineChart('c-tod', dates, tods.map(t => ({ name: t, color: cols[t], data: dates.map(d => tmap[t + '|' + d] || 0) })), { fmt: mf });

  const hr = Array.from({ length: 24 }, (_, h) => ({ k: String(h), v: 0, o: 0 }));
  O.forEach(o => {
    const h = dubaiHour(o.receivedAt);
    hr[h].v += (m === 'orders' ? 1 : m === 'receipt' ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
    hr[h].o++;
  });
  combo('c-hour', hr, { name: mname, pctName: '%GT Total Orders', fmt: mf });
  patchPct('c-hour', hr.map(h => ({ orders: h.o })), n);

  const dw = DOW.map(d => ({ k: d, v: 0, o: 0 }));
  O.forEach(o => {
    const i = (dubaiDOW(o.receivedAt) + 6) % 7;
    dw[i].v += (m === 'orders' ? 1 : m === 'receipt' ? o.receiptTotal : m === 'disc' ? o.discount : o.netSales);
    dw[i].o++;
  });
  combo('c-dow', dw, { name: mname, pctName: '%GT Total Orders', filterKey: 'day', fmt: mf });
  patchPct('c-dow', dw.map(d => ({ orders: d.o })), n);

  const dc = salesAgg(O, o => o.channel).filter(r => r.disc > 0).sort((a, b) => b.disc - a.disc).map(r => ({ k: r.k, v: r.disc }));
  donut('c-disc', dc, { legend: 'left', filterKey: 'channel' });
  $('#discTotal').textContent = money(disc);
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
    ['Total Orders', cnt(n), false, () => { S.ui.cmetric = 'orders'; buildToggles(); renderCancel(); }, !val, 'Click to view Cancelled Orders Count volume across all charts'],
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
  };

  const kp = STAGES.map(([k, l]) => [
    l,
    avgOf(O, k).toFixed(2),
    false,
    () => focusStage(k),
    false,
    `Click to scroll and spotlight ${l} Best & Worst charts`
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
}

function renderRatings() {
  const allRatings = base('ratings').filter(o => !o.cancelled).map(o => ({ ...o, rating: orderRating(o) })).filter(o => o.rating != null);
  let R = allRatings;
  if (S.selBrands.size) R = R.filter(o => S.selBrands.has(o.brand));
  if (S.selLocs.size) R = R.filter(o => S.selLocs.has(o.location));
  const n = R.length, neg = R.filter(o => o.rating <= 3).length, pos = n - neg;
  const rf = S.f.ratingFilter || 'all';

  kpis('kpi-ratings', [
    ['Total Ratings', cnt(n), false, () => { S.f.ratingFilter = 'all'; renderRatings(); }, rf === 'all', 'Click to show all ratings across all outlets'],
    ['Negative Ratings', cnt(neg), false, () => { S.f.ratingFilter = (rf === 'neg' ? 'all' : 'neg'); renderRatings(); }, rf === 'neg', 'Click to filter and drill down into Negative Ratings (≤3★) across brands and locations'],
    ['Positive Ratings', cnt(pos), false, () => { S.f.ratingFilter = (rf === 'pos' ? 'all' : 'pos'); renderRatings(); }, rf === 'pos', 'Click to filter and inspect Positive Ratings (4-5★) across brands and locations'],
    ['Negative Ratings %', n ? pc(neg / n, 2) : '0%', false, () => { S.f.ratingFilter = (rf === 'neg' ? 'all' : 'neg'); renderRatings(); }, rf === 'neg', 'Click to isolate negative feedback rate drivers'],
    ['Polarity rate', n ? pc(pos / n, 2) : '0%', false, () => { S.f.ratingFilter = (rf === 'pos' ? 'all' : 'pos'); renderRatings(); }, rf === 'pos', 'Click to isolate customer satisfaction polarity']
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
  donut('c-rdist', dist, { fmt: v => v, colors: [Y, LIGHT, '#ececec', '#ee2a5c', '#1d1d1d'] });

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
function renderItems() {
  const f = S.f;
  const I = S.items.filter(x => dateOk(x.at) && eq(x.brand, f.brand) && eq(x.location, f.location));
  const n = I.length;
  const topB = groupBy(I, x => x.brand).sort((a, b) => b.rows.length - a.rows.length)[0];
  const topL = groupBy(I, x => x.location).sort((a, b) => b.rows.length - a.rows.length)[0];

  const isBrandActive = !!(topB && f.brand === topB.k);
  const isLocActive = !!(topL && f.location === topL.k);
  const isAllActive = f.brand === 'All' && f.location === 'All';

  kpis('kpi-items', [
    ['86 Items', cnt(n), false, () => {
      S.f.brand = 'All';
      S.f.location = 'All';
      syncFilterUI();
      renderItems();
    }, isAllActive, 'Click to reset brand and location filters to show all 86 stock-outs'],
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

  hbar('c-idist', cr(x => x.item, 10), { fmt: cnt });
  donut('c-isrc', groupBy(I, x => x.source).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => b.v - a.v), { fmt: cnt, colors: [Y, '#1e88e5', '#555', '#ee2a5c'] });
  donut('c-ityp', groupBy(I, x => x.type).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => b.v - a.v), { fmt: cnt, colors: [Y, '#555'] });

  const tr = groupBy(I, x => dkey(x.at)).map(g => ({ k: g.k, v: g.rows.length })).sort((a, b) => (a.k < b.k ? -1 : 1));
  lineChart('c-itrend', tr.map(r => r.k.slice(5)), [{ name: '86 Items', color: Y, data: tr.map(r => r.v) }], { fmt: cnt, dl: tr.length <= 20 });

  // fix %GT fields
  [['c-ibrand', bRows], ['c-iloc', lRows]].forEach(([id, rows]) => {
    const c = charts[id]; if (c && c.data.datasets[1]) { c.data.datasets[1].data = rows.map(r => r.v / tot * 100); c.update('none'); }
  });
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
  if (!pv.length) mk('c-dprep', { __empty: true });
  else mk('c-dprep', {
    type: 'bar',
    data: {
      labels: pv.map(r => r.k),
      datasets: [
        { label: 'Brand Preparation Time', data: pv.map(r => +r.a.toFixed(1)), backgroundColor: GREY, datalabels: lbl(v => v.toFixed(1)) },
        { label: 'Brand Estimated Time', data: pv.map(r => +r.e.toFixed(1)), backgroundColor: Y, datalabels: lbl(v => v.toFixed(1)) }
      ]
    },
    options: baseOpts({
      plugins: { legend: { display: true, position: 'top', align: 'start', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } },
      scales: { x: { ...gridless, ticks: { autoSkip: false, font: { size: 10 }, callback(v) { return trunc(this.getLabelForValue(v), 11); } } }, y: { display: false, beginAtZero: true } }
    })
  });

  // ranked delay table
  const rk = groupBy(O.filter(x => x.delay != null), x => `${gk(x.o, S.ui.dgroup)}|${x.o.location}`).map(g => ({
    name: S.ui.dgroup === 'brand' ? `${g.rows[0].o.brand}, ${g.rows[0].o.location}` : g.rows[0].o.cuisine + ', ' + g.rows[0].o.location,
    d: Math.max(0, avg(g.rows.map(x => x.delay))),
    count: g.rows.length
  })).sort((a, b) => b.d - a.d);
  const mx = rk.length ? rk[0].d || 1 : 1;
  const thPrefix = isOnlyDelayed ? '🚨 Delayed Outlets (>10m)' : (S.ui.dgroup === 'brand' ? 'Brand' : 'Cuisine');
  $('#delayTable').innerHTML = `<thead><tr><th style="text-align:left">${thPrefix}</th><th>Orders</th><th>Avg Delay (min)</th></tr></thead><tbody>${rk.map((r, i) => {
    const t = Math.min(1, r.d / mx);
    return `<tr style="background:${i % 2 ? '#111' : '#fff'};color:${i % 2 ? '#fff' : '#111'}"><td>${esc(r.name)}</td><td>${r.count}</td><td style="background:hsl(4,85%,${Math.max(40, 94 - t * 40)}%);color:#111;font-weight:700">${r.d.toFixed(2)}</td></tr>`;
  }).join('')}</tbody>`;
}

// ---------------- render & navigation ----------------
const RENDER = { sales: renderSales, cancel: renderCancel, prep: renderPrep, ratings: renderRatings, items: renderItems, delayed: renderDelayed };
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
function setData(orders, items, source, label) {
  if (orders) S.orders = orders;
  if (items) S.items = items;
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
    const [ordRes, availRes] = await Promise.all([
      fetch('/api/orders' + q),
      fetch('/api/availability' + q)
    ]);
    const j = await ordRes.json();
    if (!ordRes.ok) throw new Error(j.error || 'Failed to fetch orders');
    let items = [];
    try { items = (await availRes.json()).items || []; } catch (_) {}
    S.loadedRange = [from || dkey(Date.now() - 45 * 864e5), to || dkey(Date.now())];
    if (!j.orders.length) { log('GrubCENTER returned 0 orders for that range.'); }
    else log(`Loaded ${j.orders.length} orders.`);
    const keepFrom = from, keepTo = to;
    setData(j.orders, items.length ? items : S.items, 'live', `● Live · GrubCENTER (${j.orders.length})`);
    if (keepFrom) setDates(keepFrom, keepTo); else setDates(...fullRange());
    render();
    return true;
  } catch (e) {
    log('✗ ' + e.message);
    $('#srcBadge').textContent = 'Live unavailable'; $('#srcBadge').className = 'src-badge err';
    return false;
  }
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
  if (orders || items) { setData(orders, items, 'import', `Imported file data (${(orders || S.orders).length})`); setDates(...fullRange()); render(); }
  e.target.value = '';
};
$('#mDemo').onclick = () => { loadDemo(); log('Demo data loaded.'); };
$('#mLive').onclick = async () => { const ok = await loadLive(); if (ok) $('#modal').hidden = true; };
if ($('#mCached')) $('#mCached').onclick = async () => { await loadCached(); };
$('#btnData').onclick = () => { $('#modal').hidden = false; $('#mStatus').textContent = $('#srcBadge').textContent; };
$('#mClose').onclick = () => { $('#modal').hidden = true; };

async function loadCached() {
  log('Loading FoodHive decrypted exports…');
  try {
    const r = await fetch('/api/cached-exports');
    const j = await r.json();
    if (!j.orders || !j.orders.length) throw new Error('No export orders found.');
    log(`Loaded ${j.orders.length} orders & ${(j.items || []).length} 86-items.`);
    setData(j.orders, j.items || [], 'exports', `● FoodHive Exports (${j.orders.length})`);
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
  setData(orders, items, 'demo', '◌ Demo data (not live)');
  setDates(...fullRange()); render();
}

// ---------------- instant parallel boot ----------------
(async function boot() {
  const initialPage = RENDER[location.hash.slice(1)] ? location.hash.slice(1) : 'sales';

  // 1. Immediately fetch pre-warmed FoodHive master orders in parallel (<15ms)
  try {
    const [ordRes, availRes] = await Promise.all([
      fetch('/api/orders'),
      fetch('/api/availability')
    ]);
    if (ordRes.ok) {
      const ordData = await ordRes.json();
      let items = [];
      try { items = (await availRes.json()).items || []; } catch (_) {}
      if (ordData && ordData.orders && ordData.orders.length) {
        setData(ordData.orders, items, 'live', `● Live · GrubCENTER (${ordData.orders.length})`);
        setDates(...fullRange());
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
      const [ordRes, availRes] = await Promise.all([
        fetch('/api/orders'),
        fetch('/api/availability')
      ]);
      if (ordRes.ok) {
        const ordData = await ordRes.json();
        let items = S.items;
        try { const itJson = await availRes.json(); if (itJson.items) items = itJson.items; } catch (_) {}
        if (ordData && ordData.orders && ordData.orders.length) {
          setData(ordData.orders, items, 'live', `● Live · GrubCENTER (${ordData.orders.length})`);
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
