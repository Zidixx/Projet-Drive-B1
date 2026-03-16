-- Table Fichiers (uploadés dans /uploads)
CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    original_name VARCHAR(255) NOT NULL,
    stored_name VARCHAR(255) NOT NULL,
    size BIGINT DEFAULT 0,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_uploaded_by ON files(uploaded_by);
CREATE INDEX idx_files_org ON files(org_id);
CREATE INDEX idx_files_folder ON files(folder_id);
