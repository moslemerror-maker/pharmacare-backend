const router = require('express').Router();
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/inventory  — batch-level stock
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, category, low_stock, expiring_days, barcode } = req.query;
    let where = ['true'], params = [], i = 1;

    if (search) {
      where.push(`(m.name ILIKE $${i} OR m.generic_name ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }
    if (category) { where.push(`m.category = $${i++}`); params.push(category); }
    if (barcode)  { where.push(`m.barcode = $${i++}`);  params.push(barcode); }
    if (low_stock === 'true') {
      where.push('(inv.quantity_in - inv.quantity_out) <= m.reorder_level');
    }
    if (expiring_days) {
      params.push(parseInt(expiring_days)); i++;
      where.push(`inv.expiry_date <= CURRENT_DATE + INTERVAL '1 day' * $${i-1}`);
      where.push('(inv.quantity_in - inv.quantity_out) > 0');
    }

    const rows = await db.getAll(
      `SELECT inv.*,
              (inv.quantity_in - inv.quantity_out) AS current_qty,
              m.name AS medicine_name, m.generic_name, m.brand, m.form,
              m.strength, m.unit, m.barcode, m.category, m.schedule,
              m.reorder_level, m.min_stock, m.rack_location,
              m.gst_rate, m.hsn_code,
              s.name AS supplier_name
       FROM inventory inv
       JOIN medicines m ON inv.medicine_id = m.id
       LEFT JOIN suppliers s ON inv.supplier_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY m.name, inv.expiry_date`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/inventory/summary — aggregated per medicine
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT m.id AS medicine_id, m.name, m.generic_name, m.category,
              m.form, m.strength, m.unit, m.barcode, m.reorder_level,
              m.min_stock, m.rack_location, m.gst_rate,
              COALESCE(SUM(inv.quantity_in - inv.quantity_out), 0) AS total_stock,
              COUNT(DISTINCT inv.batch_number) AS batches,
              MIN(inv.expiry_date) AS nearest_expiry,
              MAX(inv.mrp) AS max_mrp
       FROM medicines m
       LEFT JOIN inventory inv ON m.id = inv.medicine_id
         AND (inv.quantity_in - inv.quantity_out) > 0
       WHERE m.is_active = true
       GROUP BY m.id
       ORDER BY m.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/inventory/batches/:medicine_id — batches available for a medicine
router.get('/batches/:medicine_id', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT *, (quantity_in - quantity_out) AS available_qty
       FROM inventory
       WHERE medicine_id = $1 AND (quantity_in - quantity_out) > 0
       ORDER BY expiry_date ASC`,
      [req.params.medicine_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/inventory/barcode/:code — scan barcode
router.get('/barcode/:code', authenticate, async (req, res, next) => {
  try {
    const med = await db.getOne(
      'SELECT * FROM medicines WHERE barcode = $1', [req.params.code]
    );
    if (!med) return res.status(404).json({ error: 'Medicine not found for this barcode' });

    const batches = await db.getAll(
      `SELECT *, (quantity_in - quantity_out) AS available_qty
       FROM inventory
       WHERE medicine_id = $1 AND (quantity_in - quantity_out) > 0
       ORDER BY expiry_date ASC`,
      [med.id]
    );
    const total_stock = batches.reduce((a, b) => a + parseInt(b.available_qty), 0);
    res.json({ medicine: med, batches, total_stock });
  } catch (err) { next(err); }
});

// GET /api/inventory/alerts
router.get('/alerts', authenticate, async (req, res, next) => {
  try {
    const [lowStock, expiring30, outOfStock] = await Promise.all([
      db.getAll(
        `SELECT m.id, m.name, m.category, m.reorder_level,
                COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) AS total_stock
         FROM medicines m
         LEFT JOIN inventory inv ON m.id = inv.medicine_id
         WHERE m.is_active = true
         GROUP BY m.id
         HAVING COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) <= m.reorder_level
           AND COALESCE(SUM(inv.quantity_in - inv.quantity_out),0) > 0
         ORDER BY total_stock ASC`
      ),
      db.getAll(
        `SELECT inv.*, m.name AS medicine_name,
                (inv.quantity_in - inv.quantity_out) AS current_qty
         FROM inventory inv JOIN medicines m ON inv.medicine_id = m.id
         WHERE (inv.quantity_in - inv.quantity_out) > 0
           AND inv.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         ORDER BY inv.expiry_date ASC`
      ),
      db.getAll(
        `SELECT m.id, m.name, m.category
         FROM medicines m
         WHERE m.is_active = true
           AND COALESCE((
             SELECT SUM(i2.quantity_in - i2.quantity_out)
             FROM inventory i2 WHERE i2.medicine_id = m.id
           ), 0) <= 0
         ORDER BY m.name`
      ),
    ]);
    res.json({ lowStock, expiring30, outOfStock });
  } catch (err) { next(err); }
});

// POST /api/inventory — add stock manually
router.post('/', authenticate, authorize('admin', 'pharmacist', 'manager'), async (req, res, next) => {
  try {
    const { medicine_id, batch_number, expiry_date, mrp,
            purchase_rate, quantity, supplier_id } = req.body;
    if (!medicine_id || !batch_number || !expiry_date || !quantity)
      return res.status(400).json({ error: 'medicine_id, batch_number, expiry_date, quantity required' });

    const existing = await db.getOne(
      'SELECT * FROM inventory WHERE medicine_id=$1 AND batch_number=$2',
      [medicine_id, batch_number]
    );
    if (existing) {
      await db.run(
        'UPDATE inventory SET quantity_in=quantity_in+$1, mrp=$2, purchase_rate=$3 WHERE id=$4',
        [quantity, mrp, purchase_rate, existing.id]
      );
      return res.json({ message: 'Stock updated', id: existing.id });
    }
    const row = await db.getOne(
      `INSERT INTO inventory
       (medicine_id,batch_number,expiry_date,mrp,purchase_rate,quantity_in,supplier_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [medicine_id, batch_number, expiry_date, mrp, purchase_rate, quantity, supplier_id||null]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

module.exports = router;
