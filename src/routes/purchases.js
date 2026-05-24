const router = require('express').Router();
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

async function genGrnNumber() {
  const n = new Date();
  const ym = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}`;
  const last = await db.getOne(
    "SELECT grn_number FROM grn ORDER BY id DESC LIMIT 1"
  );
  const seq = last ? (parseInt(last.grn_number.split('-').pop()) + 1) : 1;
  return `GRN-${ym}-${String(seq).padStart(5,'0')}`;
}

// GET /api/purchases
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { limit=50, offset=0, date_from, date_to } = req.query;
    let where = ['true'], params = [], i = 1;
    if (date_from) { where.push(`g.received_date >= $${i++}`); params.push(date_from); }
    if (date_to)   { where.push(`g.received_date <= $${i++}`); params.push(date_to); }
    params.push(parseInt(limit), parseInt(offset));
    const rows = await db.getAll(
      `SELECT g.*, s.name AS supplier_name FROM grn g
       LEFT JOIN suppliers s ON g.supplier_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY g.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const total = await db.getOne(
      `SELECT COUNT(*) AS c FROM grn g WHERE ${where.slice(0,-0).join(' AND ')}`,
      params.slice(0,-2)
    );
    res.json({ data: rows, total: parseInt(total.c) });
  } catch (err) { next(err); }
});

// GET /api/purchases/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const grn = await db.getOne(
      `SELECT g.*, s.name AS supplier_name FROM grn g
       LEFT JOIN suppliers s ON g.supplier_id=s.id WHERE g.id=$1`,
      [req.params.id]
    );
    if (!grn) return res.status(404).json({ error: 'GRN not found' });
    grn.items = await db.getAll(
      `SELECT gi.*, m.name AS medicine_name, m.generic_name, m.form, m.strength
       FROM grn_items gi JOIN medicines m ON gi.medicine_id=m.id
       WHERE gi.grn_id=$1`,
      [grn.id]
    );
    res.json(grn);
  } catch (err) { next(err); }
});

// POST /api/purchases — create GRN & update inventory
router.post('/', authenticate, authorize('admin','pharmacist','manager'), async (req, res, next) => {
  try {
    const { supplier_id, invoice_number, invoice_date, items=[], notes } = req.body;
    if (!items.length) return res.status(400).json({ error: 'No items provided' });

    const result = await db.transaction(async (client) => {
      let subtotal=0, cgst=0, sgst=0;
      const grn_number = await genGrnNumber();

      const grnRow = await client.query(
        `INSERT INTO grn (grn_number,supplier_id,invoice_number,invoice_date,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [grn_number, supplier_id||null, invoice_number||null,
         invoice_date||null, notes||null, req.user.id]
      );
      const grn_id = grnRow.rows[0].id;

      for (const item of items) {
        const totalQty = (parseInt(item.quantity)||0) + (parseInt(item.free_quantity)||0);
        const lineSubtotal = item.quantity * item.purchase_rate * (1 - (item.discount_percent||0)/100);
        const c = lineSubtotal * (item.cgst_percent||6) / 100;
        const s = lineSubtotal * (item.sgst_percent||6) / 100;
        subtotal += lineSubtotal; cgst += c; sgst += s;

        await client.query(
          `INSERT INTO grn_items
           (grn_id,medicine_id,batch_number,expiry_date,quantity,free_quantity,
            purchase_rate,mrp,discount_percent,cgst_percent,sgst_percent,total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [grn_id, item.medicine_id, item.batch_number, item.expiry_date,
           item.quantity, item.free_quantity||0, item.purchase_rate, item.mrp,
           item.discount_percent||0, item.cgst_percent||6, item.sgst_percent||6,
           lineSubtotal+c+s]
        );

        // Upsert inventory
        const existing = await client.query(
          'SELECT id FROM inventory WHERE medicine_id=$1 AND batch_number=$2',
          [item.medicine_id, item.batch_number]
        );
        if (existing.rows.length) {
          await client.query(
            'UPDATE inventory SET quantity_in=quantity_in+$1, mrp=$2, purchase_rate=$3 WHERE id=$4',
            [totalQty, item.mrp, item.purchase_rate, existing.rows[0].id]
          );
        } else {
          await client.query(
            `INSERT INTO inventory
             (medicine_id,batch_number,expiry_date,mrp,purchase_rate,quantity_in,supplier_id,grn_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [item.medicine_id, item.batch_number, item.expiry_date,
             item.mrp, item.purchase_rate, totalQty, supplier_id||null, grn_id]
          );
        }
      }

      const total = subtotal + cgst + sgst;
      await client.query(
        'UPDATE grn SET subtotal=$1, cgst_amount=$2, sgst_amount=$3, total_amount=$4 WHERE id=$5',
        [subtotal.toFixed(2), cgst.toFixed(2), sgst.toFixed(2), total.toFixed(2), grn_id]
      );
      return { grn_number, id: grn_id, total_amount: total.toFixed(2) };
    });

    res.status(201).json({ message: 'GRN created successfully', ...result });
  } catch (err) { next(err); }
});

module.exports = router;
