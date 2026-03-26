/**
 * Point d'entrée - Drive sécurisé (backend)
 * Connexion Postgres, routes /register, /login, /folders, /upload
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const auth = require('./auth');
const storage = require('./storage');

const JWT_SECRET = process.env.JWT_SECRET || 'secret_fallback';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signUserToken(payload) {
  return jwt.sign(
    { userId: payload.userId, email: payload.email, role: payload.role, org_id: payload.org_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function dbRoleToApi(role) {
  if (role === 'PDG') return 'PDG';
  if (role === 'MANAGER') return 'ADMIN';
  return 'MEMBRE';
}

const app = express();
const PORT = process.env.PORT || 3000;

// Dossier public (fichiers statiques + index.html)
const publicDir = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route d'accueil : envoie public/index.html (avant static pour priorité sur GET /)
app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(500).send('Fichier public/index.html introuvable. Créez le dossier public et le fichier index.html.');
  }
  res.sendFile(indexPath);
});

// Fichiers statiques depuis le dossier public (CSS, JS, etc.)
app.use(express.static(publicDir));

// ---- Connexion à la base + dossier uploads au démarrage ----
async function connectDb() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    const uploadDir = storage.UPLOAD_DIR;
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log('Dossier uploads créé.');
    }
    console.log('Base de données connectée (drive_db).');
  } catch (err) {
    console.error('Impossible de se connecter à PostgreSQL:', err.message);
    process.exit(1);
  }
}

// ---- Routes publiques ----
app.post('/register', auth.register);
app.post('/login', auth.login);

// ---- Upload protégé : enregistre en /uploads + table files ----
app.post('/api/upload', auth.requireAuth, storage.upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier envoyé (attendu: champ "file")' });
    }
    const { originalname, filename, size } = req.file;
    const uploaded_by = req.user.id;
    let folder_id = null;
    let ownerSpace = null;
    let org_id = null;
    const requestedOwnerSpace = req.body && req.body.ownerSpace ? String(req.body.ownerSpace) : null;
    if (requestedOwnerSpace === 'personal' || requestedOwnerSpace === 'organization') {
      ownerSpace = requestedOwnerSpace;
    }
    if (req.body && req.body.folderId != null && String(req.body.folderId).trim() !== '') {
      const parsedFolderId = parseInt(String(req.body.folderId), 10);
      if (!parsedFolderId || Number.isNaN(parsedFolderId)) {
        return res.status(400).json({ error: 'folderId invalide' });
      }
      const folderCheck = await pool.query(
        'SELECT id, org_id, owner_id, owner_space FROM folders WHERE id = $1',
        [parsedFolderId]
      );
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Dossier introuvable' });
      }
      const f = folderCheck.rows[0];
      if (ownerSpace && ownerSpace !== f.owner_space) {
        return res.status(403).json({ error: 'Espace de destination invalide' });
      }
      ownerSpace = f.owner_space;
      org_id = ownerSpace === 'organization' ? f.org_id : null;
      const canUpload = (f.owner_space === 'organization' && req.user.org_id && f.org_id === req.user.org_id) || f.owner_id === req.user.id;
      if (!canUpload) return res.status(403).json({ error: 'Accès au dossier refusé' });
      folder_id = parsedFolderId;
    }
    if (!ownerSpace) {
      ownerSpace = req.user.org_id ? 'organization' : 'personal';
    }
    if (ownerSpace === 'organization' && org_id == null) {
      org_id = req.user.org_id || null;
    }
    await pool.query(
      `INSERT INTO files (original_name, stored_name, size, uploaded_by, org_id, folder_id, owner_space)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, original_name, stored_name, size, uploaded_by, created_at, owner_space`,
      [originalname, filename, size || 0, uploaded_by, org_id, folder_id, ownerSpace]
    );
    res.status(201).json({
      message: 'Fichier enregistré',
      file: { originalName: originalname, storedName: filename, size: size || 0 },
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'upload' });
  }
});

// ---- Routes protégées : profil et organisations ----
app.get('/me', auth.requireAuth, async (req, res) => {
  try {
    const user = { id: req.user.id, email: req.user.email, role: req.user.role, org_id: req.user.org_id, organization: null, organizations: [] };
    if (req.user.org_id) {
      const org = await pool.query(
        'SELECT id, name, code FROM organizations WHERE id = $1',
        [req.user.org_id]
      );
      if (org.rows.length > 0) {
        user.organization = { id: org.rows[0].id, name: org.rows[0].name };
        if (req.user.role === 'PDG') user.organization.code = org.rows[0].code;
      }
    }
    try {
      const om = await pool.query(
        `SELECT m.org_id AS id, m.role, o.name, o.code
         FROM user_organization_memberships m
         JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = $1
         ORDER BY o.name ASC`,
        [req.user.id]
      );
      user.organizations = om.rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.role === 'PDG' ? r.code : null,
        role: dbRoleToApi(r.role),
      }));
    } catch (e) {
      if (req.user.org_id && user.organization) {
        user.organizations = [
          {
            id: req.user.org_id,
            name: user.organization.name,
            code: user.organization.code || null,
            role: dbRoleToApi(req.user.role),
          },
        ];
      }
    }
    res.json({ user });
  } catch (err) {
    console.error('get me error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

app.post('/organizations', auth.requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Le nom de l\'organisation est requis' });
    }
    let code;
    let attempts = 0;
    do {
      code = generateCode();
      const existing = await client.query('SELECT 1 FROM organizations WHERE code = $1', [code]);
      if (existing.rows.length === 0) break;
      attempts++;
      if (attempts > 20) return res.status(500).json({ error: 'Impossible de générer un code unique' });
    } while (true);

    const insert = await client.query(
      'INSERT INTO organizations (name, code) VALUES ($1, $2) RETURNING id, name, code',
      [name.trim(), code]
    );
    const org = insert.rows[0];
    await client.query(
      `INSERT INTO user_organization_memberships (user_id, org_id, role)
       VALUES ($1, $2, 'PDG'::user_role)
       ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'PDG'::user_role`,
      [req.user.id, org.id]
    );
    await client.query(
      'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
      [org.id, 'PDG', req.user.id]
    );

    const newToken = signUserToken({
      userId: req.user.id,
      email: req.user.email,
      role: 'PDG',
      org_id: org.id,
    });

    res.status(201).json({
      message: 'Organisation créée. Partagez ce code pour inviter des membres.',
      organization: { id: org.id, name: org.name, code: org.code },
      code: org.code,
      token: newToken,
    });
  } catch (err) {
    console.error('create organization error:', err);
    const msg = err.message || '';
    if (msg.includes('user_organization_memberships')) {
      return res.status(500).json({
        error: 'Exécutez la migration : psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql',
      });
    }
    res.status(500).json({ error: 'Erreur lors de la création' });
  } finally {
    client.release();
  }
});

app.post('/organizations/join', auth.requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const codeStr = code != null ? String(code).trim().replace(/\D/g, '').slice(0, 4) : '';
    if (codeStr.length !== 4) {
      return res.status(400).json({ error: 'Le code doit faire 4 chiffres' });
    }
    const org = await pool.query('SELECT id, name, code FROM organizations WHERE code = $1', [codeStr]);
    if (org.rows.length === 0) {
      return res.status(400).json({ error: 'Code invalide' });
    }
    const orgRow = org.rows[0];
    const dup = await pool.query(
      'SELECT 1 FROM user_organization_memberships WHERE user_id = $1 AND org_id = $2',
      [req.user.id, orgRow.id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Vous êtes déjà membre de cette organisation' });
    }
    await pool.query(
      `INSERT INTO user_organization_memberships (user_id, org_id, role)
       VALUES ($1, $2, 'COLLABORATEUR'::user_role)`,
      [req.user.id, orgRow.id]
    );

    const userRow = await pool.query('SELECT org_id FROM users WHERE id = $1', [req.user.id]);
    const hadOrg = userRow.rows[0] && userRow.rows[0].org_id != null;

    if (!hadOrg) {
      await pool.query(
        'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
        [orgRow.id, 'COLLABORATEUR', req.user.id]
      );
      const newToken = signUserToken({
        userId: req.user.id,
        email: req.user.email,
        role: 'COLLABORATEUR',
        org_id: orgRow.id,
      });
      return res.json({
        message: 'Vous avez rejoint l\'organisation.',
        organization: { id: orgRow.id, name: orgRow.name, code: orgRow.code },
        token: newToken,
      });
    }

    res.json({
      message: 'Vous avez rejoint l\'organisation.',
      organization: { id: orgRow.id, name: orgRow.name, code: orgRow.code },
    });
  } catch (err) {
    console.error('join organization error:', err);
    const msg = err.message || '';
    if (msg.includes('user_organization_memberships')) {
      return res.status(500).json({
        error: 'Exécutez la migration : psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql',
      });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/** Bascule l’organisation active (JWT + users.org_id) vers une org dont l’utilisateur est membre */
