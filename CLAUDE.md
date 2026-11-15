# FoodHive Operations & Sales Dashboard

FoodHive Operations & Sales Analytics Dashboard — an exact visual and functional replica of the Power BI operations dashboard, connected live to GrubCENTER API and decrypted Excel caches.

## Architecture
- **Backend**: Zero-dependency vanilla Node.js (`server.js`) listening on port 3000.
  - Background auto-sync against GrubCENTER every 10 minutes (`SYNC_INTERVAL_MS = 10 * 60 * 1000`).
  - Gzip compression, strict caching headers, parallelized data ingestion.
  - REST Endpoints:
    - `/api/status`: Connection state, GrubCENTER auth status, cached orders count.
    - `/api/orders`: Master orders array filtered by date range.
    - `/api/availability`: Item-level stock and out-of-stock (86) event logs.
    - `/api/refresh`: Manually triggers background sync.
- **Frontend**: Vanilla JavaScript (`public/app.js`), Chart.js 4.4.1 + ChartDataLabels plugin, CSS (`public/style.css`), HTML (`public/index.html`).
  - Pre-rendered HTML for instant (<15ms) first contentful paint.
  - Client auto-refresh polling every 2 minutes; the server's full GrubCENTER sync runs every 10 minutes.
  - Live view: every 10 seconds the client polls `/api/live`, which returns today's orders and cancellations straight from GrubCENTER. The server shares one result for 10 seconds across all viewers and never writes it to storage. Prep timings and older days still come from the full sync.
  - 86 items: on Vercel, `/api/availability` refreshes the 86 log from GrubCENTER's item-availability snapshot (about 24,000 rows) in its own function call, at most every 10 minutes (`syncItems`, `items_meta.json`). Keep it out of `syncOnce`, because order line items alone can take 20+ s and the two together pass Vercel's 60 s limit. Locally, `server.js` `runSync` fetches the snapshot inline.
  - Color palette: Primary Yellow (`#FDCB3C`), Dark Charcoal (`#1d1d1d`), Slate Line (`#d9dfe1`), Accent Blue (`#1b2a9b`).

## 6 Analytics Pages
1. **Order Details / Sales (`#sales`)**: Net Sales, Receipt Total, Total Orders, AOV, Total Discount, Discount %, Avg RunRate, Projected RR, Top Brand.
2. **Cancellations (`#cancel`)**: Cancelled Orders Amount, Total Cancelled Orders, AOV, Reasons, Channel breakdown, Post-cancelled split.
3. **Prep Time (`#prep`)**: Acc → Started, Started → Prepared, Prepared → STD, STD → Dispatched, Receiving → Dispatched, Received → Delivered, Best vs Worst Brand Location. Interactive stage sliders.
4. **Ratings (`#ratings`)**: Total Ratings, Negative Ratings, Positive Ratings, Negative Ratings %, Polarity Rate, Star distribution donut, DrillThrough.
5. **Items Detail (`#items`)**: 86 Items, Brand with Most 86 Items, Location with Most 86 Items, Distribution by Source & Type.
6. **Delayed Orders (`#delayed`)**: Orders taking > 10 min prep, Delayed orders %, Vendor Prep vs Estimated Prep times, Color-coded Delay table.

## Quick Start
```bash
# Start server
node server.js

# Dashboard runs at:
http://localhost:3000
```

## Two kitchens, two platforms (v2)
- **Motor City** runs on Grubtech (GrubCENTER sync). **Jaddaf** runs on UrbanPiper (Atlas): orders arrive by Atlas webhook, the catalogue by a one-click snapshot from a signed-in Atlas tab (Atlas has no read API; every login needs reCAPTCHA).
- Every order carries `source` (`grubcenter` | `urbanpiper`) and `location`. Each source writes its own Blob file (`orders.json`, `up_orders.json`); `/api/orders`, `/api/order-items` merge at read time (`readAllOrders` in `api/_lib/store.js`, `allOrders()` in `server.js`).
- **Kitchen switcher** (sidebar): All / Motor City / Jaddaf sets `S.f.location` for every page and is remembered in localStorage (`fh_kitchen_v1`). There is no per-page Location filter any more.
- **Navigation** is grouped into collapsible sections: Sales, Operations, Menu, Finance, Data (`fh_nav_closed_v1`).
- **Data Sources** page (`#sources`) and sidebar pill read `/api/sources`. Status rules live in `public/sources.js` (shared by server and browser): ok, stale, waiting, error, off.
- `mk()` in `public/app.js` unregisters a destroyed chart (`delete charts[id]`); without that, any empty-data redraw left a destroyed chart in `charts` and `patchPct()` crashed Chart.js.

