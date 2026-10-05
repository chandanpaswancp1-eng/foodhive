/* One-off: seed the Vercel Blob store with the existing local historical
 * data so the deployed app has real data immediately, rather than waiting
 * on the first live GrubCENTER sync (which only pulls a recent window
 * anyway). Run locally with BLOB_READ_WRITE_TOKEN set (vercel env pull
 * populates .env.local with it automatically after `vercel blob create-store`). */
const fs = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) {}
const { put } = require('@vercel/blob');
const N = require('../public/normalize.js');

async function seed(file, blobName, transform) {
  const p = path.join(__dirname, '..', 'data', file);
  if (!fs.existsSync(p)) { console.log(`skip ${file} (not found)`); return; }
  let parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (transform) parsed = transform(parsed);
  const data = JSON.stringify(parsed);
  const { url } = await put(blobName, data, {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 0
  });
  console.log(`seeded ${blobName} <- ${file} (${(data.length / 1024).toFixed(0)}KB) -> ${url}`);
}

async function main() {
  // all_orders.json is already the normalized master cache (server.js writes it
  // back in normalized form after every sync) -- seed as-is.
  await seed('all_orders.json', 'orders.json');
  // cached_items.json is the RAW GrubCENTER export; server.js's preloadData()
  // normalizes it via N.normalizeItems() on load -- do the same here, once,
  // rather than shipping raw rows the frontend doesn't understand.
  await seed('cached_items.json', 'items.json', raw => N.normalizeItems(raw));
  await seed('official_foodhive_brands.json', 'official_foodhive_brands.json');
  await put('meta.json', JSON.stringify({ lastSync: 0, session: null, liveOpsCount: 0, liveCancelCount: 0 }), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 0
  });
  console.log('seeded meta.json (lastSync: 0, forces a fresh sync on first load)');
}

main().catch(e => { console.error(e); process.exit(1); });
