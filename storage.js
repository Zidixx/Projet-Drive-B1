/**
 * Configuration Multer : uploads dans le dossier ./uploads
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_PATH || './uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '';
    cb(null, unique + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 Mo
});

module.exports = {
  upload,
  UPLOAD_DIR,
};
