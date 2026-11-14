const { configured, liveToday } = require('./_lib/grubcenter');

// Today's orders straight from GrubCENTER, for the dashboard's 5-second
// live view. Never writes to storage; see liveToday() in _lib/grubcenter.js.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, orders: [] });
    return;
  }
  try {
    const d = await liveToday();
    res.status(200).json({ ok: true, day: d.day, at: d.at, orders: d.orders });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 200), orders: [] });
  }
};
