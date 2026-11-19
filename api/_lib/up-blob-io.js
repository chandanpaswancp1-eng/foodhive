const store = require('./store');

// Vercel Blob storage for UrbanPiper (Jaddaf) data, in the `io` shape that
// api/up-import.js and api/_lib/atlas-sync.js take (server.js passes one
// backed by data/ files instead).
module.exports = {
  readMeta: store.readUpMeta, writeMeta: store.writeUpMeta,
  readOrders: store.readUpOrders, writeOrders: store.writeUpOrders,
  readOrderItems: store.readUpOrderItems, writeOrderItems: store.writeUpOrderItems,
  readItems: store.readUpItems, writeItems: store.writeUpItems,
  writeCatalog: store.writeUpCatalog,
  readConn: store.readUpConn, writeConn: store.writeUpConn
};
