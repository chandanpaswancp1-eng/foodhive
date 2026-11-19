/* Persistent data store for the Vercel deployment, backed by a private
 * Vercel Blob store (this is business sales/order data, not published
 * assets, so it stays non-public and reads/writes go through the
 * authenticated SDK rather than a bare fetch of a public URL). Replaces
 * server.js's in-memory STORE + local-disk JSON files, since serverless
 * functions share no memory and have no durable local disk. */
const { put, get } = require('@vercel/blob');

const ORDERS_KEY = 'orders.json';
const ITEMS_KEY = 'items.json';
const ORDER_ITEMS_KEY = 'order_items.json';
const META_KEY = 'meta.json';
const ZOHO_KEY = 'zoho.json';
const ZOHO_META_KEY = 'zoho_meta.json';

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
const readOrderItems = () => readBlobJson(ORDER_ITEMS_KEY, []);
const writeOrderItems = arr => writeBlobJson(ORDER_ITEMS_KEY, arr);
const readMeta = () => readBlobJson(META_KEY, { lastSync: 0, session: null, liveOpsCount: 0, liveCancelCount: 0 });
const writeMeta = meta => writeBlobJson(META_KEY, meta);
const readZoho = () => readBlobJson(ZOHO_KEY, null);
const writeZoho = data => writeBlobJson(ZOHO_KEY, data);
const readZohoMeta = () => readBlobJson(ZOHO_META_KEY, { session: null });
const writeZohoMeta = meta => writeBlobJson(ZOHO_META_KEY, meta);

// UrbanPiper (Jaddaf) data lives in its own files so its webhook writer never
// races the GrubCENTER sync writing orders.json. Readers merge at read time.
const UP_ORDERS_KEY = 'up_orders.json';
const UP_ORDER_ITEMS_KEY = 'up_order_items.json';
const UP_META_KEY = 'up_meta.json';
const readUpOrders = () => readBlobJson(UP_ORDERS_KEY, []);
const writeUpOrders = arr => writeBlobJson(UP_ORDERS_KEY, arr);
const readUpOrderItems = () => readBlobJson(UP_ORDER_ITEMS_KEY, []);
const writeUpOrderItems = arr => writeBlobJson(UP_ORDER_ITEMS_KEY, arr);
const UP_CATALOG_KEY = 'up_catalog.json';
const UP_ITEMS_KEY = 'up_items.json';
const readUpCatalog = () => readBlobJson(UP_CATALOG_KEY, null);
const writeUpCatalog = doc => writeBlobJson(UP_CATALOG_KEY, doc);
const readUpItems = () => readBlobJson(UP_ITEMS_KEY, []);
const writeUpItems = arr => writeBlobJson(UP_ITEMS_KEY, arr);
// Atlas session handed over by the bookmarklet. Private; never served.
const UP_CONN_KEY = 'up_conn.json';
const readUpConn = () => readBlobJson(UP_CONN_KEY, null);
const writeUpConn = conn => writeBlobJson(UP_CONN_KEY, conn);
const readUpMeta = () => readBlobJson(UP_META_KEY, { lastWebhookAt: 0, webhookCount: 0, catalogAt: 0 });
const writeUpMeta = meta => writeBlobJson(UP_META_KEY, meta);

// Aggregator store ratings, captured from partner portals (public/ratings.js).
const BRAND_RATINGS_KEY = 'brand_ratings.json';
const readBrandRatings = () => readBlobJson(BRAND_RATINGS_KEY, null);
const writeBrandRatings = doc => writeBlobJson(BRAND_RATINGS_KEY, doc);

// Every order carries its source. Orders stored before this field existed
// all came from GrubCENTER.
const withSource = (arr, source) => (arr || []).map(o => (o && !o.source ? { ...o, source } : o));
async function readAllOrders() {
  const [g, u] = await Promise.all([readOrders(), readUpOrders().catch(() => [])]);
  return withSource(g, 'grubcenter').concat(withSource(u, 'urbanpiper'));
}
async function readAllOrderItems() {
  const [g, u] = await Promise.all([readOrderItems(), readUpOrderItems().catch(() => [])]);
  return withSource(g, 'grubcenter').concat(withSource(u, 'urbanpiper'));
}

module.exports = { readOrders, writeOrders, readItems, writeItems, readOrderItems, writeOrderItems, readMeta, writeMeta, readZoho, writeZoho, readZohoMeta, writeZohoMeta, readBlobJson, writeBlobJson, readUpOrders, writeUpOrders, readUpOrderItems, writeUpOrderItems, readUpMeta, writeUpMeta, readUpCatalog, writeUpCatalog, readUpItems, writeUpItems, readUpConn, writeUpConn, readAllOrders, readAllOrderItems, withSource, readBrandRatings, writeBrandRatings };
