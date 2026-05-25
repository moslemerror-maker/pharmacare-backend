const router = require('express').Router();
const db     = require('../config/database');
const { authenticate } = require('../middleware/auth');

function genPatientId() {
  const y = new Date().getFullYear();
  const r = Math.floor(Math.random() * 90000) + 10000;
  return `PT-${y}-${r}`;
}

// GET /api/patients
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search = '', limit = 50, offset = 0 } = req.query;
    const q = `%${search}%`;
    const rows = await db.getAll(
      `SELECT p.*, u.name AS created_by_name
       FROM patients p LEFT JOIN users u ON p.created_by = u.id
       WHERE p.name ILIKE $1 OR p.phone ILIKE $1 OR p.patient_id ILIKE $1
       ORDER BY p.name LIMIT $2 OFFSET $3`,
      [q, parseInt(limit), parseInt(offset)]
    );
    const total = await db.getOne(
      'SELECT COUNT(*) AS c FROM patients WHERE name ILIKE $1 OR phone ILIKE $1 OR patient_id ILIKE $1',
      [q]
    );
    res.json({ data: rows, total: parseInt(total.c) });
  } catch (err) { next(err); }
});

// GET /api/patients/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const p = await db.getOne(
      'SELECT * FROM patients WHERE id::text = $1 OR patient_id = $1',
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: 'Patient not found' });

    const [vitals, prescriptions, sales] = await Promise.all([
      db.getAll(
        `SELECT pv.*, u.name AS recorded_by_name FROM patient_vitals pv
         LEFT JOIN users u ON pv.recorded_by = u.id
         WHERE pv.patient_id = $1 ORDER BY pv.recorded_at DESC LIMIT 10`,
        [p.id]
      ),
      db.getAll(
        `SELECT pr.id, pr.rx_number, pr.visit_date, pr.diagnosis, pr.status,
                u.name AS doctor_name, dp.specialization
         FROM prescriptions pr
         JOIN users u ON pr.doctor_id = u.id
         LEFT JOIN doctor_profiles dp ON u.id = dp.user_id
         WHERE pr.patient_id = $1 ORDER BY pr.visit_date DESC LIMIT 20`,
        [p.id]
      ),
      db.getAll(
        `SELECT id, bill_number, bill_date, total_amount, payment_mode, payment_status
         FROM sales WHERE patient_id = $1 AND is_cancelled = false
         ORDER BY bill_date DESC LIMIT 10`,
        [p.id]
      ),
    ]);

    res.json({ ...p, vitals, prescriptions, sales });
  } catch (err) { next(err); }
});

// POST /api/patients
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { name, dob, age, gender, phone, email, address,
            blood_group, allergies, insurance_number } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const patient = await db.getOne(
      `INSERT INTO patients
       (patient_id, name, dob, age, gender, phone, email, address,
        blood_group, allergies, insurance_number, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [genPatientId(), name, dob||null, age||null, gender||null, phone||null,
       email||null, address||null, blood_group||null, allergies||null,
       insurance_number||null, req.user.id]
    );
    res.status(201).json(patient);
  } catch (err) { next(err); }
});

// PUT /api/patients/:id
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { name, dob, age, gender, phone, email, address,
            blood_group, allergies, insurance_number } = req.body;
    await db.run(
      `UPDATE patients SET name=$1,dob=$2,age=$3,gender=$4,phone=$5,email=$6,
       address=$7,blood_group=$8,allergies=$9,insurance_number=$10,updated_at=NOW()
       WHERE id=$11`,
      [name,dob||null,age||null,gender||null,phone||null,email||null,
       address||null,blood_group||null,allergies||null,insurance_number||null,req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

// POST /api/patients/:id/vitals
router.post('/:id/vitals', authenticate, async (req, res, next) => {
  try {
    const { weight, height, bp_systolic, bp_diastolic, pulse,
            temperature, oxygen_saturation, blood_sugar, notes } = req.body;
    const bmi = (weight && height)
      ? parseFloat((weight / ((height / 100) ** 2)).toFixed(1))
      : null;
    const row = await db.getOne(
      `INSERT INTO patient_vitals
       (patient_id, recorded_by, weight, height, bmi, bp_systolic, bp_diastolic,
        pulse, temperature, oxygen_saturation, blood_sugar, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.params.id, req.user.id, weight||null, height||null, bmi,
       bp_systolic||null, bp_diastolic||null, pulse||null,
       temperature||null, oxygen_saturation||null, blood_sugar||null, notes||null]
    );
    res.status(201).json({ ...row, bmi });
  } catch (err) { next(err); }
});

// GET /api/patients/:id/vitals
router.get('/:id/vitals', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT pv.*, u.name AS recorded_by_name FROM patient_vitals pv
       LEFT JOIN users u ON pv.recorded_by = u.id
       WHERE pv.patient_id = $1 ORDER BY pv.recorded_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
