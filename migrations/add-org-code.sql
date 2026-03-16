-- Migration : ajouter le code à 4 chiffres aux organisations et rendre org_id optionnel
-- À exécuter si ta base a déjà été créée avec l'ancien init.sql :
--   psql -U postgres -d drive_db -f migrations/add-org-code.sql

-- Ajouter la colonne code (nullable d'abord pour remplir les lignes existantes)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS code CHAR(4);

-- Remplir un code unique pour les organisations existantes (1000, 1001, ...)
DO $$
DECLARE
  r RECORD;
  n INT := 1000;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE code IS NULL ORDER BY id
  LOOP
    UPDATE organizations SET code = LPAD((n)::text, 4, '0') WHERE id = r.id;
    n := n + 1;
  END LOOP;
END $$;

-- Rendre code obligatoire et unique
ALTER TABLE organizations ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_code ON organizations(code);

-- Rendre org_id optionnel pour les utilisateurs
ALTER TABLE users ALTER COLUMN org_id DROP NOT NULL;
