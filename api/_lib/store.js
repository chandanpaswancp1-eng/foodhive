/* Persistent data store for the Vercel deployment, backed by a private
 * Vercel Blob store (this is business sales/order data, not published
 * assets, so it stays non-public and reads/writes go through the
 * authenticated SDK rather than a bare fetch of a public URL). Replaces
 * server.js's in-memory STORE + local-disk JSON files, since serverless
 * functions share no memory and have no durable local disk. */
const { put, get } = require('@vercel/blob');

const ORDERS_KEY = 'orders.json';
const ITEMS_KEY = 'items.json';
const META_KEY = 'meta.json';

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

async function readBlobJson(pathname, fallback) {
  try {
    // useCache:false -- this store is written by syncOnce()/the seed script
    // and read by every /api/* request; serving a stale CDN-cached copy
    // after a write would show old data (or, worse, an old schema) for
    // however long the CDN edge holds onto it.
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || !result.stream) return fallback;
    return JSON.parse(await streamToString(result.stream));
  } catch (_) {
    return fallback;
  }
}

async function writeBlobJson(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  });
}

const readOrders = () => readBlobJson(ORDERS_KEY, []);
const writeOrders = arr => writeBlobJson(ORDERS_KEY, arr);
const readItems = () => readBlobJson(ITEMS_KEY, []);
const writeItems = arr => writeBlobJson(ITEMS_KEY, arr);
const readMeta = () => readBlobJson(META_KEY, { lastSync: 0, session: null, liveOpsCount: 0, liveCancelCount: 0 });
const writeMeta = meta => writeBlobJson(META_KEY, meta);

module.exports = { readOrders, writeOrders, readItems, writeItems, readMeta, writeMeta, readBlobJson, writeBlobJson };
