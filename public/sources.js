/* Data-source health rules, shared by the server (/api/sources on Vercel and
   in server.js) and the browser, exactly like normalize.js.

   Each source reports facts ({configured, lastSync, records, error, ...});
   describeSources() turns them into one status per source:
     ok       fresh data
     stale    data older than the source's limit
     renew    data is fresh, but the source stops soon unless the user acts
              (a `warn` fact: the Atlas session ends within a day)
     waiting  set up, but nothing has arrived yet (e.g. Jaddaf not live)
     error    the last attempt failed
     off      not configured */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FHSources = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  const SOURCES = [
    { id: 'grubcenter', name: 'GrubCENTER orders', kitchen: 'Motor City', staleAfter: 30 * MIN, what: 'Orders, ops timings, cancellations, line items' },
    { id: 'items86', name: 'GrubCENTER 86 items', kitchen: 'Motor City', staleAfter: 2 * HOUR, what: 'Item availability snapshot' },
    { id: 'upOrders', name: 'UrbanPiper orders', kitchen: 'Jaddaf', staleAfter: DAY, what: 'Orders captured from Atlas with the bookmarklet', atlas: true },
    { id: 'upCatalog', name: 'UrbanPiper catalogue', kitchen: 'Jaddaf', staleAfter: 7 * DAY, what: 'Items, prices, switched-off (86) items', atlas: true },
    { id: 'aggRatings', name: 'Aggregator ratings', kitchen: 'Group', staleAfter: 7 * DAY, what: 'Brand store ratings captured from partner portals' },
    { id: 'zoho', name: 'Zoho Books', kitchen: 'Group', staleAfter: 30 * MIN, what: 'Accounting: income, expenses, bills, invoices' }
  ];

  function describeSources(facts, now = Date.now()) {
    return SOURCES.map(def => {
      const f = facts[def.id] || {};
      const age = f.lastSync ? now - f.lastSync : null;
      let status;
      if (!f.configured) status = 'off';
      else if (f.error) status = 'error';
      else if (!f.lastSync) status = 'waiting';
      else if (def.staleAfter && age > def.staleAfter) status = 'stale';
      else if (f.warn) status = 'renew';
      else status = 'ok';
      return { ...def, configured: !!f.configured, lastSync: f.lastSync || 0, ageMs: age, records: f.records == null ? null : f.records, error: f.error || null, note: f.note || null, status };
    });
  }

  // Worst status wins for the summary pill. 'waiting' and 'off' are not
  // problems on their own (Jaddaf not live yet, optional sources).
  const RANK = { error: 3, stale: 2, renew: 2, ok: 0, waiting: 0, off: 0 };
  function summarize(list) {
    const worst = list.reduce((w, s) => (RANK[s.status] > RANK[w.status] ? s : w), { status: 'ok' });
    const problems = list.filter(s => RANK[s.status] > 0);
    return { status: worst.status, problems: problems.map(s => s.name) };
  }

  return { SOURCES, describeSources, summarize };
});
