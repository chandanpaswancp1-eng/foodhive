/* Backfill GrubCENTER order line items (Motor City "items sold") into the
 * Vercel Blob store for days the regular syncs never covered. Line items
 * take ~20 s per day to pull, far past a Vercel function's limit, so this
 * runs locally:
 *
 *   node scripts/backfill-order-items.js [--from 2026-08-17] [--to 2026-11-09] [--dry-run] [--local]
 *
 * Defaults: from the first day with orders to the day before the earliest
 * day already holding line items. Credentials come from .env (GrubCENTER)
 * and .env.local (BLOB_READ_WRITE_TOKEN), like server.js and seed-blob.js.
 *
 * Rules, so nothing wrong or partial is saved:
 * - A day is written only if GrubCENTER returned it without error. A day
 *   with orders but no line items is treated as failed and left untouched.
 * - Each day's lines are checked against that day's non-cancelled orders,
 *   and the share of orders with lines is reported.
 * - Every 5 days the store is re-read and only the fetched days are
 *   replaced, so progress survives an interruption and other days (written
 *   by the live syncs meanwhile) are kept.
 * - --local also updates data/order_items.json for the local server.
 * - --local-only pulls from GrubCENTER into data/order_items.backfill.json
 *   without touching the Blob store; --push-local then copies those days
 *   from that file to the Blob store (no GrubCENTER calls). Use this
 *   to pull first and publish once the windowed /api/order-items is live. */