## KPI layout (two kitchens)
- Tile order on every page is set in `KPI_ORDER` (`public/app.js`): money, then volume, unit economics, rate or quality, top performer. `kpis()` sorts by title, so a new tile goes into `KPI_ORDER` or lands at the end of the row. At most 8 tiles per row (CSS).
- Accounting tiles are grouped by `ACCOUNTING_GROUPS` (Profit & Loss, Cash, Receivables & Payables, Balance Sheet).
- `KITCHEN_CALC[page](kitchen)` computes a page's order-based figures for one kitchen through `base(page, false, kitchen)`. It drives the `MC … | JD …` split line on tiles when the switcher is on All, and the Motor City vs Jaddaf table (`kitchenCompareTable`) that replaced the single-location charts on Order Details, Cancellations, Prep Time and Items. Zoho and Targets tiles are group-level and have no split.

## Discount by Aggregator (Order Details)
- `discountByAggregator()` / `renderDiscountByAggregator()` in `public/app.js`: per channel, discount given in the selected range (orders, % of orders discounted, gross, discount, % of gross, average per discounted order) and the live month's projected close.
- Projection: each channel's discount, gross, net and commission per completed day this month (today excluded, since it is partial) carried to month-end: MTD through yesterday + pace × days left including today. On the 1st, today's figures are the pace. Follows the kitchen switcher and page filters; clicking a row filters the dashboard to that channel.

## Targets & Growth (`#targets`)
- Monthly Net Sales and Orders targets for the company and for each channel. There are no brand targets.
- Targets are entered per month in Target Setup and kept per browser (localStorage `fh_targets_v1`, keyed `YYYY-MM`). Editing the company target auto-splits it across channels by last-30-day sales share, adjusted for commission (`FHGrowth.splitTarget`). Editing a channel locks it as Manual; "Re-split automatically" clears the locks.
- The page defaults to next month. Before a month starts, figures are projections from the last 30 days (Planning mode). Once it starts, they are achieved to date against a pro-rated target.
- Status (RAG): On track at 98% or more of the pro-rated target (or projection), At risk 90% to 98%, Off track below 90%.
- Channel promotion plans (`FHGrowth.channelPlans`): per-channel stance (Push volume, Protect margin, Fix first, Balanced), promotions with budget caps and estimated uplift. Estimates only, built from stated assumptions.
- Promotion calendar (`FHGrowth.promoCalendar`): Monday-start weeks for the remaining days of the month.
- Company-wide actions (`FHGrowth.playbook`): cancellations, rating risk, and menu items. Logic is in `public/growth.js`; thresholds are in `CONFIG`.
- Channel requirements (`FHGrowth.channelRequirements`, contract facts in `CHANNEL_REQUIREMENTS`): commission, per-order floors, orders below the floor, discount vs company, AOV, p75 basket, brand coverage, peak hours. Facts that cannot be tracked per order are listed as not applied.
- Recommended campaign per channel (`FHGrowth.campaignBrief`): one headline campaign chosen by rule (Fix First, Direct Channel Upgrade, Volume Build, Discount Reset, Assortment Expansion, Funded Visibility, Peak-Hour Bundle). Briefs open in the detail modal and go into the CSV.
- Marketing budget per channel is an optional override in Target Setup. Below the auto cap it scales uplift and budget down proportionally; above the cap it is flagged and uplift is not increased. Entering a budget does not lock the sales split. Counted uplift is capped at the channel gap.
