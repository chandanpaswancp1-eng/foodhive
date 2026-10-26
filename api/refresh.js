const { waitUntil } = require('@vercel/functions');
const { configured, syncOnce, dubaiDateKey } = require('./_lib/grubcenter');

// Keep on-demand refreshes inside the function's maxDuration (60s on
// Vercel). A 14-day pull takes ~6 minutes locally -- far past that limit --
// so the function was killed mid-sync and nothing was persisted, which is
// exactly why the dashboard's "Sync Now" button appeared to do nothing in
// production. A 3-day window finishes in well under a minute; older history
// is covered by the daily cron and /api/refresh?full=1.
const MAX_ON_DEMAND_DAYS = 3;

// No range (the All / Week / Month pills) -> today only. A short explicit
// range is honoured; anything wider falls back to `to` rather than fanning
// out to the whole selection.
function clampFrom(from, to) {
  if (!from) return to;
  const toMs = new Date(to + 'T00:00:00Z').getTime();
  const minFrom = new Date(toMs - MAX_ON_DEMAND_DAYS * 864e5).toISOString().slice(0, 10);
  return from < minFrom || from > to ? to : from;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, message: 'GrubCENTER credentials not configured on this deployment' });
    return;
  }
  const url = new URL(req.url, 'http://x');
  const full = url.searchParams.get('full') === '1';
  // `full=1` forces a complete 45-day re-sync regardless of cached data.
  // This can exceed maxDuration on Vercel; it is meant for a local run or a
  // deployment with a longer limit.
  if (full) {
    waitUntil(syncOnce(dubaiDateKey(Date.now() - 45 * 864e5), dubaiDateKey(Date.now())).catch(() => {}));
    res.status(200).json({ ok: true, configured: true, message: 'Full 45-day re-sync started' });
    return;
  }

  const to = url.searchParams.get('to') || dubaiDateKey(Date.now());
  const from = clampFrom(url.searchParams.get('from'), to);
  waitUntil(syncOnce(from, to, from).catch(() => {}));
  res.status(200).json({ ok: true, configured: true, message: 'Sync started', from, to });
};
