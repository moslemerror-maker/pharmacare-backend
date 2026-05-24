const router = require('express').Router();
const db     = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, category } = req.query;
    let where = ['is_active=true'], params = [], i = 1;
    if (search)   { where.push(`name ILIKE $${i++}`);    params.push(`%${search}%`); }
    if (category) { where.push(`category = $${i++}`);   params.push(category); }
    res.json(await db.getAll(
      `SELECT * FROM lab_tests WHERE ${where.join(' AND ')} ORDER BY category, name`,
      params
    ));
  } catch (err) { next(err); }
});

router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      'SELECT DISTINCT category FROM lab_tests WHERE is_active=true ORDER BY category'
    );
    res.json(rows.map(r => r.category));
  } catch (err) { next(err); }
});

module.exports = router;
