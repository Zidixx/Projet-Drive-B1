-- Corbeille : soft delete pour les fichiers
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at);
