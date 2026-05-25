const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/users
router.get('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT u.id, u.uuid, u.name, u.email, u.phone, u.is_active, u.created_at,
              r.name AS role_name
       FROM users u JOIN roles r ON u.role_id = r.id
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/users/roles
router.get('/roles', authenticate, async (req, res, next) => {
  try {
    res.json(await db.getAll('SELECT id, name FROM roles ORDER BY name'));
  } catch (err) { next(err); }
});

// GET /api/users/doctors — for prescription dropdown
router.get('/doctors', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT u.id, u.name, u.email, u.phone,
              dp.specialization, dp.registration_number, dp.qualification,
              dp.clinic_name, dp.clinic_address, dp.clinic_phone
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN doctor_profiles dp ON dp.user_id = u.id
       WHERE r.name = 'doctor' AND u.is_active = true
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/users
router.post('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { name, email, phone, password, role_name,
            specialization, registration_number, qualification,
            clinic_name, clinic_address, clinic_phone } = req.body;

    if (!name || !email || !password || !role_name)
      return res.status(400).json({ error: 'name, email, password, role_name required' });

    const role = await db.getOne('SELECT * FROM roles WHERE name = $1', [role_name]);
    if (!role) return res.status(400).json({ error: 'Invalid role' });

    const existing = await db.getOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const hash = bcrypt.hashSync(password, 10);
    const user = await db.getOne(
      `INSERT INTO users (name, email, phone, password_hash, role_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email`,
      [name, email, phone, hash, role.id]
    );

    if (role_name === 'doctor') {
      await db.run(
        `INSERT INTO doctor_profiles
         (user_id, registration_number, specialization, qualification, clinic_name, clinic_address, clinic_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.id, registration_number, specialization, qualification,
         clinic_name, clinic_address, clinic_phone]
      );
    }
    res.status(201).json({ message: 'User created', id: user.id });
  } catch (err) { next(err); }
});

// PUT /api/users/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { name, phone, is_active } = req.body;
    await db.run(
      'UPDATE users SET name=$1, phone=$2, is_active=$3, updated_at=NOW() WHERE id=$4',
      [name, phone, is_active, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/doctor-profile
router.put('/:id/doctor-profile', authenticate, authorize('admin', 'doctor'), async (req, res, next) => {
  try {
    const { specialization, registration_number, qualification,
            clinic_name, clinic_address, clinic_phone, consultation_fee } = req.body;
    await db.run(
      `UPDATE doctor_profiles
       SET specialization=$1, registration_number=$2, qualification=$3,
           clinic_name=$4, clinic_address=$5, clinic_phone=$6, consultation_fee=$7
       WHERE user_id=$8`,
      [specialization, registration_number, qualification,
       clinic_name, clinic_address, clinic_phone, consultation_fee, req.params.id]
    );
    res.json({ message: 'Doctor profile updated' });
  } catch (err) { next(err); }
});

module.exports = router;
