/* Target split, channel promotion plans and Growth Playbook maths for the
   Targets page. Pure functions only (no DOM, no globals) so the same file
   runs in the browser like normalize.js / commission.js and can be unit-tested
   in Node via module.exports.

   Every impact is an ESTIMATE. Each rule returns an `assumption` string so
   the UI can show the working. Thresholds live in CONFIG. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FHGrowth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = {
    ragOnTrack: 0.98,         // achieved / pro-rated target at or above this = On track
    ragAtRisk: 0.90,          // at or above this = At risk, below = Off track
    minOrders: 20,            // minimum sample before any rule fires
    statsDays: 30,            // window for channel profiles (weekday, hour, AOV, discount)
    weekdayDip: 0.85,         // weekday average below 85% of channel average = weak day
    weekdayLift: 0.90,        // deal aims to lift a weak day to 90% of the channel average
    channelCapture: 0.30,     // share of a channel's shortfall a visibility or steer promo wins back
    discountExcessPts: 5,     // channel discount % of receipt this many points above company = leakage
    discountRecovery: 0.5,    // share of excess discount assumed recoverable by tightening offers
    aovUplift: 1.2,           // spend-above offer threshold = AOV x 1.2
    aovAdoption: 0.15,        // share of forecast orders that take the spend-above offer
    daypartWindow: [8, 23],   // hours considered for quiet-hour combos (late-night hours are closed, not quiet)
    daypartLowShare: 0.25,    // an hour below 25% of the channel's median active hour = quiet
    daypartAdoption: 0.15,    // share of quiet-hour gap won back by a daypart combo
    cancelRecovery: 0.25,     // share of cancelled receipt value assumed recoverable by ops fixes
    cancelFlagMultiple: 1.5,  // channel cancel rate this many times company rate = fix first
    cancelFlagMin: 0.05,      // and at least this absolute rate
    pushCommission: 0.21,     // commission at or below this = Push volume stance
    marginGuardCommission: 0.26, // commission at or above this = Protect margin stance
    promoBudgetShare: 0.35,   // share of incremental margin a promotion may spend (assumption)
    tiltMin: 0.75,            // split clamp: channel target stays within 75%-125% of its plain-share amount
    tiltMax: 1.25,
    bundleMinPairs: 10,       // company menu: co-occurrences needed before suggesting a combo
    bundleAdoption: 0.10,
    comboDiscount: 0.10,
    ratingRisk: 4.0,          // brand average below this = fix before promoting
    hotItemDays: 3            // 86 events on this many distinct days for a top seller = supply issue
  };

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayOfKey = k => new Date(k + 'T00:00:00Z').getUTCDay();
  const addDaysKey = (k, n) => { const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysInMonth = mk => { const [y, m] = mk.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const sumBy = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const round = (n, d = 0) => { const p = Math.pow(10, d); return Math.round(n * p) / p; };
  const pad2 = n => String(n).padStart(2, '0');

  // ---------- target vs achievement ----------
  // Achieved is compared with the target pro-rated to today, so a month that
  // is 10/31 done with 10/31 of the target achieved reads as on pace.
  function achievement({ achieved, target, elapsedDays, totalDays }) {
    const expectedToDate = target * (elapsedDays / totalDays);
    const remainingDays = Math.max(0, totalDays - elapsedDays);
    const gap = target - achieved;
    const pct = target > 0 ? achieved / target : null;
    const paceRatio = expectedToDate > 0 ? achieved / expectedToDate : null;
    const currentDaily = elapsedDays > 0 ? achieved / elapsedDays : 0;
    const requiredDaily = remainingDays > 0 ? Math.max(0, gap) / remainingDays : 0;
    const projected = currentDaily * totalDays;
    let rag = 'none';
    if (target > 0 && paceRatio != null) {
      rag = paceRatio >= CONFIG.ragOnTrack ? 'on' : paceRatio >= CONFIG.ragAtRisk ? 'risk' : 'off';
    }
    return { target, achieved, pct, gap, expectedToDate, paceRatio, currentDaily, requiredDaily, projected, remainingDays, rag };
  }

  // Projected RAG for a month that has not started (no pace to measure).
  function projectedRag(projected, target) {
    if (!(target > 0)) return 'none';
    const r = projected / target;
    return r >= CONFIG.ragOnTrack ? 'on' : r >= CONFIG.ragAtRisk ? 'risk' : 'off';
  }

  // ---------- channel target split ----------
  // Base weight = channel share of recent sales. Adjusted weight also scales
  // by (1 - commission), so a 0%-commission channel earns a little more of the
  // target than an equal-sales 28%-commission channel. Each channel is clamped
  // to [tiltMin, tiltMax] x its plain-share amount, so the tilt stays modest.
  // Orders are split by order share with no margin tilt.
  function splitTarget({ total = 0, orderTotal = 0, sales30 = {}, orders30 = {}, commissionRates = {} }) {
    const chans = Object.keys(sales30).filter(c => sales30[c] > 0);
    const plainSum = sumBy(chans, c => sales30[c]);
    if (!chans.length || plainSum <= 0) return {};
    const plain = {}, adj = {};
    chans.forEach(c => { plain[c] = sales30[c] / plainSum; adj[c] = plain[c] * (1 - (commissionRates[c] || 0)); });
    const adjSum = sumBy(chans, c => adj[c]) || 1;
    const lo = c => total * plain[c] * CONFIG.tiltMin;
    const hi = c => total * plain[c] * CONFIG.tiltMax;
    const out = {};
    chans.forEach(c => { out[c] = total * adj[c] / adjSum; });
    // Clamp, then push any residual onto channels still inside their band.
    for (let pass = 0; pass < 5; pass++) {
      chans.forEach(c => { out[c] = Math.min(hi(c), Math.max(lo(c), out[c])); });
      const residual = total - sumBy(chans, c => out[c]);
      const free = chans.filter(c => out[c] > lo(c) + 1e-9 && out[c] < hi(c) - 1e-9);
      if (Math.abs(residual) < 0.5 || !free.length) break;
      const fs = sumBy(free, c => out[c]);
      free.forEach(c => { out[c] += residual * out[c] / fs; });
    }
    const ordSum = sumBy(chans, c => orders30[c] || 0) || 1;
    const result = {};
    chans.forEach(c => {
      result[c] = {
        sales: round(out[c]),
        orders: round(orderTotal * (orders30[c] || 0) / ordSum),
        sharePct: round(plain[c] * 100, 1),
        commissionPct: round((commissionRates[c] || 0) * 100, 1)
      };
    });
    return result;
  }

  // ---------- channel profile helpers ----------
  // rows: { key (YYYY-MM-DD), netSales, receiptTotal, discount, cancelled, hour, receiptValue }
  function channelProfile(rows, days) {
    const live = rows.filter(r => !r.cancelled);
    const receipt = sumBy(live, r => r.receiptTotal);
    const discount = sumBy(live, r => r.discount);
    const net = sumBy(live, r => r.netSales);
    const cancelled = rows.filter(r => r.cancelled);
    const hourCounts = new Array(24).fill(0);
    live.forEach(r => { if (r.hour != null && r.hour >= 0 && r.hour < 24) hourCounts[r.hour]++; });
    const dayNet = new Map();
    live.forEach(r => dayNet.set(r.key, (dayNet.get(r.key) || 0) + r.netSales));
    const dow = Array.from({ length: 7 }, () => ({ net: 0, days: 0 }));
    dayNet.forEach((v, k) => { const d = dow[dayOfKey(k)]; d.net += v; d.days++; });
    return {
      orders: live.length, net, receipt, discount,
      aov: live.length ? net / live.length : 0,
      discPct: receipt > 0 ? discount / receipt * 100 : 0,
      cancelRate: rows.length ? cancelled.length / rows.length : 0,
      cancelledValue: sumBy(cancelled, r => r.receiptTotal),
      hourCounts, days,
      dowAvg: dow.map(d => (d.days ? d.net / d.days : 0)),
      dowDays: dow.map(d => d.days)
    };
  }

  // Weekdays whose average is well below the channel's own average, with the
  // uplift from lifting them to the target level for each remaining occurrence.
  function weakWeekdays(prof, remainingDows) {
    const seen = [0, 1, 2, 3, 4, 5, 6].filter(i => prof.dowDays[i] > 0);
    if (seen.length < 5) return [];
    const overall = sumBy(seen, i => prof.dowAvg[i]) / seen.length;
    return seen
      .filter(i => prof.dowDays[i] >= 2 && prof.dowAvg[i] < overall * CONFIG.weekdayDip)
      .map(i => {
        const occurrences = remainingDows.filter(d => d === i).length;
        const uplift = Math.max(0, overall * CONFIG.weekdayLift - prof.dowAvg[i]) * occurrences;
        return { name: DOW[i], avg: prof.dowAvg[i], uplift };
      })
      .filter(w => w.uplift > 0)
      .sort((a, b) => b.uplift - a.uplift)
      .slice(0, 2);
  }

  // Hours inside the channel's operating range that run well below its median active hour.
  function quietHours(prof) {
    const active = [];
    prof.hourCounts.forEach((c, h) => { if (c > 0) active.push(h); });
    if (active.length < 4 || prof.days <= 0) return null;
    const minH = active[0], maxH = active[active.length - 1];
    const daily = prof.hourCounts.map(c => c / prof.days);
    const levels = daily.slice(minH, maxH + 1).filter(v => v > 0).sort((a, b) => a - b);
    const median = levels[Math.floor(levels.length / 2)] || 0;
    if (median <= 0) return null;
    const low = [];
    const [wFrom, wTo] = CONFIG.daypartWindow;
    for (let h = Math.max(minH, wFrom); h <= Math.min(maxH, wTo); h++) {
      // Zero-order hours are closed, not quiet: only thin but trading hours qualify.
      if (daily[h] > 0 && daily[h] < median * CONFIG.daypartLowShare) low.push({ h, gap: median - daily[h] });
    }
    if (!low.length) return null;
    return { hours: low.map(x => x.h), gapDaily: sumBy(low, x => x.gap) };
  }

  const hourLabel = hs => hs.map(h => pad2(h) + ':00').join(', ');

  // ---------- per-channel promotion plans ----------
  // ctx: {
  //   history:  rows for the stats window (all channels, cancelled included), see channelProfile
  //   monthRows: { channel, cancelled, netSales } for the target month, all channels
  //   targets:  { [channel]: { sales, orders } }
  //   commissionRates: { [channel]: rate }   (0.26 = 26%)
  //   elapsedDays, totalDays, remainingDays, monthKey, asOfDay (0 if no data)
  // }
  function channelPlans(ctx) {
    const hist = ctx.history || [];
    const baseline = channelProfile(hist, CONFIG.statsDays);
    const companyDisc = baseline.discPct;
    const companyCancel = baseline.cancelRate;

    // Dates still to come in the month, as weekday indexes.
    const remainingDows = [];
    for (let d = ctx.asOfDay + 1; d <= ctx.totalDays; d++) remainingDows.push(dayOfKey(ctx.monthKey + '-' + pad2(d)));

    const histChannels = [...new Set(hist.map(r => r.channel))];
    const channelSet = [...new Set([...Object.keys(ctx.targets || {}), ...histChannels])];

    const plans = channelSet.map(ch => {
      const rows = hist.filter(r => r.channel === ch);
      const prof = channelProfile(rows, CONFIG.statsDays);
      const t = (ctx.targets || {})[ch] || { sales: 0, orders: 0 };
      if (prof.orders < CONFIG.minOrders && !(t.sales > 0)) return null;

      // Planning mode (ctx.forecast given): the month has not started, so the
      // figure is a projection from the run-rate rather than sales to date.
      const planning = !!ctx.forecast;
      const monthLive = (ctx.monthRows || []).filter(r => r.channel === ch && !r.cancelled);
      const achieved = planning ? (ctx.forecast[ch] || 0) : sumBy(monthLive, r => r.netSales);
      const ach = achievement({ achieved, target: t.sales || 0, elapsedDays: ctx.elapsedDays, totalDays: ctx.totalDays });
      const c = (ctx.commissionRates || {})[ch] || 0;
      const aov = prof.aov;
      const perDayWindow = CONFIG.statsDays;

      const cancelFlag = prof.cancelRate >= Math.max(CONFIG.cancelFlagMin, companyCancel * CONFIG.cancelFlagMultiple);
      let stance = 'Balanced';
      if (cancelFlag) stance = 'Fix first';
      else if (c >= CONFIG.marginGuardCommission) stance = 'Protect margin';
      else if (c <= CONFIG.pushCommission) stance = 'Push volume';

      const promos = [];
      const remaining = ctx.remainingDays;
      const dailyOrders = prof.orders / perDayWindow;

      // 1. Spend-above offer: AOV below target AOV, or discount well above company.
      const tAov = t.orders ? t.sales / t.orders : null;
      const excessDiscDaily = Math.max(0, prof.discount - companyDisc / 100 * prof.receipt) / perDayWindow;
      if (prof.orders >= CONFIG.minOrders && remaining > 0 &&
          ((tAov != null && aov < tAov) || prof.discPct >= companyDisc + CONFIG.discountExcessPts)) {
        const forecast = dailyOrders * remaining;
        const uplift = forecast * aov * (CONFIG.aovUplift - 1) * CONFIG.aovAdoption
          + excessDiscDaily * remaining * CONFIG.discountRecovery;
        const threshold = Math.round(aov * CONFIG.aovUplift);
        promos.push({
          title: stance === 'Protect margin' ? 'Bundle and spend-above offer, no blanket discount' : `Spend AED ${threshold} or more to get the offer`,
          mechanic: `Replace the flat ${round(prof.discPct, 1)}% discount with a threshold offer`,
          when: 'All days', effort: 'Low', uplift, counts: true,
          assumption: `${round(forecast)} forecast orders x AOV ${round(aov, 2)} x ${round((CONFIG.aovUplift - 1) * 100)}% uplift x ${CONFIG.aovAdoption * 100}% adoption, plus ${CONFIG.discountRecovery * 100}% of excess discount`
        });
      }

      // 2. Weekday deal on this channel's own weak days.
      const weak = remaining > 0 ? weakWeekdays(prof, remainingDows) : [];
      if (weak.length) {
        promos.push({
          title: `Weekday deal on ${weak.map(w => w.name).join(' and ')}`,
          mechanic: 'Targeted day offer on the channel\'s weakest weekdays',
          when: weak.map(w => w.name).join(', '), effort: 'Low',
          uplift: sumBy(weak, w => w.uplift), counts: true,
          assumption: `Lift ${weak.map(w => w.name).join('/')} to ${CONFIG.weekdayLift * 100}% of the channel's average day, for the remaining occurrences`
        });
      }

      // 3. Quiet-hour combo.
      const quiet = remaining > 0 ? quietHours(prof) : null;
      if (quiet) {
        promos.push({
          title: `Lunch or happy-hour combo at ${hourLabel(quiet.hours)}`,
          mechanic: 'Combo or bundle offer scheduled only in the quiet hours',
          when: hourLabel(quiet.hours), effort: 'Low',
          uplift: quiet.gapDaily * remaining * aov * CONFIG.daypartAdoption, counts: true,
          assumption: `Close the gap to the channel's median hour on ${quiet.hours.length} quiet hours, ${CONFIG.daypartAdoption * 100}% adoption at AOV ${round(aov, 2)}`
        });
      }

      // 4. Visibility push for a behind-pace channel with a low commission.
      if (ach.gap > 0 && c > 0 && c <= 0.25 && stance !== 'Fix first') {
        const peak = prof.dowAvg.indexOf(Math.max(...prof.dowAvg));
        promos.push({
          title: 'Sponsored placement on the channel\'s peak days',
          mechanic: 'Boost visibility only where orders already come in',
          when: peak >= 0 ? DOW[peak] + ' and busiest days' : 'Peak days', effort: 'Medium',
          uplift: ach.gap * CONFIG.channelCapture, counts: true,
          assumption: `${CONFIG.channelCapture * 100}% of the AED ${round(ach.gap)} gap recovered`
        });
      }

      // 5. Self-pickup steer for 0%-commission channels.
      if (ach.gap > 0 && c === 0) {
        promos.push({
          title: 'Self-pickup incentive and reorder offer',
          mechanic: 'Reward pickup and repeat orders; no platform commission applies',
          when: 'All days', effort: 'Medium',
          uplift: ach.gap * CONFIG.channelCapture, counts: true,
          assumption: `${CONFIG.channelCapture * 100}% of the AED ${round(ach.gap)} gap recovered`
        });
      }

      // 6. Cancellations first: shown, but not counted towards the target.
      if (cancelFlag) {
        promos.push({
          title: 'Fix cancellations before promoting this channel',
          mechanic: 'Reduce preparation and acceptance misses on this channel',
          when: 'Before any promotion', effort: 'Medium',
          uplift: prof.cancelledValue / perDayWindow * remaining * CONFIG.cancelRecovery, counts: false,
          assumption: `Cancel rate ${round(prof.cancelRate * 100, 1)}% vs company ${round(companyCancel * 100, 1)}%; ${CONFIG.cancelRecovery * 100}% of cancelled value recoverable. Not counted in coverage`
        });
      }

      const shown = promos.sort((a, b) => b.uplift - a.uplift).slice(0, 4)
        .map(p => ({ ...p, uplift: round(p.uplift), budget: p.counts && p.uplift > 0 ? round(p.uplift * (1 - c) * CONFIG.promoBudgetShare) : 0 }));
      const uplift = sumBy(shown.filter(p => p.counts), p => p.uplift);
      const budget = sumBy(shown, p => p.budget);
      const gap = Math.max(0, ach.gap);

      return {
        channel: ch, stance, cancelFlag,
        target: t.sales || 0, targetOrders: t.orders || 0,
        achieved: round(achieved), planning, pct: ach.pct, rag: t.sales ? (planning ? projectedRag(achieved, t.sales) : ach.rag) : 'none',
        gap: round(gap), requiredDaily: round(ach.requiredDaily),
        commissionPct: round(c * 100, 1), discPct: round(prof.discPct, 1), aov: round(aov, 2),
        cancelRate: round(prof.cancelRate * 100, 1),
        guard: c >= CONFIG.marginGuardCommission ? `Commission ${round(c * 100)}%: cap the blanket discount at the company average (${round(companyDisc, 1)}%)` : '',
        promos: shown,
        uplift: round(uplift), budget: round(budget),
        coverage: gap > 0 ? round(Math.min(uplift, gap) / gap * 100) : null,
        stretch: round(Math.max(0, gap - uplift))
      };
    }).filter(Boolean);

    plans.sort((a, b) => b.gap - a.gap);
    return { plans, baseline: { discPct: round(companyDisc, 1), cancelRate: round(companyCancel * 100, 1) } };
  }

  // ---------- promotion calendar ----------
  // Rest-of-month calendar, Monday-start weeks. Low-effort promotions start in
  // week 1; medium-effort ones start in week 2 when there are at least two
  // weeks left. Budget is spread evenly over the weeks each promotion runs.
  function promoCalendar(plans, { monthKey, totalDays, asOfDay }) {
    const first = asOfDay + 1;
    if (first > totalDays) return { weeks: [], rows: [], weekBudget: [], total: 0 };
    const monthName = new Date(monthKey + '-01T00:00:00Z').toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    const keyOf = d => monthKey + '-' + pad2(d);
    const mondayOf = k => addDaysKey(k, -((dayOfKey(k) + 6) % 7));
    const weeks = [];
    for (let d = first; d <= totalDays; d++) {
      const m = mondayOf(keyOf(d));
      let w = weeks[weeks.length - 1];
      if (!w || w.monday !== m) { w = { monday: m, first: d, last: d }; weeks.push(w); }
      w.last = d;
    }
    const labels = weeks.map((w, i) => `Wk ${i + 1}: ${w.first}–${w.last} ${monthName}`);
    const rows = plans.map(p => {
      const cells = weeks.map(() => []);
      let budget = 0;
      p.promos.filter(x => x.counts && x.budget > 0).forEach(x => {
        const start = x.effort === 'Low' || weeks.length < 2 ? 0 : 1;
        const active = weeks.length - start;
        budget += x.budget;
        weeks.forEach((_, i) => {
          if (i >= start) cells[i].push({ title: i === start ? x.title : '↳ ' + x.title, budget: x.budget / active });
        });
      });
      return { channel: p.channel, stance: p.stance, cells, budget: round(budget) };
    });
    const weekBudget = weeks.map((_, i) => round(sumBy(rows, r => sumBy(r.cells[i], c => c.budget))));
    return { weeks: labels, rows, weekBudget, total: round(sumBy(rows, r => r.budget)) };
  }

  // ---------- company-wide actions ----------
  // Only cross-channel signals remain here: cancellations, rating risk, menu.
  function cancelRecs(ctx) {
    const cancelled = ctx.orders.filter(o => o.cancelled);
    const value = sumBy(cancelled, o => o.receiptTotal);
    if (cancelled.length < CONFIG.minOrders || value <= 0) return [];
    const byReason = {};
    cancelled.forEach(o => { const r = o.reason || 'Not given'; byReason[r] = (byReason[r] || 0) + 1; });
    const top = Object.entries(byReason).sort((a, b) => b[1] - a[1])[0];
    return [{
      id: 'cancel', group: 'Operations', type: 'Cancellation leakage',
      title: 'Cut cancellations, starting with the top reason',
      evidence: `${cancelled.length} cancelled orders worth AED ${round(value)}; top reason: ${top[0]} (${top[1]})`,
      impact: round(value * CONFIG.cancelRecovery), assumption: `${CONFIG.cancelRecovery * 100}% of cancelled receipt value recoverable`,
      effort: 'Medium', priority: 'High'
    }];
  }

  function ratingRecs(ctx) {
    const byBrand = {};
    ctx.orders.forEach(o => {
      if (o.cancelled || o.rating == null || o.rating <= 0) return;
      const b = byBrand[o.brand] || (byBrand[o.brand] = { s: 0, n: 0 });
      b.s += o.rating; b.n++;
    });
    return Object.entries(byBrand)
      .filter(([, b]) => b.n >= CONFIG.minOrders && b.s / b.n < CONFIG.ratingRisk)
      .map(([brand, b]) => ({
        id: 'rating-' + brand, group: 'Operations', type: 'Fix before promoting',
        title: `Fix ${brand} service quality before promoting it`,
        evidence: `${brand} averages ${round(b.s / b.n, 2)} stars over ${b.n} rated orders`,
        impact: 0, assumption: 'Promotion would amplify complaints; no uplift counted',
        effort: 'Medium', priority: 'High'
      }));
  }

  function menuRecs(ctx) {
    const recs = [];
    const lines = ctx.lineItems;
    if (!lines.length) return recs;
    const orderSet = new Map();
    lines.forEach(x => {
      if (!orderSet.has(x.orderId)) orderSet.set(x.orderId, new Set());
      orderSet.get(x.orderId).add(x.item);
    });
    const byItem = {};
    lines.forEach(x => {
      const it = byItem[x.item] || (byItem[x.item] = { rev: 0, qty: 0, orders: new Set(), disc: 0, gross: 0 });
      it.rev += x.lineTotal; it.qty += x.qty || 0; it.orders.add(x.orderId);
      it.disc += x.discount || 0; it.gross += (x.lineTotal || 0) + (x.discount || 0);
    });
    const totalRev = sumBy(Object.values(byItem), i => i.rev);
    const items = Object.entries(byItem).map(([name, i]) => ({ name, ...i, orderCount: i.orders.size }));
    if (totalRev <= 0) return recs;

    const top = items.slice().sort((a, b) => b.rev - a.rev)[0];
    if (top && top.orderCount >= CONFIG.minOrders) {
      recs.push({
        id: 'hero-' + top.name, group: 'Menu', type: 'Hero item',
        title: `Feature "${top.name}" in banners and bundle anchors`,
        evidence: `${round(top.rev / totalRev * 100, 1)}% of menu revenue from ${top.orderCount} orders`,
        impact: round(top.rev * 0.05), assumption: '5% lift in the hero item from in-app placement',
        effort: 'Low', priority: 'Medium'
      });
    }

    const pairs = new Map();
    orderSet.forEach(set => {
      const arr = [...set].sort();
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] + ' + ' + arr[j];
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    });
    const topPair = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPair && topPair[1] >= CONFIG.bundleMinPairs) {
      const [pairName, n] = topPair;
      const avgLine = sumBy(items, i => i.rev) / Math.max(1, sumBy(items, i => i.qty));
      recs.push({
        id: 'bundle-' + pairName, group: 'Menu', type: 'Bundle',
        title: `Sell "${pairName}" as a combo`,
        evidence: `Ordered together in ${n} orders`,
        impact: round(n * CONFIG.bundleAdoption * avgLine * 2 * (1 - CONFIG.comboDiscount)),
        assumption: `${CONFIG.bundleAdoption * 100}% of the ${n} paired orders convert to a combo at ${CONFIG.comboDiscount * 100}% off`,
        effort: 'Low', priority: 'Medium'
      });
    }

    const med = items.map(i => i.rev).sort((a, b) => a - b)[Math.floor(items.length / 2)] || 0;
    items.filter(i => i.orderCount >= CONFIG.minOrders && i.rev < med * 0.5)
      .sort((a, b) => a.rev - b.rev).slice(0, 3)
      .forEach(i => recs.push({
        id: 'tail-' + i.name, group: 'Menu', type: 'Long tail',
        title: `Review "${i.name}": remove, rework or re-price`,
        evidence: `AED ${round(i.rev)} from ${i.orderCount} orders, under half the menu median`,
        impact: 0, assumption: 'Menu simplification; no uplift counted',
        effort: 'Medium', priority: 'Low'
      }));

    items.filter(i => i.gross > 0 && i.disc / i.gross > 0.2 && i.orderCount >= CONFIG.minOrders)
      .sort((a, b) => b.disc - a.disc).slice(0, 2)
      .forEach(i => recs.push({
        id: 'price-' + i.name, group: 'Menu', type: 'Price discipline',
        title: `Reduce item-level discounts on "${i.name}"`,
        evidence: `${round(i.disc / i.gross * 100, 1)}% of list value given away (AED ${round(i.disc)})`,
        impact: round(i.disc * 0.3), assumption: 'Recover 30% of item discount through price or offer design',
        effort: 'Low', priority: 'Medium'
      }));

    const outDays = new Map();
    (ctx.events || []).forEach(e => {
      if (!outDays.has(e.item)) outDays.set(e.item, new Set());
      outDays.get(e.item).add(e.dayKey);
    });
    items.filter(i => outDays.has(i.name) && outDays.get(i.name).size >= CONFIG.hotItemDays && i.orderCount >= CONFIG.minOrders)
      .sort((a, b) => b.rev - a.rev).slice(0, 2)
      .forEach(i => {
        const days = outDays.get(i.name).size;
        const dailyRev = i.rev / Math.max(1, ctx.elapsedDays);
        recs.push({
          id: '86-' + i.name, group: 'Menu', type: 'Supply fix',
          title: `Fix supply for "${i.name}" before promoting it`,
          evidence: `Marked out of stock on ${days} days, and it is a top seller`,
          impact: round(dailyRev * days * 0.5), assumption: `Half of the average daily sales of AED ${round(dailyRev)} lost on ${days} out-of-stock days`,
          effort: 'Medium', priority: 'High'
        });
      });

    return recs;
  }

  const PRIORITY_SCORE = { High: 3, Medium: 2, Low: 1 };

  // Company-wide actions only. Channel-level promotions come from channelPlans().
  function playbook(ctx) {
    if (!ctx.orders.length) return { recs: [], gap: 0, estimated: 0, covered: 0 };
    const recs = [...cancelRecs(ctx), ...ratingRecs(ctx), ...menuRecs(ctx)]
      .sort((a, b) => (PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority]) || (b.impact - a.impact));
    const gap = Math.max(0, ctx.target - ctx.achieved);
    const estimated = sumBy(recs, r => r.impact);
    return { recs, gap: round(gap), estimated: round(estimated), covered: round(Math.min(estimated, gap)) };
  }

  return { CONFIG, achievement, projectedRag, splitTarget, channelProfile, channelPlans, promoCalendar, playbook, DOW, daysInMonth, addDaysKey, dayOfKey };
});
