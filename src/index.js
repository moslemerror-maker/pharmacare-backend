require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Startup DB migration (idempotent) ─────────────────────
;(async () => {
  try {
    const db = require('./config/database');
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uidx ON users (LOWER(username)) WHERE username IS NOT NULL`);
  } catch (e) {
    console.warn('[migration] username column:', e.message);
  }
})()

// ── Security & middleware ──────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    /\.vercel\.app$/,           // any Vercel preview URL
    'http://localhost:5173',
    'http://localhost:4173',
  ],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — 200 req / 15 min per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/patients',      require('./routes/patients'));
app.use('/api/medicines',     require('./routes/medicines'));
app.use('/api/inventory',     require('./routes/inventory'));
app.use('/api/suppliers',     require('./routes/suppliers'));
app.use('/api/purchases',     require('./routes/purchases'));
app.use('/api/sales',         require('./routes/sales'));
app.use('/api/prescriptions', require('./routes/prescriptions'));
app.use('/api/lab',           require('./routes/lab'));
app.use('/api/dashboard',     require('./routes/dashboard'));
app.use('/api/reports',       require('./routes/reports'));

// ── Health check ──────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', db: e.message });
  }
});

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}]`, err.stack || err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 PharmaCare API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
