/* Zoho Books auth + fetch + sync, adapted from server.js for stateless
 * serverless functions: the OAuth access token is persisted in the zoho
 * meta blob (via store.js) and passed in/out explicitly instead of living
 * in a module-level variable, since nothing here can rely on surviving
 * between invocations other than what's written to the Blob store. */
const { readZoho, writeZoho, readZohoMeta, writeZohoMeta } = require('./store');

const E = process.env;
const CFG = {
  clientId: E.ZOHO_CLIENT_ID,
  clientSecret: E.ZOHO_CLIENT_SECRET,
  refreshToken: E.ZOHO_REFRESH_TOKEN,
  accountsDomain: E.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com',
  apiDomain: E.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
  orgId: E.ZOHO_ORG_ID
};

const configured = () => !!(CFG.clientId && CFG.clientSecret && CFG.refreshToken && CFG.orgId);

async function zohoLogin() {
  const r = await fetch(`${CFG.accountsDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CFG.clientId,
      client_secret: CFG.clientSecret,
      refresh_token: CFG.refreshToken
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Zoho auth failed: ' + (j.error || r.status));
  return { accessToken: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
}
const ensureSession = async cached => (cached && cached.exp > Date.now() ? cached : zohoLogin());

async function zget(p, query, session) {
  const qp = new URLSearchParams({ organization_id: CFG.orgId, ...(query || {}) });
  const url = `${CFG.apiDomain}/books/v3${p}?${qp}`;
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${session.accessToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (typeof j.code === 'number' && j.code !== 0)) {
    throw new Error(`Zoho ${r.status} ${p}: ${j.message || r.statusText}`);
  }
  return j;
}

// Zoho list endpoints (invoices/bills) cap at per_page=200 and flag more pages via page_context.has_more_page.
async function zGetAllPages(p, listKey, query, session) {
  const all = [];
  for (let page = 1; ; page++) {
    const j = await zget(p, { ...query, per_page: 200, page }, session);
    all.push(...(j[listKey] || []));
    if (!j.page_context || !j.page_context.has_more_page) break;
  }
  return all;
}

// Zoho's Profit & Loss report nests sections arbitrarily deep, so this
// recurses into a flat { "Operating Income": 12345, ... } name->total lookup
// instead of assuming a fixed depth. Mirrors server.js's flattenPL().
// First-occurrence-wins (not last) -- if a name were ever repeated at a
// deeper level, the authoritative top-level total (visited first in a
// top-down walk) must not be silently overwritten by a coincidentally
// same-named descendant.
function flattenPL(rows, map) {
  map = map || {};
  for (const r of (rows || [])) {
    if (!(r.name in map)) map[r.name] = +r.total || 0;
    if (r.account_transactions && r.account_transactions.length) flattenPL(r.account_transactions, map);
  }
  return map;
}

const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
const pad2 = n => String(n).padStart(2, '0');
function monthRange(offsetMonths) {
  const now = new Date(Date.now() + DUBAI_OFFSET_MS);
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + offsetMonths;
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  const iso = d => d.toISOString().slice(0, 10);
  // Current month only: cap `to` at today, not the calendar month-end. The
  // frontend's GrubCENTER current-month revenue figure
  // (grubCenterMonthFigures()) is always month-to-date (no future orders
  // can exist), so the Zoho expense window fetched here must share that
  // same anchor -- otherwise Net Profit/True Net Profit blend a
  // month-to-date revenue figure against a full-month expense figure (e.g.
  // a pre-dated recurring bill later in the month would count as an
  // expense before its matching revenue days have actually happened).
  // Closed/past months keep the full calendar month-end, since "today"
  // doesn't apply to them.
  const to = offsetMonths === 0 ? iso(now) : iso(end);
  return {
    from: iso(start), to,
    key: `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}`,
    label: start.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  };
}
function dubaiToday() {
  const d = new Date(Date.now() + DUBAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

async function fetchPLTotals(from, to, session) {
  const j = await zget('/reports/profitandloss', { from_date: from, to_date: to }, session);
  const m = flattenPL(j.profit_and_loss);
  const income = (m['Operating Income'] || 0) + (m['Non Operating Income'] || 0);
  const expenses = (m['Cost of Goods Sold'] || 0) + (m['Operating Expense'] || 0) + (m['Non Operating Expense'] || 0);
  const netProfit = m['Net Profit/Loss'] != null ? m['Net Profit/Loss'] : income - expenses;
  return { income, expenses, netProfit, rawTree: j.profit_and_loss };
}

// Finds a named section (not a same-named leaf -- see flattenPL's comment on
// why Zoho can repeat a section's own name as a leaf directly beneath it) by
// returning the first match found in a top-down walk, then maps that
// section's immediate children into { name, amount } leaf items. This has
// to recurse: verified against live data that 'Cost of Goods Sold' and
// 'Operating Expense' are NOT top-level rows here -- they're nested several
// levels under grouping rows like "Gross Profit"/"Operating Profit", so a
// top-level-only scan (tried and reverted) silently found nothing. Mirrors
// server.js's extractCategoryBreakdown()/findSection().
function findSection(rows, name) {
  for (const r of (rows || [])) {
    if (r.name === name) return r;
    if (r.account_transactions && r.account_transactions.length) {
      const found = findSection(r.account_transactions, name);
      if (found) return found;
    }
  }
  return null;
}
function extractCategoryBreakdown(tree) {
  const leafItems = section => ((section && section.account_transactions) || []).map(r => ({ name: r.name, amount: +r.total || 0 }));
  const cogs = findSection(tree, 'Cost of Goods Sold');
  const opex = findSection(tree, 'Operating Expense');
  return {
    cogs: { total: cogs ? +cogs.total || 0 : 0, items: leafItems(cogs) },
    operatingExpense: { total: opex ? +opex.total || 0 : 0, items: leafItems(opex) }
  };
}

async function fetchBalanceSheet(session) {
  const j = await zget('/reports/balancesheet', { as_of_date: dubaiToday() }, session);
  return j.balance_sheet || [];
}

// Zoho's Balance Sheet report is always exactly two top-level rows (Assets,
// then Liabilities & Equities), so this reads off that stable position
// rather than matching an exact label string that could vary by org/locale.
// Mirrors server.js's extractBalanceSheet().
function extractBalanceSheet(tree) {
  const assetsRow = (tree || [])[0] || null;
  const liabEquityRow = (tree || [])[1] || null;
  const findChild = (row, label) => ((row && row.account_transactions) || []).find(r => r.total_label === label || r.name === label) || null;
  const liabilitiesRow = findChild(liabEquityRow, 'Total Liabilities');
  const equityRow = findChild(liabEquityRow, 'Total Equities');
  const totalAssets = assetsRow ? +assetsRow.total || 0 : 0;
  const totalLiabilities = liabilitiesRow ? +liabilitiesRow.total || 0 : 0;
  const totalEquity = equityRow ? +equityRow.total || 0 : 0;
  return {
    totalAssets, totalLiabilities, totalEquity,
    // Sanity check on the accounting equation (Assets = Liabilities +
    // Equity), since totalEquity is read independently off Zoho's own
    // "Total Equities" row rather than computed as Assets - Liabilities --
    // a wrong two-row positional guess above or a Zoho-side reporting
    // quirk would otherwise pass through silently. 1 AED tolerance for
    // report rounding.
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1,
    tree: tree || []
  };
}

// One-time (first sync only): find the real start of this org's books by
// asking Zoho for its single earliest bill and earliest invoice, so the P&L
// trend can be backfilled from actual day one instead of a guessed window.
async function findEarliestBookDate(session) {
  let earliest = null;
  for (const [p, key] of [['/bills', 'bills'], ['/invoices', 'invoices']]) {
    try {
      const j = await zget(p, { sort_column: 'date', sort_order: 'A', per_page: 1 }, session);
      const d = j[key] && j[key][0] && j[key][0].date;
      if (d && (!earliest || d < earliest)) earliest = d;
    } catch (_) { /* endpoint unavailable or empty -- fall through */ }
  }
  return earliest; // 'YYYY-MM-DD' or null if the org has no bills/invoices yet
}

// How many whole months back `dateStr`'s month is from the current
// (Dubai-local) month -- e.g. last month = 1, this month = 0.
function monthsBack(dateStr) {
  const now = new Date(Date.now() + DUBAI_OFFSET_MS);
  const [y, m] = dateStr.split('-').map(Number);
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (m - 1));
}

/** Pull live accounting KPIs and persist them to the Blob store. Mirrors
 * server.js's syncZoho(), but reads/writes the Blob store instead of an
 * in-memory STORE + local disk, and threads the OAuth session explicitly
 * instead of a module-level variable. */
// Best-effort guard against two syncs running at once within the SAME warm
// Lambda instance (e.g. a stale-triggered request landing while the daily
// cron or a manual refresh is still mid-backfill) -- a module-level flag
// doesn't survive across cold starts/instances, so this isn't a full
// cross-invocation lock, but it closes the common case server.js's
// STORE.zohoSyncing guard closes for the long-running process.
let zohoSyncInFlight = false;

async function syncOnce() {
  if (!configured()) return { skipped: true, reason: 'not configured' };
  if (zohoSyncInFlight) return { skipped: true, reason: 'sync already in progress on this instance' };
  zohoSyncInFlight = true;
  try {
    return await syncOnceInner();
  } finally {
    zohoSyncInFlight = false;
  }
}

async function syncOnceInner() {
  const meta = await readZohoMeta();
  const session = await ensureSession(meta.session);

  const prevZoho = await readZoho();
  const prevByKey = new Map(((prevZoho && prevZoho.trend) || []).map(t => [t.key, t]));
  let offsetsToFetch;
  if (prevByKey.size === 0) {
    // First-ever sync: backfill every month since the org's actual first
    // bill/invoice, not a guessed window, so nothing is missed.
    const earliest = await findEarliestBookDate(session);
    const monthsOfHistory = earliest ? monthsBack(earliest) : 0;
    offsetsToFetch = Array.from({ length: monthsOfHistory + 1 }, (_, i) => i - monthsOfHistory);
  } else {
    // Closed months don't change -- only refresh current + previous month.
    offsetsToFetch = [-1, 0];
  }

  // Sequential, not parallel: Zoho's reports endpoints enforce a fairly
  // tight per-minute request cap, and firing these calls concurrently
  // reliably triggers a 429 "exceeded the maximum number of requests per
  // minute" block that then takes several minutes to clear.
  const fetched = [];
  let currentMonthTree = null;
  for (const offset of offsetsToFetch) {
    const { key, label, from, to } = monthRange(offset);
    const { income, expenses, netProfit, rawTree } = await fetchPLTotals(from, to, session);
    fetched.push({ key, label, income, expenses, netProfit });
    if (offset === 0) currentMonthTree = rawTree;
  }
  fetched.forEach(f => prevByKey.set(f.key, f));

  // Unbounded and permanently cumulative -- once a month is fetched it stays
  // in the trend forever (sorted chronologically by key), instead of being
  // capped/sliced to a fixed trailing window.
  const trend = [...prevByKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const current = trend[trend.length - 1];

  const toDate = dubaiToday();
  const bankResp = await zget('/bankaccounts', {}, session);
  const arAging = await zget('/reports/aragingsummary', { to_date: toDate }, session);
  const apAging = await zget('/reports/apagingsummary', { to_date: toDate }, session);
  const balanceSheetTree = await fetchBalanceSheet(session);
  // Full lists (all statuses), not just overdue -- these double as both the
  // overdue KPI source below and the raw data for Data Export.
  const allInvoices = await zGetAllPages('/invoices', 'invoices', {}, session);
  const allBills = await zGetAllPages('/bills', 'bills', {}, session);
  // Balance + due-date based, not status-based: Zoho relabels an invoice/bill
  // 'partially_paid' once any payment lands, even if it's still outstanding
  // and past due, so a status==='overdue' filter alone silently drops those
  // records.
  const isOverdue = x => (+x.balance || 0) > 0 && x.due_date && x.due_date < toDate;
  const overdueInvoices = allInvoices.filter(isOverdue);
  const overdueBills = allBills.filter(isOverdue);

  const activeBankAccounts = (bankResp.bankaccounts || []).filter(a => a.is_active && (a.account_type === 'bank' || a.account_type === 'cash'));

  const toBuckets = intervals => (intervals || []).map(i => ({ label: i.interval_formatted, amount: +i.amount || 0 }));

  const zoho = {
    income: current.income,
    expenses: current.expenses,
    netProfit: current.netProfit,
    netMargin: current.income ? current.netProfit / current.income : 0,
    // The calendar month current.income/expenses/netProfit actually cover,
    // so the frontend can detect (and warn) when this is stale against its
    // own live-clock "current month" -- e.g. right after a month rollover,
    // before the next sync has re-fetched the new month's P&L.
    currentMonthKey: current.key,
    currentMonthExpenseBreakdown: extractCategoryBreakdown(currentMonthTree),
    balanceSheet: extractBalanceSheet(balanceSheetTree),
    bankAccounts: activeBankAccounts.map(a => ({ name: a.account_name, type: a.account_type, balance: +a.balance || 0, currency: a.currency_code })),
    ar: arAging.invoice ? +arAging.invoice.total || 0 : 0,
    ap: apAging.bills ? +apAging.bills.total || 0 : 0,
    arAging: toBuckets(arAging.invoice && arAging.invoice.intervals),
    apAging: toBuckets(apAging.bills && apAging.bills.intervals),
    overdueInvoices: { count: overdueInvoices.length, amount: overdueInvoices.reduce((s, i) => s + (+i.balance || 0), 0) },
    overdueBills: { count: overdueBills.length, amount: overdueBills.reduce((s, b) => s + (+b.balance || 0), 0) },
    invoices: allInvoices,
    bills: allBills,
    trend,
    currency: (bankResp.bankaccounts && bankResp.bankaccounts[0] && bankResp.bankaccounts[0].currency_code) || 'AED',
    lastSync: Date.now()
  };

  await writeZoho(zoho);
  await writeZohoMeta({ session });

  return { ok: true, income: zoho.income, expenses: zoho.expenses, netProfit: zoho.netProfit };
}

module.exports = { CFG, configured, syncOnce, readZoho };