const fs = require('fs');
const path = require('path');
for (const f of ['.env', '.env.local']) {
  try {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
const G = require('../api/_lib/grubcenter');
const N = require('../public/normalize.js');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const flag = k => process.argv.includes('--' + k);
const LOCAL_ONLY = flag('local-only'), PUSH_LOCAL = flag('push-local');
const DRY = flag('dry-run'), LOCAL = flag('local') || LOCAL_ONLY;
// --local-only and --push-local use their own file: the local server
// rewrites data/order_items.json from memory on every sync, which wiped
// days the first run had saved there.
const LOCAL_FILE = path.join(__dirname, '..', 'data', LOCAL_ONLY || PUSH_LOCAL ? 'order_items.backfill.json' : 'order_items.json');
const readLocal = () => { try { return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch (_) { return []; } };
const CHUNK = 5;
const day = G.dubaiDateKey;
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

// Copy days [from, to] from data/order_items.json into the Blob store,
// replacing only those days there.
async function pushLocal() {
  const from = arg('from'), to = arg('to');
  if (!from || !to) throw new Error('--push-local needs --from and --to');
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN missing (.env.local)');
  const local = readLocal().filter(x => x.at && day(x.at) >= from && day(x.at) <= to);
  const days = new Set(local.map(x => day(x.at)));
  const missing = daysBetween(from, to).filter(d => !days.has(d));
  if (missing.length) console.log(`Note: no local lines for ${missing.length} day(s): ${missing.join(', ')} (left as they are in the store)`);
  const current = await G.readOrderItems();
  const next = current.filter(x => !days.has(day(x.at))).concat(local);
  console.log(`Pushing ${local.length} lines for ${days.size} day(s). Store ${current.length} → ${next.length} lines.${DRY ? ' DRY RUN' : ''}`);
  if (!DRY) await G.writeOrderItems(next);
  const check = DRY ? next : await G.readOrderItems();
  const after = new Set(check.map(x => day(x.at)));
  console.log(`Store now covers ${after.size} days, ${[...after].sort()[0]} → ${[...after].sort().pop()}, ${check.length} lines.`);
}

async function main() {
  if (PUSH_LOCAL) return pushLocal();
  if (!G.configured()) throw new Error('GrubCENTER credentials missing (.env)');
  if (!DRY && !LOCAL_ONLY && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN missing (.env.local)');

  const [orders, existing, meta] = await Promise.all([G.readOrders(), G.readOrderItems(), G.readMeta()]);
  const haveDays = new Set(existing.map(x => day(x.at)));
  const orderDays = orders.filter(o => o.source !== 'urbanpiper' && o.receivedAt).map(o => day(o.receivedAt)).sort();
  const firstLine = [...haveDays].sort()[0];
  const from = arg('from') || orderDays[0];
  const to = arg('to') || (firstLine ? addDays(firstLine, -1) : addDays(day(Date.now()), -1));
  const ordersByDay = {};
  for (const o of orders) if (!o.cancelled && o.source !== 'urbanpiper') { const d = day(o.receivedAt); (ordersByDay[d] = ordersByDay[d] || new Set()).add(String(o.id)); }
  const days = daysBetween(from, to);
  console.log(`Backfill ${from} → ${to}: ${days.length} days. Store has ${existing.length} lines (${haveDays.size} days, from ${firstLine}).${DRY ? ' DRY RUN' : ''}`);

  // GrubCENTER sessions expire within the hour, and a long backfill outlives
  // one: every day after expiry failed. Refresh before each chunk.
  let session = await G.ensureSession(meta.session);
  const report = new Map();
  let written = 0;
  const runChunk = async (chunk) => {
    session = await G.ensureSession(session);
    const t0 = Date.now();
    const raw = await G.fetchPaged(G.CFG.orderItemsPath, chunk[0], chunk[chunk.length - 1], 25, session);
    const failed = new Set(raw.failedDays || []);
    const lines = N.normalizeOrderItems(raw).filter(x => x.at && !day(x.at).includes('NaN'));
    const byDay = {};
    for (const x of lines) (byDay[day(x.at)] = byDay[day(x.at)] || []).push(x);
    const good = [];
    for (const d of chunk) {
      const got = byDay[d] || [], ord = ordersByDay[d] ? ordersByDay[d].size : 0;
      const covered = new Set(got.map(x => String(x.orderId))).size;
      let status = 'ok';
      if (failed.has(d)) status = 'FAILED (GrubCENTER error)';
      else if (!got.length && ord) status = 'FAILED (no lines for a day with orders)';
      report.set(d, { d, lines: got.length, orders: ord, covered, status });
      console.log(`  ${d}: ${String(got.length).padStart(5)} lines, ${covered}/${ord} orders${ord ? ` (${Math.round(covered / ord * 100)}%)` : ''} ${status}`);
      if (status === 'ok') good.push(d);
    }
    if (!DRY && good.length) {
      const keep = new Set(good);
      const fresh = good.flatMap(d => byDay[d] || []);
      let note = '';
      if (!LOCAL_ONLY) {
        const current = await G.readOrderItems();
        const next = current.filter(x => !keep.has(day(x.at))).concat(fresh);
        await G.writeOrderItems(next);
        note += ` store now ${next.length} lines;`;
      }
      if (LOCAL) {
        const local = readLocal();
        const next = local.filter(x => !keep.has(day(x.at))).concat(fresh);
        fs.writeFileSync(LOCAL_FILE, JSON.stringify(next));
        note += ` local file now ${next.length} lines;`;
      }
      written += good.length;
      console.log(`  saved ${good.length} day(s);${note} ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };

  // Resume: skip days already holding lines in the target (the local file
  // with --local-only, else the store) unless --force.
  const target = LOCAL_ONLY ? readLocal() : existing;
  const done = new Set(flag('force') ? [] : target.map(x => day(x.at)));
  let todo = days.filter(d => !done.has(d));
  if (todo.length < days.length) console.log(`Skipping ${days.length - todo.length} day(s) already saved (use --force to re-pull).`);
  const chunks = list => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };
  for (const c of chunks(todo)) await runChunk(c);
  // Up to two retry passes for failed days, each with a fresh session.
  for (let pass = 1; pass <= 2; pass++) {
    const retry = todo.filter(d => report.get(d) && report.get(d).status !== 'ok');
    if (!retry.length) break;
    console.log(`\nRetry pass ${pass}: ${retry.length} day(s)`);
    await new Promise(r => setTimeout(r, 5000));
    for (const c of chunks(retry)) await runChunk(c);
  }

  const all = [...report.values()];
  const bad = all.filter(r => r.status !== 'ok');
  const tot = all.filter(r => r.status === 'ok').reduce((a, r) => ({ lines: a.lines + r.lines, orders: a.orders + r.orders, covered: a.covered + r.covered }), { lines: 0, orders: 0, covered: 0 });
  console.log(`\nDone. ${written} of ${todo.length} day(s) saved this run. ${tot.lines} lines covering ${tot.covered} of ${tot.orders} orders (${tot.orders ? Math.round(tot.covered / tot.orders * 100) : 0}%).`);
  if (bad.length) console.log(`Not saved (re-run with --from/--to to retry): ${bad.map(r => r.d).join(', ')}`);
  const low = all.filter(r => r.status === 'ok' && r.orders && r.covered / r.orders < 0.9);
  if (low.length) console.log(`Below 90% of orders covered: ${low.map(r => `${r.d} (${r.covered}/${r.orders})`).join(', ')}`);
}

main().catch(e => { console.error('Backfill failed:', e.message); process.exit(1); });
