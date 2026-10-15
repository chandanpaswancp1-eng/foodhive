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
  - Client auto-refresh polling every 10 minutes.
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
