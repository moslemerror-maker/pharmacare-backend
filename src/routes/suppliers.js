const router = require('express').Router();
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res, next) => {
  try {
    res.json(await db.getAll('SELECT * FROM suppliers WHERE is_active=true ORDER BY name'));
  } catch (err) { next(err); }
});

router.post('/', authenticate, authorize('admin','manager'), async (req, res, next) => {
  try {
    const { name, contact_person, phone, email, address, gst_number, drug_license, payment_terms } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const row = await db.getOne(
      `INSERT INTO suppliers (name,contact_person,phone,email,address,gst_number,drug_license,payment_terms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name,contact_person,phone,email,address,gst_number,drug_license,payment_terms||'Net 30']
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, authorize('admin','manager'), async (req, res, next) => {
  try {
    const { name,contact_person,phone,email,address,gst_number,drug_license,payment_terms,is_active } = req.body;
    await db.run(
      `UPDATE suppliers SET name=$1,contact_person=$2,phone=$3,email=$4,address=$5,
       gst_number=$6,drug_license=$7,payment_terms=$8,is_active=$9 WHERE id=$10`,
      [name,contact_person,phone,email,address,gst_number,drug_license,payment_terms,is_active,req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

module.exports = router;
