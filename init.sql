-- ============================================
-- Script d'initialisation - Drive sécurisé (drive_db)
-- Exécuter : psql -U postgres -d drive_db -f init.sql
-- ============================================

-- Table Organisations (code à 4 chiffres généré à la création, partagé par le PDG)
CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code CHAR(4) UNIQUE NOT NULL
);

-- Types ENUM pour les rôles utilisateur
CREATE TYPE user_role AS ENUM ('PDG', 'MANAGER', 'COLLABORATEUR');

-- Table Utilisateurs (org_id optionnel : peut rejoindre une org plus tard via le code)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'COLLABORATEUR',
    org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_organizations_code ON organizations(code);

-- Un utilisateur peut appartenir à plusieurs organisations (rôle par organisation)
CREATE TABLE IF NOT EXISTS user_organization_memberships (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role user_role NOT NULL DEFAULT 'COLLABORATEUR',
    PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_uom_user ON user_organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_uom_org ON user_organization_memberships(org_id);

-- Types ENUM pour le type de dossier
CREATE TYPE folder_type AS ENUM ('normal', 'shared', 'confidential');

-- Table Dossiers (mot de passe dédié si type = confidential)
CREATE TABLE IF NOT EXISTS folders (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type folder_type NOT NULL DEFAULT 'normal',
    folder_password_hash VARCHAR(255),
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    owner_space VARCHAR(20) NOT NULL DEFAULT 'organization',
    CONSTRAINT confidential_has_password CHECK (
        (type <> 'confidential') OR (type = 'confidential' AND folder_password_hash IS NOT NULL)
    )
);

CREATE INDEX idx_folders_org ON folders(org_id);
CREATE INDEX idx_folders_owner ON folders(owner_id);
CREATE INDEX idx_folders_owner_space ON folders(owner_space);

-- Table Fichiers (uploadés dans /uploads)
CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    size BIGINT DEFAULT 0,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    owner_space VARCHAR(20) NOT NULL DEFAULT 'personal',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_files_uploaded_by ON files(uploaded_by);
CREATE INDEX idx_files_deleted_at ON files(deleted_at);
CREATE INDEX idx_files_org ON files(org_id);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_owner_space ON files(owner_space);
