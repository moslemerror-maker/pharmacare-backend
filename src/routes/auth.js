const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../config/database');
const { generateToken, authenticate } = require('../middleware/auth');

// POST /api/auth/login — accepts username OR email via `login` or `email` field
router.post('/login', async (req, res, next) => {
  try {
    const { login: loginField, email: emailField, password } = req.body;
    const identifier = (loginField || emailField || '').trim();

    if (!identifier || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const user = await db.getOne(
      `SELECT u.*, r.name AS role_name, r.permissions
       FROM users u JOIN roles r ON u.role_id = r.id
       WHERE (LOWER(u.email) = LOWER($1) OR LOWER(u.username) = LOWER($1))
         AND u.is_active = true`,
      [identifier]
    );

    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid username or password' });

    let doctorProfile = null;
    if (user.role_name === 'doctor') {
      doctorProfile = await db.getOne(
        'SELECT * FROM doctor_profiles WHERE user_id = $1', [user.id]
      );
    }

    const token = generateToken(user);
    const { password_hash, ...safeUser } = user;

    res.json({
      token,
      user: { ...safeUser, permissions: user.permissions || {}, doctorProfile },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { password_hash, ...safeUser } = req.user;
    let doctorProfile = null;
    if (req.user.role_name === 'doctor') {
      doctorProfile = await db.getOne(
        'SELECT * FROM doctor_profiles WHERE user_id = $1', [req.user.id]
      );
    }
    res.json({ ...safeUser, doctorProfile });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await db.getOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(400).json({ error: 'Current password is incorrect' });

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
