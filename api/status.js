const { CFG, configured, ensureSession, findPartnerId, readMeta, readOrders } = require('./_lib/grubcenter');
const { writeMeta } = require('./_lib/store');

module.exports = async (req, res) => {
  const out = { configured: configured(), connected: false, user: CFG.email || null, partnerId: null };
  if (out.configured) {
    try {
      const meta = await readMeta();
      const session = await ensureSession(meta.session);
      if (session !== meta.session) await writeMeta({ ...meta, session });
      out.connected = true;
      out.partnerId = findPartnerId(session.claims);
      out.claims = { email: session.claims.email, partnerStatus: session.claims.partnerStatus };
      out.lastSync = meta.lastSync;
      out.cachedCount = (await readOrders()).length;
    } catch (e) {
      out.error = e.message;
    }
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json(out);
};