app.post('/organizations/switch', auth.requireAuth, async (req, res) => {
  try {
    const raw = req.body && req.body.orgId;
    const orgId = raw != null ? parseInt(String(raw), 10) : NaN;
    if (!orgId || Number.isNaN(orgId)) {
      return res.status(400).json({ error: 'orgId invalide' });
    }
    const m = await pool.query(
      `SELECT m.org_id, m.role, o.name, o.code
       FROM user_organization_memberships m
       JOIN organizations o ON o.id = m.org_id
       WHERE m.user_id = $1 AND m.org_id = $2`,
      [req.user.id, orgId]
    );
    if (m.rows.length === 0) {
      return res.status(403).json({ error: 'Vous n\'êtes pas membre de cette organisation' });
    }
    const row = m.rows[0];
    await pool.query(
      'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
      [row.org_id, row.role, req.user.id]
    );
    const newToken = signUserToken({
      userId: req.user.id,
      email: req.user.email,
      role: row.role,
      org_id: row.org_id,
    });
    res.json({
      token: newToken,
      organization: {
        id: row.org_id,
        name: row.name,
        code: row.role === 'PDG' ? row.code : undefined,
      },
      role: dbRoleToApi(row.role),
    });
  } catch (err) {
    console.error('switch organization error:', err);
    const msg = err.message || '';
    if (msg.includes('user_organization_memberships')) {
      return res.status(500).json({
        error: 'Exécutez la migration : psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql',
      });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/** Quitter une organisation (supprime l'adhésion courante de l'utilisateur) */
app.post('/organizations/leave', auth.requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const raw = req.body && req.body.orgId;
    const orgId = raw != null ? parseInt(String(raw), 10) : NaN;
    if (!orgId || Number.isNaN(orgId)) {
      return res.status(400).json({ error: 'orgId invalide' });
    }

    await client.query('BEGIN');
    const del = await client.query(
      'DELETE FROM user_organization_memberships WHERE user_id = $1 AND org_id = $2 RETURNING org_id',
      [req.user.id, orgId]
    );
    if (del.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vous n\'êtes pas membre de cette organisation' });
    }

    let newToken = null;
    let activeOrganization = null;
    const leavingActiveOrg = String(req.user.org_id || '') === String(orgId);

    if (leavingActiveOrg) {
      const next = await client.query(
        `SELECT m.org_id, m.role, o.name, o.code
         FROM user_organization_memberships m
         JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = $1
         ORDER BY o.name ASC
         LIMIT 1`,
        [req.user.id]
      );

      if (next.rows.length > 0) {
        const row = next.rows[0];
        await client.query(
          'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
          [row.org_id, row.role, req.user.id]
        );
        newToken = signUserToken({
          userId: req.user.id,
          email: req.user.email,
          role: row.role,
          org_id: row.org_id,
        });
        activeOrganization = {
          id: row.org_id,
          name: row.name,
          code: row.role === 'PDG' ? row.code : undefined,
        };
      } else {
        await client.query(
          'UPDATE users SET org_id = NULL, role = $1::user_role WHERE id = $2',
          ['COLLABORATEUR', req.user.id]
        );
        newToken = signUserToken({
          userId: req.user.id,
          email: req.user.email,
          role: 'COLLABORATEUR',
          org_id: null,
        });
      }
    }

    await client.query('COMMIT');
    res.json({
      message: 'Organisation quittée.',
      token: newToken,
      activeOrganization,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('leave organization error:', err);
    const msg = err.message || '';
    if (msg.includes('user_organization_memberships')) {
      return res.status(500).json({
        error: 'Exécutez la migration : psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql',
      });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// ---- Routes protégées : dossiers ----
app.get('/folders', auth.requireAuth, async (req, res) => {
  try {
    const scope = req.query && req.query.scope ? String(req.query.scope) : 'org';
    if (scope === 'personal') {
      const result = await pool.query(
        `SELECT id, name, type, owner_id, org_id, owner_space
         FROM folders
         WHERE owner_id = $1 AND owner_space = 'personal'
         ORDER BY name`,
        [req.user.id]
      );
      return res.json({ folders: result.rows });
    }

    if (req.user.org_id == null) return res.json({ folders: [] });
    const result = await pool.query(
      `SELECT id, name, type, owner_id, org_id, owner_space
       FROM folders
       WHERE org_id = $1 AND owner_space = 'organization'
       ORDER BY name`,
      [req.user.org_id]
    );
    return res.json({ folders: result.rows });
  } catch (err) {
    console.error('list folders error:', err);
    res.status(500).json({ error: 'Erreur lors du listage des dossiers' });
  }
});

// Body: { name, type: 'normal'|'shared'|'confidential', folderPassword? (obligatoire si type = confidential) }
app.post('/folders', auth.requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, type = 'normal', folderPassword } = req.body;
    const owner_id = req.user.id;
    const requestedOwnerSpace = req.body && req.body.ownerSpace ? String(req.body.ownerSpace) : null;
    const ownerSpace =
      requestedOwnerSpace === 'personal'
        ? 'personal'
        : requestedOwnerSpace === 'organization'
          ? 'organization'
          : req.user.org_id
            ? 'organization'
            : 'personal';
    const org_id = ownerSpace === 'organization' ? req.user.org_id : null;

    if (ownerSpace === 'organization' && org_id == null) {
      return res.status(400).json({ error: "Rejoignez ou créez une organisation pour créer des dossiers d'organisation" });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Le nom du dossier est requis' });
    }

    const allowed = ['normal', 'shared', 'confidential'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ error: 'Type invalide. Valeurs : normal, shared, confidential' });
    }

    let folder_password_hash = null;
    if (type === 'confidential') {
      if (!folderPassword) {
        return res.status(400).json({ error: 'Un mot de passe est requis pour un dossier confidentiel' });
      }
      const salt = await bcrypt.genSalt(12);
      folder_password_hash = await bcrypt.hash(folderPassword, salt);
    }

    const result = await client.query(
      `INSERT INTO folders (name, type, folder_password_hash, owner_id, org_id, owner_space)
       VALUES ($1, $2::folder_type, $3, $4, $5, $6)
       RETURNING id, name, type, owner_id, org_id, owner_space`,
      [name.trim(), type, folder_password_hash, owner_id, org_id, ownerSpace]
    );

    const folder = result.rows[0];
    res.status(201).json({
      message: 'Dossier créé',
      folder: {
        id: folder.id,
        name: folder.name,
        type: folder.type,
        owner_id: folder.owner_id,
        org_id: folder.org_id,
        owner_space: folder.owner_space,
      },
    });
  } catch (err) {
    console.error('createFolder error:', err);
    res.status(500).json({ error: 'Erreur lors de la création du dossier' });
  } finally {
    client.release();
  }
});

app.delete('/folders/:id', auth.requireAuth, async (req, res) => {
  try {
    const folderId = parseInt(String(req.params.id), 10);
    if (!folderId || Number.isNaN(folderId)) {
      return res.status(400).json({ error: 'ID de dossier invalide' });
    }

    const folder = await pool.query(
      'SELECT id, owner_id, org_id, owner_space FROM folders WHERE id = $1',
      [folderId]
    );
    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Dossier introuvable' });
    }
    const row = folder.rows[0];
    if (row.owner_space === 'personal') {
      if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'Accès refusé' });
    } else {
      if (req.user.org_id == null || row.org_id !== req.user.org_id) return res.status(403).json({ error: 'Accès refusé' });
      const canDelete = row.owner_id === req.user.id || req.user.role === 'PDG';
      if (!canDelete) return res.status(403).json({ error: 'Droits insuffisants' });
    }

    await pool.query('DELETE FROM folders WHERE id = $1', [folderId]);
    res.json({ message: 'Dossier supprimé' });
  } catch (err) {
    console.error('delete folder error:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression du dossier' });
  }
});

