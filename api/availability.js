const { readItems } = require('./_lib/grubcenter');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ items: await readItems() });
};
