const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

// GET /api/users
router.get('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT u.id, u.uuid, u.name, u.username, u.email, u.phone, u.is_active, u.created_at,
              r.name AS role_name
       FROM users u JOIN roles r ON u.role_id = r.id
       ORDER BY r.name, u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/users/roles — only the 3 roles exposed in UI
router.get('/roles', authenticate, async (req, res, next) => {
  try {
    const rows = await db.getAll(
      `SELECT id, name FROM roles WHERE name IN ('admin','doctor','pharmacist') ORDER BY name`
    );
    res.json(rows);
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
    const {
      name, username, email, phone, password, role_name,
      specialization, registration_number, qualification,
      clinic_name, clinic_address, clinic_phone,
    } = req.body;

    if (!name || !username || !password || !role_name)
      return res.status(400).json({ error: 'name, username, password, role_name are required' });

    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    if (!['admin', 'doctor', 'pharmacist'].includes(role_name))
      return res.status(400).json({ error: 'Role must be admin, doctor, or pharmacist' });

    const role = await db.getOne('SELECT * FROM roles WHERE name = $1', [role_name]);
    if (!role) return res.status(400).json({ error: 'Invalid role' });

    // Check username uniqueness
    const existingUsername = await db.getOne(
      'SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]
    );
    if (existingUsername) return res.status(409).json({ error: 'Username already taken' });

    // Check email uniqueness only when provided
    const cleanEmail = email?.trim() || null;
    if (cleanEmail) {
      const existingEmail = await db.getOne(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]
      );
      if (existingEmail) return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const user = await db.getOne(
      `INSERT INTO users (name, username, email, phone, password_hash, role_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, username, email`,
      [name.trim(), username.trim().toLowerCase(), cleanEmail, phone?.trim() || null, hash, role.id]
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

    res.status(201).json({ message: 'User created', id: user.id, username: user.username });
  } catch (err) { next(err); }
});

// PUT /api/users/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { name, phone, username, is_active } = req.body;
    await db.run(
      'UPDATE users SET name=$1, phone=$2, username=$3, is_active=$4, updated_at=NOW() WHERE id=$5',
      [name, phone, username || null, is_active, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/doctor-profile
router.put('/:id/doctor-profile', authenticate, authorize('admin', 'doctor'), async (req, res, next) => {
  try {
    const {
      specialization, registration_number, qualification,
      clinic_name, clinic_address, clinic_phone, consultation_fee,
    } = req.body;
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
