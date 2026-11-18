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
  - Order line items ("items sold", ~700 rows a day, history from 17 Aug 2026) are too big to send whole. `/api/order-items` (Vercel and `server.js`, rule in `api/_lib/line-items-window.js`) sends the last 35 days unless given `?from=&to=`, and reports `servedFrom`/`servedTo`/`coveredFrom`. The client merges by day (`mergeLineItemsByDay`) so refreshes never drop older days, and `ensureLineItems()` (called from `render()`) fetches older days when the date filter reaches past what is loaded (`S.liFrom`, `S.liCoveredFrom`).
  - History beyond what the syncs pulled is filled by `scripts/backfill-order-items.js`, run locally because each day takes ~20 s from GrubCENTER. It writes a day only when GrubCENTER returned it cleanly (a day with orders but no lines counts as failed), reports each day's lines vs orders, and replaces only the fetched days. `--local-only` pulls into `data/order_items.backfill.json` (gitignored; the local server rewrites `data/order_items.json` on every sync, so it cannot hold a pull); `--push-local --from --to` then copies those days to Blob. Each 5-day batch refreshes the GrubCENTER session (it expires within the hour) and failed days get two retry passes.
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
- **Motor City** runs on Grubtech (GrubCENTER sync). **Jaddaf** runs on UrbanPiper (Atlas). Atlas has no read API, no webhook is registered, and every login needs reCAPTCHA, so Jaddaf data is captured by hand:
  - The "🍽 FoodHive Atlas" bookmarklet (`public/atlas-capture.js`, built like the ratings one; keep it free of `//` comments) runs in a signed-in Atlas tab. It reads the bearer token from `localStorage.AT.auth.token` and calls Atlas GraphQL (`atlas-backend.svc.urbanpiper.com/graphql`): `ordersV2` (cursor paging, `created` filter `"YYYY-MM-DD,YYYY-MM-DD"`), then `order(id: Int)` per order (discount, items, `statusUpdates`), or `items` (offset paging) for the catalogue. It copies JSON and never copies customer details.
  - Data Sources → **Update from Atlas** (`openAtlasModal` in `public/app.js`) pastes it to `POST /api/up-import` (`api/up-import.js`; `server.js` reuses its `importCapture`). Shared rules are in `public/atlas.js` (`FHAtlas`): Atlas times are Dubai local; orders upsert by `up_<atlas id>`; test orders (reason `TEST_ORDER`, remarks "test", or a test customer) are skipped and removed; prices are VAT-inclusive, so netSales = (receipt − discount) / 1.05; `ACKNOWLEDGED`/`FOOD_READY`/`DISPATCHED`/`COMPLETED` map to accepted/prepared/dispatched/delivered; channel codes map to the GrubCENTER names (`KEETA` → `Keeta 2.0`, `PHONEORDER` → `Phone Order`).
  - Catalogue captures write `up_catalog.json` and add 86 events for switched-off items (`isEnabled: false`) to `up_items.json`, which `/api/availability` merges.
- **Sync Now syncs both kitchens** (`/api/refresh` in `api/refresh.js` and `server.js`): GrubCENTER runs in the background (client polls `lastSync`), and Atlas finishes inside the request, so its result comes back in `atlas` and shows as `Motor City: … · Jaddaf: …`. The 10-minute page-load refresh (`api/orders.js`, `server.js` interval) and the nightly cron also sync Atlas.
  - The server calls Atlas with the user's Atlas session. In the bookmarklet, **Connect dashboard** opens `<dashboard>/?atlas-connect=1` and sends the token by `postMessage`; the page only accepts `https://atlas.urbanpiper.com` (`atlasConnectReceiver` in `public/app.js`). The dashboard fills in its own origin by replacing `__FH_DASHBOARD__` when it builds the bookmarklet. `POST /api/up-connect` checks that the token's `biz_id` is FoodHive's (`ATLAS_BIZ_ID`, default 37055789) and that Atlas accepts it, then stores it privately (`up_conn.json`: Blob, or `data/` locally, gitignored). It is never returned. The token is used for **24 hours after connecting** (the user reconnects daily) or until Atlas expires it (7 days), whichever comes first. Atlas rejects a bad session with HTTP 200 "Not Allowed"; that clears the connection.
  - `api/_lib/atlas-sync.js` (`syncAtlas`, single-flight `syncAtlasOnce`, storage via `io`: `api/_lib/up-blob-io.js` or `upFileIo` in `server.js`) must never save wrong or partial data. The window is the last 2 days plus everything since the last good sync (30 days on the first run, at most 45). It reads every list page (a repeated cursor is an error) and fetches every order's detail with retries; any order still unread means nothing is written. Each detail must match its id and fall inside the window. Orders Atlas no longer lists for those days are removed. The catalogue refreshes when older than 24 hours. Errors go to `up_meta.atlasError` and show on Data Sources (`upFacts`).
