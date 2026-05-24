const jwt = require('jsonwebtoken');
const db  = require('../config/database');

const SECRET = process.env.JWT_SECRET || 'pharmacare-dev-secret';

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    const user = await db.getOne(
      `SELECT u.*, r.name AS role_name, r.permissions
       FROM users u JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1 AND u.is_active = true`,
      [decoded.id]
    );
    if (!user) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = { ...user, permissions: user.permissions || {} };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Role guard — admin (all:true) always passes
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.permissions?.all) return next();
  if (roles.length && !roles.includes(req.user.role_name)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

const generateToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role_name },
    SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '12h' }
  );

module.exports = { authenticate, authorize, generateToken };
