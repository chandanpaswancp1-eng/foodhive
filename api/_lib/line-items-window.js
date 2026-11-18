// Which order line items /api/order-items sends. Line items run ~700 rows a
// day, so the full history (from 17 Aug 2026) is far too big to send on every
// page load. With no range the endpoint sends the most recent
// DEFAULT_DAYS (enough for the 30-day lookbacks on Targets & Growth); older
// days are fetched on demand with ?from=&to= (ensureLineItems in app.js).
// The response says which days it covers (servedFrom/servedTo) and the
// earliest day in the store (coveredFrom), so the client can merge rather
// than replace what it already holds.
const DEFAULT_DAYS = 35;

function lineItemsResponse(allItems, from, to, dayKey, now = Date.now()) {
  const today = dayKey(now);
  const servedTo = to || today;
  const servedFrom = from || dayKey(now - (DEFAULT_DAYS - 1) * 864e5);
  let coveredFrom = null;
  const items = [];
  for (const x of allItems) {
    if (!x || !x.at) continue;
    const d = dayKey(x.at);
    if (d.includes('NaN')) continue;
    if (!coveredFrom || d < coveredFrom) coveredFrom = d;
    if (d >= servedFrom && d <= servedTo) items.push(x);
  }
  return { count: items.length, totalInStore: allItems.length, servedFrom, servedTo, coveredFrom, items };
}

module.exports = { lineItemsResponse, DEFAULT_DAYS };
