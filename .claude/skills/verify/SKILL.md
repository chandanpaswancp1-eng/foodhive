---
name: verify
description: Run and drive the FoodHive dashboard (local server and Vercel deployments) to verify a change at its real surface.
---

# Verifying FoodHive dashboard changes

## Local
- `PORT=3100 node server.js` (3000 may be in use). Needs `.env.local` with GrubCENTER credentials. The first sync runs at boot and takes minutes; wait for `[GrubCENTER Sync Complete]` lines.
- `index.html` is read into memory at startup. Restart the server after editing it or bumping `?v=` cache versions.
- In Chrome, navigating to the same URL with only a different `#hash` does not reload. Add a query (`/?r=2#sales`) to force fresh JS.
- Page state is `window.S` (`S.orders`, `S.items`, `S.source`). `performance.getEntriesByType('resource')` shows the poll cadence.

## Vercel
- Production: https://foodhive-ops-dashboard.vercel.app. Preview URLs: `vercel ls foodhive-ops-dashboard`. Previews are SSO-protected; call them with `vercel curl /api/... --deployment <url>`.
- **Previews and production share one Blob store.** Syncing on a preview writes production data.
- Check `vercel logs foodhive-ops-dashboard.vercel.app --since 15m` after triggering a sync. `Task timed out after 60 seconds` means the sync was killed before `writeMeta`, so `/api/status` `lastSync` does not move.
- `/api/refresh` returns immediately and syncs in the background (`waitUntil`). Watch `lastSync` on `/api/status` to see it finish.

## Flows worth driving
- `/api/live`: two calls within 10 s share the same `at`; after 10 s a new `at`.
- `/api/availability`: the newest `at`, `source` counts, and no duplicate item+brand+location+at.
- Sales page polling: `/api/live` requested every 10 s; remove an order from `S.orders` and it returns on the next poll.

## Kitchens and sources (v2)
- Sweep every page under each kitchen: `FoodHive.show(page)` then select a branch with the Branch filter on Order Details (`.msel[data-k="location"]`), or a `.kc-table th.kc-h[data-k]` header, counting `error` events. Jaddaf has no orders before go-live, so it exercises every empty-data path.
- `/api/sources` returns one status per source; `waiting` and `off` are not problems.
- The browser tab may be used by the person at the same time; log trusted clicks (`e.isTrusted`) before blaming page jumps on the code.

## Gotchas
- GrubCENTER order line items can take 20+ s for one day, so anything added to `syncOnce` risks the 60 s limit.
- Item-availability snapshot: about 24,000 rows. Paging stops only on an empty page (identical rows are real).
