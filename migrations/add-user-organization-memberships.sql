-- Multi-organisations : un utilisateur peut appartenir à plusieurs organisations.
-- Exécuter : psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql

CREATE TABLE IF NOT EXISTS user_organization_memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role user_role NOT NULL DEFAULT 'COLLABORATEUR',
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_uom_user ON user_organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_uom_org ON user_organization_memberships(org_id);

-- Rétrocompatibilité : copier org_id actuel des users vers la table de liaisons
INSERT INTO user_organization_memberships (user_id, org_id, role)
SELECT id, org_id, role FROM users WHERE org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;
