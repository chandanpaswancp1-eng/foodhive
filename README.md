# FoodHive Dashboard (Kaykroo-style, GrubCENTER data)

Six pages replicating the Kaykroo Power BI report: **Order Details (Sales), Cancellations, Prep Time, Ratings, Items Detail (86 items), Delayed Orders** — same yellow/black layout, sidebar toggles (Net Sales|Orders, Brand|Cuisine, Daily…Yearly), slicers, best/worst charts, range filters and ranked tables.

## Run
```sh
cp .env.example .env     # add your GrubCENTER email + password
node server.js           # http://localhost:3000  (Node 18+, no npm install)
```
- **Live**: the server signs in to https://grubcenter.grubtech.io (AWS Cognito, same as the web app) and pulls `sales-data/order-details/<partnerId>` from Grubtech's reporting API, paging 200 rows at a time.
- **Import**: *Data source → Import CSV/XLSX* accepts Grubcenter `order-details` exports (and `item-availability-history` for the Items page). Column names are matched loosely (`public/normalize.js`). Password-protected workbooks must be re-saved without a password.
- **Demo**: with no credentials the dashboard shows generated demo data (badge: "Demo data (not live)").

## Status & Data Sources
- **Live Connected**: Authenticated with GrubCENTER (`eu-west-2` Cognito client ID `75n3em3l16kvhnf6c512680vm9`). Joins sales data (`/sales-data/order-details/`), operations timing data (`/operations-data/location-performance/report/`), and cancellations (`/sales-data/cancelled-orders/report/`).
- **Historical Decrypted Exports**: All 18 password-protected (`8854`) `.xlsx` exports in Downloads were decrypted and consolidated in `data/cached_orders.json` (1,864 orders) and `data/cached_items.json` (87 item-availability records). Can be loaded anytime via *Data source → Load Historical Exports*.
- **Cuisine Taxonomy**: Brand-to-cuisine mapping from `Cuisin Tag FoodHive (1).xlsx` is built-in (`Levantine`, `Italian`, `American / Fried`, `Healthy`, `Desserts`, `Wraps & Salads`, `Tabkha`).

## Pages
1. **Order Details (Sales)**: Net Sales, Receipt Total, Total Orders, AOV, Discounts, RunRate, Projected RR, Top Brand, time-grain toggle (Daily, Weekly, Monthly, Quarterly, Yearly), brand/cuisine charts, hourly/day-of-week distributions, channels.
2. **Cancellations**: Cancelled Amount, Cancelled Orders count, AOV, Locations, Channels, Post-Cancelled donut, Brand horizontal bar chart, daily trend with %GT line.
3. **Prep Time**: Acc → Started, Started → Prepared, Prepared → STD, STD → Dispatched, Receiving → Dispatched, Received → Delivered stages; Range sliders for each stage; Best vs Worst outlet KPI; Paired Best/Worst brand bar charts; Full stage comparison table; Location counts.
4. **Ratings**: Total Ratings, Negative Ratings (≤3★), Positive Ratings, Negative Ratings %, Polarity Rate; Best/Worst Locations by Rating; Best/Worst Brands (Cuisine Cluster) by Rating; Location DrillThrough; 5-Star distribution donut; Live Operational Service Quality rating mode + Aggregator mode; Brand & Location search filter lists.
5. **Items Detail (86 Items)**: 86 Items count, Brand with Most 86 Items, Location with Most 86 Items; 86 Items and %GT by Brand & Location; Total 86 Items distribution (Top items horizontal bar); Distribution by Source (Master, GrubKDS); Distribution by Type (Menu Item, Modifier); 86 Items Trend line.
6. **Delayed Orders**: Total Orders, Delayed Orders (>10m over estimate), Delayed % KPI; Completed vs Delayed by Brand & Location; Vendor Preparation Time vs Estimated Preparation Time bar chart; Ranked Delay Table with gradient highlighting.

## Run
```sh
node server.js
```
Open **`http://localhost:3000`** in your browser.

