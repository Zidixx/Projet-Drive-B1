-- Owner space separation (personal vs organization)
-- Executer : psql -U postgres -d drive_db -f migrations/add-owner-space-columns.sql

BEGIN;

-- Files
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS owner_space VARCHAR(20) NOT NULL DEFAULT 'personal';

UPDATE files
SET owner_space = CASE
  WHEN org_id IS NULL THEN 'personal'
  ELSE 'organization'
END
WHERE owner_space IS NULL OR owner_space = 'personal';

-- Folders
ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS owner_space VARCHAR(20) NOT NULL DEFAULT 'organization';

-- Rendre org_id optionnel pour les dossiers perso
ALTER TABLE folders
  ALTER COLUMN org_id DROP NOT NULL;

UPDATE folders
SET owner_space = 'organization'
WHERE org_id IS NOT NULL;

-- Index
CREATE INDEX IF NOT EXISTS idx_files_owner_space ON files(owner_space);
CREATE INDEX IF NOT EXISTS idx_folders_owner_space ON folders(owner_space);

COMMIT;

