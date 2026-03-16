/**
 * Point d'entrée - Drive sécurisé (backend)
 * Connexion Postgres, routes /register, /login, /folders, /upload
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const auth = require('./auth');
const storage = require('./storage');

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
    const org_id = req.user.org_id || null;
    await pool.query(
      `INSERT INTO files (original_name, stored_name, size, uploaded_by, org_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, original_name, stored_name, size, uploaded_by, created_at`,
      [originalname, filename, size || 0, uploaded_by, org_id]
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
    const user = { id: req.user.id, email: req.user.email, role: req.user.role, org_id: req.user.org_id, organization: null };
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
    if (req.user.org_id) {
      return res.status(400).json({ error: 'Vous appartenez déjà à une organisation' });
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
      'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
      [org.id, 'PDG', req.user.id]
    );

    const jwt = require('jsonwebtoken');
    const newToken = jwt.sign(
      { userId: req.user.id, email: req.user.email, role: 'PDG', org_id: org.id },
      process.env.JWT_SECRET || 'secret_fallback',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      message: 'Organisation créée. Partagez ce code pour inviter des membres.',
      organization: { id: org.id, name: org.name, code: org.code },
      code: org.code,
      token: newToken,
    });
  } catch (err) {
    console.error('create organization error:', err);
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
    if (req.user.org_id) {
      return res.status(400).json({ error: 'Vous appartenez déjà à une organisation' });
    }
    const org = await pool.query('SELECT id, name FROM organizations WHERE code = $1', [codeStr]);
    if (org.rows.length === 0) {
      return res.status(400).json({ error: 'Code invalide' });
    }
    await pool.query(
      'UPDATE users SET org_id = $1, role = $2::user_role WHERE id = $3',
      [org.rows[0].id, 'COLLABORATEUR', req.user.id]
    );

    const jwt = require('jsonwebtoken');
    const newToken = jwt.sign(
      { userId: req.user.id, email: req.user.email, role: 'COLLABORATEUR', org_id: org.rows[0].id },
      process.env.JWT_SECRET || 'secret_fallback',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      message: 'Vous avez rejoint l\'organisation.',
      organization: { id: org.rows[0].id, name: org.rows[0].name },
      token: newToken,
    });
  } catch (err) {
    console.error('join organization error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ---- Routes protégées : dossiers ----
app.get('/folders', auth.requireAuth, async (req, res) => {
  try {
    if (req.user.org_id == null) {
      return res.json({ folders: [] });
    }
    const result = await pool.query(
      `SELECT id, name, type, owner_id, org_id FROM folders WHERE org_id = $1 ORDER BY name`,
      [req.user.org_id]
    );
    res.json({ folders: result.rows });
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
    const org_id = req.user.org_id;

    if (org_id == null) {
      return res.status(400).json({ error: 'Rejoignez ou créez une organisation pour créer des dossiers' });
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
      `INSERT INTO folders (name, type, folder_password_hash, owner_id, org_id)
       VALUES ($1, $2::folder_type, $3, $4, $5)
       RETURNING id, name, type, owner_id, org_id`,
      [name.trim(), type, folder_password_hash, owner_id, org_id]
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
      },
    });
  } catch (err) {
    console.error('createFolder error:', err);
    res.status(500).json({ error: 'Erreur lors de la création du dossier' });
  } finally {
    client.release();
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
      'SELECT id, folder_password_hash, org_id FROM folders WHERE id = $1',
      [folderId]
    );
    if (folder.rows.length === 0) {
      return res.status(404).json({ error: 'Dossier introuvable' });
    }
    const row = folder.rows[0];
    if (req.user.org_id !== row.org_id) {
      return res.status(403).json({ error: 'Accès refusé' });
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
    const deletedCond = trash ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL';
    let result;
    if (req.user.role === 'PDG' && req.user.org_id) {
      result = await pool.query(
        `SELECT f.id, f.original_name, f.stored_name, f.size, f.uploaded_by, f.org_id, f.folder_id, f.created_at, f.deleted_at
         FROM files f
         WHERE f.org_id = $1 AND ${deletedCond}
         ORDER BY f.created_at DESC`,
        [req.user.org_id]
      );
    } else {
      result = await pool.query(
        `SELECT id, original_name, stored_name, size, uploaded_by, org_id, folder_id, created_at, deleted_at
         FROM files WHERE uploaded_by = $1 AND ${deletedCond}
         ORDER BY created_at DESC`,
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
    let result;
    if (req.user.role === 'PDG' && req.user.org_id) {
      result = await pool.query(
        'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE org_id = $1 AND deleted_at IS NULL',
        [req.user.org_id]
      );
    } else {
      result = await pool.query(
        'SELECT COALESCE(SUM(size), 0)::BIGINT AS used FROM files WHERE uploaded_by = $1 AND deleted_at IS NULL',
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
      'SELECT id, uploaded_by FROM files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }
    const row = file.rows[0];
    const canDelete = row.uploaded_by === req.user.id || req.user.role === 'PDG';
    if (!canDelete) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
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
      'SELECT id, uploaded_by FROM files WHERE id = $1 AND deleted_at IS NOT NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable dans la corbeille' });
    }
    const row = file.rows[0];
    const canRestore = row.uploaded_by === req.user.id || req.user.role === 'PDG';
    if (!canRestore) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
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
      'SELECT id, stored_name, uploaded_by FROM files WHERE id = $1 AND deleted_at IS NOT NULL',
      [fileId]
    );
    if (file.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }
    const row = file.rows[0];
    const canDelete = row.uploaded_by === req.user.id || req.user.role === 'PDG';
    if (!canDelete) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }
    const filePath = path.join(storage.UPLOAD_DIR, row.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
    res.json({ message: 'Fichier supprimé définitivement' });
  } catch (err) {
    console.error('permanent delete error:', err);
    res.status(500).json({ error: 'Erreur' });
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
