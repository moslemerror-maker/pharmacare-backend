const router = require('express').Router();
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/medicines
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search = '', category, form, schedule, limit = 200 } = req.query;
    let where = ['m.is_active = true'], params = [];
    let i = 1;

    if (search) {
      where.push(`(m.name ILIKE $${i} OR m.generic_name ILIKE $${i} OR m.barcode = $${i+1})`);
      params.push(`%${search}%`, search); i += 2;
    }
    if (category) { where.push(`m.category = $${i++}`); params.push(category); }
    if (form)     { where.push(`m.form = $${i++}`);     params.push(form); }
    if (schedule) { where.push(`m.schedule = $${i++}`); params.push(schedule); }

    params.push(parseInt(limit));
    const rows = await db.getAll(
      `SELECT * FROM medicines m WHERE ${where.join(' AND ')}
       ORDER BY m.name LIMIT $${i}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/medicines/categories
router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      'SELECT DISTINCT category FROM medicines WHERE is_active=true AND category IS NOT NULL ORDER BY category'
    );
    res.json(rows.map(r => r.category));
  } catch (err) { next(err); }
});

// GET /api/medicines/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const m = await db.getOne(
      'SELECT * FROM medicines WHERE id = $1 OR uuid::text = $1',
      [req.params.id]
    );
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json(m);
  } catch (err) { next(err); }
});

// POST /api/medicines
router.post('/', authenticate, authorize('admin', 'pharmacist', 'manager'), async (req, res, next) => {
  try {
    const {
      name, generic_name, brand, category, form, strength, unit,
      barcode, hsn_code, gst_rate, manufacturer, schedule,
      reorder_level, min_stock, rack_location
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const m = await db.getOne(
      `INSERT INTO medicines
       (name,generic_name,brand,category,form,strength,unit,barcode,
        hsn_code,gst_rate,manufacturer,schedule,reorder_level,min_stock,rack_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [name,generic_name||null,brand||null,category||null,form||null,
       strength||null,unit||'Nos',barcode||null,hsn_code||null,
       gst_rate||12,manufacturer||null,schedule||'OTC',
       reorder_level||10,min_stock||5,rack_location||null]
    );
    res.status(201).json(m);
  } catch (err) { next(err); }
});

// PUT /api/medicines/:id
router.put('/:id', authenticate, authorize('admin', 'pharmacist', 'manager'), async (req, res, next) => {
  try {
    const {
      name,generic_name,brand,category,form,strength,unit,barcode,
      hsn_code,gst_rate,manufacturer,schedule,reorder_level,min_stock,
      rack_location,is_active
    } = req.body;
    await db.run(
      `UPDATE medicines SET
       name=$1,generic_name=$2,brand=$3,category=$4,form=$5,strength=$6,
       unit=$7,barcode=$8,hsn_code=$9,gst_rate=$10,manufacturer=$11,
       schedule=$12,reorder_level=$13,min_stock=$14,rack_location=$15,is_active=$16
       WHERE id=$17`,
      [name,generic_name,brand,category,form,strength,unit,barcode,
       hsn_code,gst_rate,manufacturer,schedule,reorder_level,min_stock,
       rack_location,is_active,req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

module.exports = router;