- Every order carries `source` (`grubcenter` | `urbanpiper`) and `location`. Each source writes its own Blob file (`orders.json`, `up_orders.json`, `up_order_items.json`, `up_meta.json`); `/api/orders`, `/api/order-items` merge at read time (`readAllOrders` in `api/_lib/store.js`, `allOrders()` in `server.js`).
- **Branch filter**: every page with a filter bar has a **Branch** multi-select (Motor City, Jaddaf; same control as Brand; `['location', 'Branch']` in `FILTERS` in `public/app.js`). Accounting (Zoho) is group-level and has none. It sets `S.f.location`, which like every `S.f` filter applies on all pages, so a choice on one page carries over; Reset All clears it. A kitchen comparison table's column header also sets it (`setKitchen()`). It is not remembered between visits.
- **Navigation** is grouped into collapsible sections: Sales, Operations, Menu, Finance, Data (`fh_nav_closed_v1`).
- **Data Sources** page (`#sources`) and sidebar pill read `/api/sources`. Status rules live in `public/sources.js` (shared by server and browser): ok, stale, waiting, error, off.
- `mk()` in `public/app.js` unregisters a destroyed chart (`delete charts[id]`); without that, any empty-data redraw left a destroyed chart in `charts` and `patchPct()` crashed Chart.js.

## KPI layout (two kitchens)
- Every page's tiles sit in labelled clusters side by side (`KPI_CLUSTERS` in `public/app.js`; e.g. Order Details: Revenue · Volume · Discounts · Outlook; Accounting: Profit & Loss · Cash · Receivables & Payables · Balance Sheet). The cluster lists also set the tile order. A new tile goes into a cluster; otherwise it gets an unlabelled cluster at the end.
- Each cluster renders as one white card (styles under `.kpis--clustered` in `public/style.css`): label top-left, large left-aligned value, kitchen split below, hairline dividers between figures, selected figure tinted with a yellow underline, negative values red (`.kv-neg`).
- Clusters never shrink below their tiles (CSS min-width auto); the band wraps instead. KPI values do not wrap; a value with a note inside (Projected Month-End) wraps its note only.
- `KITCHEN_CALC[page](kitchen)` computes a page's order-based figures for one kitchen through `base(page, false, kitchen)`. It drives the `MC … | JD …` split line on tiles when the switcher is on All, and the Motor City vs Jaddaf table (`kitchenCompareTable`) that replaced the single-location charts on Order Details, Cancellations, Prep Time and Items. Zoho and Targets tiles are group-level and have no split.

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

## Aggregator ratings (Ratings page)
- GrubCENTER sends no customer ratings; the Ratings page charts are a prep-time estimate (`orderRating()`, labelled "ops estimate"). Real store ratings per brand per aggregator (Talabat, Deliveroo, Careem, Keeta 2.0, Noon) come from the partner portals.
- **Brand Ratings by Aggregator** matrix at the top of `#ratings`: rating and count per brand × aggregator, colour bands (<4.0 red, 4.0–4.4 amber, ≥4.5 green), count-weighted "All aggregators" column, footer with each aggregator's average and capture date (stale after 7 days). Respects the Brand selectors and Branch filter, not the date filter (lifetime store ratings). KPI cluster "Aggregator ratings": Lowest Aggregator Rating, Listings Below 4.0★.
- **Update ratings** modal: drag the "⭐ FoodHive ratings" bookmarklet (built from `public/ratings-capture.js`), run it on a signed-in portal ratings page, paste the copied JSON; or paste CSV/TSV (store, rating, count); or type rows. Saving replaces that aggregator's rows. Store names are matched to brands by `FHRatings.matchStore`; manual picks are saved as aliases.
- Storage: `brand_ratings.json` (Blob on Vercel, `data/` locally), `GET/POST /api/brand-ratings` (`api/brand-ratings.js`, `server.js`). Shared logic (validation, merge, matrix) in `public/ratings.js` (`FHRatings`), used by server and browser. Data Sources shows it as "Aggregator ratings".
- `ratings-capture.js` has a generic table reader; add a per-portal extractor to `EXTRACTORS` once a portal's ratings request is known. Keep it free of `//` comments (the bookmarklet is one line).
