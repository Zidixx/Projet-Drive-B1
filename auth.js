/**
 * Authentification : inscription (code org optionnel), connexion (bcrypt + JWT)
 * + Middleware de sécurisation des routes
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'secret_fallback';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const ROLES = ['PDG', 'MANAGER', 'COLLABORATEUR'];

/**
 * Inscription - POST /register
 * Body: { email, password, code? } — code = code à 4 chiffres (optionnel)
 */
async function register(req, res) {
  const client = await pool.connect();
  try {
    const { email, password, code } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
    }

    let org_id = null;
    let role = 'COLLABORATEUR';

    if (code != null && String(code).trim() !== '') {
      const codeStr = String(code).trim().replace(/\D/g, '').slice(0, 4);
      if (codeStr.length !== 4) {
        return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
      }
      const org = await client.query('SELECT id FROM organizations WHERE code = $1', [codeStr]);
      if (org.rows.length === 0) {
        return res.status(400).json({ error: 'Code d\'organisation invalide' });
      }
      org_id = org.rows[0].id;
    }

    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await client.query(
      `INSERT INTO users (email, password_hash, role, org_id)
       VALUES ($1, $2, $3::user_role, $4)
       RETURNING id, email, role, org_id`,
      [email.toLowerCase(), password_hash, role, org_id]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, org_id: user.org_id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      message: 'Inscription réussie',
      user: { id: user.id, email: user.email, role: user.role, org_id: user.org_id },
      token,
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (err) {
    console.error('Register error:', err);
    const msg = err.message || '';
    if (msg.includes('org_id') && (msg.includes('null') || msg.includes('NOT NULL'))) {
      return res.status(500).json({
        error: 'La base de données doit être mise à jour. Exécutez : psql -U postgres -d drive_db -f migrations/add-org-code.sql',
      });
    }
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription' });
  } finally {
    client.release();
  }
}

/**
 * Connexion - POST /login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, role, org_id FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, org_id: user.org_id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Connexion réussie',
      user: { id: user.id, email: user.email, role: user.role, org_id: user.org_id },
      token,
      expiresIn: JWT_EXPIRES_IN,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion' });
  }
}

/**
 * Middleware : vérifie le JWT et attache req.user
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant ou invalide' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.userId,
      email: payload.email,
      role: payload.role,
      org_id: payload.org_id,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token expiré ou invalide' });
  }
}

module.exports = {
  register,
  login,
  requireAuth,
  ROLES,
};