// Vérifier mot de passe d'un dossier confidentiel
app.post('/api/folders/:id/unlock', auth.requireAuth, async (req, res) => {
  try {
    const folderId = req.params.id;
    const { folderPassword } = req.body;
    if (!folderPassword) {
      return res.status(400).json({ error: 'Mot de passe requis' });
    }
    const folder = await pool.query(
      'SELECT id, folder_password_hash, org_id, owner_id, owner_space FROM folders WHERE id = $1',
      [folderId]
    );
    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Dossier introuvable' });
    }
    const row = folder.rows[0];
    if (row.owner_space === 'personal') {
      if (req.user.id !== row.owner_id) return res.status(403).json({ error: 'Accès refusé' });
    } else {
      if (req.user.org_id !== row.org_id) return res.status(403).json({ error: 'Accès refusé' });
    }
    if (!row.folder_password_hash) {
      return res.json({ unlocked: true });
    }
    const valid = await bcrypt.compare(folderPassword, row.folder_password_hash);
    if (!valid) {
      return res.status(403).json({ error: 'Mot de passe incorrect' });
    }
    res.json({ unlocked: true });
  } catch (err) {
    console.error('unlock error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Liste des fichiers (trash=0 par défaut = actifs, trash=1 = corbeille)
app.get('/api/files', auth.requireAuth, async (req, res) => {
  try {
    const trash = req.query.trash === '1';
    const scope = req.query && req.query.scope ? String(req.query.scope) : null;
    const deletedCond = trash ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL';
    let result;
    if (scope === 'personal') {
      result = await pool.query(
        `SELECT f.id, f.original_name, f.stored_name, f.size, f.uploaded_by, f.org_id, f.folder_id, f.owner_space, f.created_at, f.deleted_at
         FROM files f
         WHERE f.owner_space = 'personal' AND f.uploaded_by = $1 AND ${deletedCond}
         ORDER BY f.created_at DESC`,
        [req.user.id]
      );
    } else if (scope === 'org') {
      if (!req.user.org_id) result = { rows: [] };
      else {
        result = await pool.query(
          `SELECT f.id, f.original_name, f.stored_name, f.size, f.uploaded_by, f.org_id, f.folder_id, f.owner_space, f.created_at, f.deleted_at
           FROM files f
           WHERE f.owner_space = 'organization' AND f.org_id = $1 AND ${deletedCond}
           ORDER BY f.created_at DESC`,
          [req.user.org_id]
        );
      }
    } else if (req.user.role === 'PDG' && req.user.org_id) {
      result = await pool.query(
        `SELECT f.id, f.original_name, f.stored_name, f.size, f.uploaded_by, f.org_id, f.folder_id, f.owner_space, f.created_at, f.deleted_at
         FROM files f
         WHERE f.org_id = $1 AND ${deletedCond}
         ORDER BY f.created_at DESC`,
        [req.user.org_id]
      );
    } else {
      result = await pool.query(
        `SELECT f.id, f.original_name, f.stored_name, f.size, f.uploaded_by, f.org_id, f.folder_id, f.owner_space, f.created_at, f.deleted_at
         FROM files f
         WHERE f.uploaded_by = $1 AND ${deletedCond}
         ORDER BY f.created_at DESC`,
        [req.user.id]
      );
    }
    res.json({ files: result.rows });
  } catch (err) {
    console.error('list files error:', err);
    res.status(500).json({ error: 'Erreur lors du listage des fichiers' });
  }
});

// Espace de stockage utilisé (hors corbeille), limite 15 Go
app.get('/api/storage', auth.requireAuth, async (req, res) => {
  try {
    const limitBytes = 15 * 1024 * 1024 * 1024; // 15 Go
    const scope = req.query && req.query.scope ? String(req.query.scope) : null;
    let result;
    if (scope === 'all') {
      const orgs = await pool.query(
        'SELECT org_id FROM user_organization_memberships WHERE user_id = $1',
        [req.user.id]
      );
      const orgIds = orgs.rows.map((r) => r.org_id);
      const safeOrgIds = orgIds.length ? orgIds : [-1];
      result = await pool.query(
        `SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files
         WHERE deleted_at IS NULL
         AND (
           (owner_space = 'personal' AND uploaded_by = $1)
           OR (owner_space = 'organization' AND org_id = ANY($2::int[]))
         )`,
        [req.user.id, safeOrgIds]
      );
    } else if (scope === 'personal') {
      result = await pool.query(
        'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE owner_space = \'personal\' AND uploaded_by = $1 AND deleted_at IS NULL',
        [req.user.id]
      );
    } else if (scope === 'org') {
      if (!req.user.org_id) result = { rows: [{ used: 0 }] };
      else {
        result = await pool.query(
          'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE owner_space = \'organization\' AND org_id = $1 AND deleted_at IS NULL',
          [req.user.org_id]
        );
      }
    } else if (req.user.role === 'PDG' && req.user.org_id) {
      result = await pool.query(
        'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE owner_space = \'organization\' AND org_id = $1 AND deleted_at IS NULL',
        [req.user.org_id]
      );
    } else {
      result = await pool.query(
        'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE owner_space = \'personal\' AND uploaded_by = $1 AND deleted_at IS NULL',
        [req.user.id]
      );
    }
    const usedBytes = Number(result.rows[0].used) || 0;
    res.json({
      usedBytes,
      limitBytes,
      usedFormatted: formatStorageSize(usedBytes),
      limitFormatted: '15 Go',
    });
  } catch (err) {
    console.error('storage error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

function formatStorageSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' Go';
}

// Déplacer vers la corbeille (soft delete)
app.delete('/api/files/:id', auth.requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await pool.query(
      'SELECT id, uploaded_by, org_id, owner_space FROM files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }
    const row = file.rows[0];
    let canDelete = false;
    if (row.owner_space === 'personal') {
      canDelete = row.uploaded_by === req.user.id;
    } else {
      canDelete =
        !!req.user.org_id &&
        String(row.org_id) === String(req.user.org_id) &&
        (row.uploaded_by === req.user.id || req.user.role === 'PDG');
    }
    if (!canDelete) return res.status(403).json({ error: 'Droits insuffisants' });
    await pool.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);
    res.json({ message: 'Fichier déplacé dans la corbeille' });
  } catch (err) {
    console.error('delete file error:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// Restaurer depuis la corbeille
app.post('/api/files/:id/restore', auth.requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await pool.query(
      'SELECT id, uploaded_by, org_id, owner_space FROM files WHERE id = $1 AND deleted_at IS NOT NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable dans la corbeille' });
    }
    const row = file.rows[0];
    let canRestore = false;
    if (row.owner_space === 'personal') {
      canRestore = row.uploaded_by === req.user.id;
    } else {
      canRestore =
        !!req.user.org_id &&
        String(row.org_id) === String(req.user.org_id) &&
        (row.uploaded_by === req.user.id || req.user.role === 'PDG');
    }
    if (!canRestore) return res.status(403).json({ error: 'Droits insuffisants' });
    await pool.query('UPDATE files SET deleted_at = NULL WHERE id = $1', [fileId]);
    res.json({ message: 'Fichier restauré' });
  } catch (err) {
    console.error('restore error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Supprimer définitivement (depuis la corbeille)
app.delete('/api/files/:id/permanent', auth.requireAuth, async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await pool.query(
      'SELECT id, stored_name, uploaded_by, org_id, owner_space FROM files WHERE id = $1 AND deleted_at IS NOT NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }
    const row = file.rows[0];
    let canDelete = false;
    if (row.owner_space === 'personal') {
      canDelete = row.uploaded_by === req.user.id;
    } else {
      canDelete =
        !!req.user.org_id &&
        String(row.org_id) === String(req.user.org_id) &&
        (row.uploaded_by === req.user.id || req.user.role === 'PDG');
    }
    if (!canDelete) return res.status(403).json({ error: 'Droits insuffisants' });
    const filePath = path.join(storage.UPLOAD_DIR, row.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
    res.json({ message: 'Fichier supprimé définitivement' });
  } catch (err) {
    console.error('permanent delete error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Vider la corbeille (suppression définitive) pour un scope
app.delete('/api/files/trash/empty', auth.requireAuth, async (req, res) => {
  try {
    const scope = req.query && req.query.scope ? String(req.query.scope) : 'personal';
    let toDeleteSql = '';
    let delSql = '';
    let params = [];

    if (scope === 'all') {
      const orgs = await pool.query(
        'SELECT org_id FROM user_organization_memberships WHERE user_id = $1',
        [req.user.id]
      );
      const orgIds = orgs.rows.map((r) => r.org_id);
      // Si pas d'orga, on force une valeur qui ne matche rien
      const safeOrgIds = orgIds.length ? orgIds : [-1];

      toDeleteSql = `
        SELECT stored_name
        FROM files
        WHERE deleted_at IS NOT NULL
          AND (
            (owner_space = 'personal' AND uploaded_by = $1)
            OR
            (owner_space = 'organization' AND org_id = ANY($2::int[]))
          )
      `;
      delSql = toDeleteSql.replace('SELECT stored_name', 'DELETE FROM files RETURNING 1').replace('FROM files', ''); // placeholder; not used

      // On exécute séparément le DELETE avec la même condition pour récupérer rowCount
      const toDelete = await pool.query(toDeleteSql, [req.user.id, safeOrgIds]);
      for (const row of toDelete.rows) {
        const filePath = path.join(storage.UPLOAD_DIR, row.stored_name);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          // on continue : l'important est de supprimer la ligne DB
        }
      }

      const del = await pool.query(
        `
        DELETE FROM files
        WHERE deleted_at IS NOT NULL
          AND (
            (owner_space = 'personal' AND uploaded_by = $1)
            OR
            (owner_space = 'organization' AND org_id = ANY($2::int[]))
          )
        `,
        [req.user.id, safeOrgIds]
      );

      res.json({ deleted: del.rowCount || 0 });
      return;
    }

    if (scope === 'personal') {
      toDeleteSql = `
        SELECT stored_name FROM files
        WHERE owner_space = 'personal' AND uploaded_by = $1 AND deleted_at IS NOT NULL
      `;
      delSql = `
        DELETE FROM files
        WHERE owner_space = 'personal' AND uploaded_by = $1 AND deleted_at IS NOT NULL
      `;
      params = [req.user.id];
    } else {
      if (!req.user.org_id) return res.json({ deleted: 0 });
      toDeleteSql = `
        SELECT stored_name FROM files
        WHERE owner_space = 'organization' AND org_id = $1 AND deleted_at IS NOT NULL
      `;
      delSql = `
        DELETE FROM files
        WHERE owner_space = 'organization' AND org_id = $1 AND deleted_at IS NOT NULL
      `;
      params = [req.user.org_id];
    }

    const toDelete = await pool.query(toDeleteSql, params);
    for (const row of toDelete.rows) {
      const filePath = path.join(storage.UPLOAD_DIR, row.stored_name);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        // on continue : l'important est de supprimer la ligne DB
      }
    }

    const del = await pool.query(delSql, params);
    res.json({ deleted: del.rowCount || 0 });
  } catch (err) {
    console.error('empty trash error:', err);
    res.status(500).json({ error: 'Erreur lors du vidage de la corbeille' });
  }
});

// Déplacer un fichier vers un dossier (même owner_space)
app.post('/api/files/:id/move', auth.requireAuth, async (req, res) => {
  try {
    const fileId = parseInt(String(req.params.id), 10);
    if (!fileId || Number.isNaN(fileId)) return res.status(400).json({ error: 'ID invalide' });

    const rawFolderId = req.body && req.body.folderId != null ? req.body.folderId : null;
    const folderId = rawFolderId === '' || rawFolderId == null ? null : parseInt(String(rawFolderId), 10);
    if (rawFolderId !== null && folderId != null && Number.isNaN(folderId)) return res.status(400).json({ error: 'folderId invalide' });

    const file = await pool.query(
      `SELECT id, uploaded_by, org_id, owner_space
       FROM files
       WHERE id = $1 AND deleted_at IS NULL`,
      [fileId]
    );
    if (file.rows.length === 0) return res.status(404).json({ error: 'Fichier introuvable' });
    const f = file.rows[0];

    let canMove = false;
    if (f.owner_space === 'personal') {
      canMove = String(f.uploaded_by) === String(req.user.id);
    } else {
      canMove =
        !!req.user.org_id &&
        String(f.org_id) === String(req.user.org_id) &&
        (String(f.uploaded_by) === String(req.user.id) || req.user.role === 'PDG');
    }
    if (!canMove) return res.status(403).json({ error: 'Droits insuffisants' });

    let destOwnerSpace = f.owner_space;
    let destFolder = null;
    if (folderId) {
      const folder = await pool.query(
        `SELECT id, owner_space, org_id, owner_id
         FROM folders
         WHERE id = $1`,
        [folderId]
      );
      if (folder.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable' });
      destFolder = folder.rows[0];
      destOwnerSpace = destFolder.owner_space;

      if (destOwnerSpace !== f.owner_space) {
        return res.status(403).json({ error: 'Déplacement entre espaces interdit' });
      }

      if (destOwnerSpace === 'personal') {
        if (String(destFolder.owner_id) !== String(req.user.id)) return res.status(403).json({ error: 'Accès refusé' });
      } else {
        if (!req.user.org_id || String(destFolder.org_id) !== String(req.user.org_id)) return res.status(403).json({ error: 'Accès refusé' });
      }
    }

    if (String(f.folder_id || '') === String(folderId || '')) {
      return res.json({ message: 'Aucun changement' });
    }

    await pool.query(
      'UPDATE files SET folder_id = $1 WHERE id = $2',
      [folderId, fileId]
    );

    res.json({ message: 'Fichier déplacé' });
  } catch (err) {
    console.error('move error:', err);
    res.status(500).json({ error: 'Erreur lors du déplacement' });
  }
});

// Télécharger un fichier (propriétaire ou PDG) — accepte Authorization ou ?token= pour lien direct
app.get('/api/files/:id/download', (req, res, next) => {
  const q = req.query.token;
  if (q && !req.headers.authorization) req.headers.authorization = 'Bearer ' + q;
  next();
}, auth.requireAuth, async (req, res) => {
  try {
    const file = await pool.query(
      'SELECT id, original_name, stored_name, uploaded_by FROM files WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (file.rows.length === 0) return res.status(404).json({ error: 'Fichier introuvable' });
    const row = file.rows[0];
    if (row.uploaded_by !== req.user.id && req.user.role !== 'PDG') {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
    const filePath = path.join(storage.UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier absent du serveur' });
    res.download(filePath, row.original_name);
  } catch (err) {
    console.error('download error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'drive-secure-api' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// Démarrage : connexion DB puis écoute
connectDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Serveur sur http://localhost:${PORT}`);
    console.log(`Environnement: ${process.env.NODE_ENV || 'development'}`);
  });
});

module.exports = app;
