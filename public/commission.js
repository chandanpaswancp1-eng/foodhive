/* Portal commission & EBITDA math, derived from FoodHive's signed merchant
   agreements. Shared by the browser exactly like normalize.js.

   Rates below are read directly off the signed contracts (not estimates):
     Talabat   - Letter of Agreement (OQ-0010978599): TGO Basic Commission 24%
                 + 2% Credit Card Payment Fee.
     Deliveroo - Service Pack cover sheet (Core Services Fee on GMV), tiered
                 by date: 0% until 13 Aug 2026, 10% 14 Aug-15 Sep 2026,
                 28% from 16 Sep 2026 onward.
     Careem    - Restaurant Enrollment Agreement: Standard Commission 23%
                 + 2% Processing Fee.
     Noon      - Noon Food Merchant Agreement Annex: Noon Food Fee 19%
                 + 2% Payment Processing Fee.
     Keeta 2.0 - Merchant Agreement (Agreement No. AEWM-SE-E3-20028083):
                 Commission Rate 25% + 2% Bank Fee Rate, AED 6/order minimum.
     Take Away / Pickup / Dine in / anything else - 0% (no aggregator).

   Modeling choices (documented, not guessed):
   - Commission base is order.netSales (post-discount revenue) for every
     channel - the closest available proxy to each contract's own revenue
     base ("Net Sales of Goods" / "Item Revenue" / GMV).
   - Each contract's always-on payment/processing fee is folded into one
     blended rate per channel, since orders have no reliable card-type/COD
     split to apply it selectively.
   - Keeta's AED 6/order minimum fee is applied as a floor.
   - NOT applied (no data to support them, so omitted rather than guessed):
     loyalty-tier flat fees (Careem Plus AED3/order, Noon one AED3/order,
     Talabat tPro AED4/order >=AED30) - no loyalty-membership field on an
     order; Careem's 4%/mo Marketing Commitment - merchant ad spend, not a
     platform commission; fixed monthly/one-time fees (Talabat AED262.50/mo
     subscription + AED525 one-time registration, Deliveroo AED50/site/mo
     platform fee effective 1 Nov 2026, Keeta AED500/device POS fee) - these
     are overhead, not order-linked, and Deliveroo's hasn't started within
     the current data window.
   - EBITDA = Net Sales - Commission - Other Operating Costs. Discount is
     NOT subtracted again here: order.netSales is already net of discount
     (see normalize.js, netSales = receiptTotal - discount), so including it
     a second time would double-count it. Discount is still shown as a
     memo line in the Gross-to-Net bridge on the EBITDA page for context.
   - "Other Operating Costs" is the sum of five manually-entered F&B cost
     categories (Cost of Goods Sold / Labor / Controllable / Occupancy /
     G&A) the user enters on the EBITDA page - not derived from order data.
     Portal Commission is NOT one of those categories; it's already computed
     above and would double-count if also entered manually. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FHCommission = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DAY = 86400000;
  // Dates below are UTC midnight boundaries for the Deliveroo rate tiers;
  // orders are matched against these using their receivedAt epoch ms.
  const D = (y, m, d) => Date.UTC(y, m - 1, d);

  const DELIVEROO_TIERS = [
    { from: -Infinity, to: D(2026, 8, 14), rate: 0.00 },
    { from: D(2026, 8, 14), to: D(2026, 9, 16), rate: 0.10 },
    { from: D(2026, 9, 16), to: Infinity, rate: 0.28 }
  ];

  const CHANNEL_RATES = {
    'Talabat': { rate: 0.24 + 0.02 },
    'Deliveroo': { tiers: DELIVEROO_TIERS },
    'Careem': { rate: 0.23 + 0.02 },
    'Noon': { rate: 0.19 + 0.02 },
    'Keeta 2.0': { rate: 0.25 + 0.02, minFee: 6 }
  };

  function rateForChannel(channel, atMs) {
    const cfg = CHANNEL_RATES[channel];
    if (!cfg) return 0;
    if (cfg.tiers) {
      const t = cfg.tiers.find(t => atMs >= t.from && atMs < t.to);
      return t ? t.rate : 0;
    }
    return cfg.rate || 0;
  }

  function minFeeForChannel(channel) {
    const cfg = CHANNEL_RATES[channel];
    return (cfg && cfg.minFee) || 0;
  }

  function commissionForOrder(order) {
    const net = order.netSales || 0;
    if (net <= 0) return 0;
    const rate = rateForChannel(order.channel, order.receivedAt);
    if (rate <= 0) return 0;
    const raw = rate * net;
    const floored = Math.max(raw, minFeeForChannel(order.channel));
    return Math.min(floored, net);
  }

  function ebitda(netSales, commission, otherCosts) {
    return netSales - commission - (otherCosts || 0);
  }

  // Static reference table for the Portal Rate Card panel - display only,
  // not used in any calculation.
  const RATE_CARD = [
    { channel: 'Talabat', structure: '24% TGO Basic Commission + 2% Credit Card Fee', note: 'Also: 2% Cash Handling, 2% Bank Charges (not applied, payment-type not tracked); AED 262.50/mo subscription + AED 525 one-time registration (not applied, fixed overhead); tPro AED 4/order ≥30 AED (not applied, loyalty flag not tracked)' },
    { channel: 'Deliveroo', structure: 'Core Services Fee on GMV: 0% → 10% (14 Aug 2026) → 28% (16 Sep 2026)', note: 'Platform Fee AED 50/site/mo from 1 Nov 2026 (not applied, outside current data window)' },
    { channel: 'Careem', structure: '23% Standard Commission + 2% Processing Fee', note: 'Careem Plus AED 3/order (not applied, loyalty flag not tracked); 4%/mo Marketing Commitment is merchant ad spend, excluded entirely' },
    { channel: 'Noon', structure: '19% Noon Food Fee + 2% Payment Processing Fee', note: 'noon one loyalty AED 3/order (not applied, loyalty flag not tracked); 2.8%/3.4% intl/Amex card variance not tracked' },
    { channel: 'Keeta 2.0', structure: '25% Commission Rate + 2% Bank Fee Rate, AED 6/order minimum', note: 'AED 500/device one-time POS fee not applied (fixed overhead)' },
    { channel: 'Take Away / Direct', structure: '0% — no aggregator', note: 'Pickup, Dine in, and any other non-aggregator channel default to 0%' }
  ];

  return { CHANNEL_RATES, rateForChannel, minFeeForChannel, commissionForOrder, ebitda, RATE_CARD };
});
