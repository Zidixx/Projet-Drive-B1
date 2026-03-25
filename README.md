# Projet Drive B1

Application de stockage cloud sécurisé multi-organisations, similaire à Google Drive, avec gestion des rôles, des dossiers et des fichiers.

## Fonctionnalités

- **Authentification** — Inscription/connexion avec JWT (expiration 7 jours)
- **Multi-organisations** — Créer ou rejoindre des organisations via un code à 4 chiffres
- **Rôles** — Hiérarchie PDG → Manager → Collaborateur
- **Gestion des fichiers** — Upload (50 MB max), téléchargement, déplacement, corbeille et suppression définitive
- **Gestion des dossiers** — Types : normal, partagé, confidentiel (protégé par mot de passe)
- **Stockage** — Suivi de l'espace utilisé avec une limite de 15 Go par espace
- **Thèmes** — Interface claire / sombre

## Stack technique

| Couche      | Technologie                     |
|-------------|---------------------------------|
| Backend     | Node.js + Express.js v5         |
| Base de données | PostgreSQL                  |
| Auth        | JWT + bcrypt                    |
| Upload      | Multer                          |
| Frontend    | HTML / CSS / JavaScript vanilla |

## Prérequis

- Node.js v14+
- PostgreSQL

## Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer l'environnement
cp .env.example .env
# Remplir les variables dans .env

# 3. Créer la base de données et initialiser le schéma
createdb drive_db
psql -U postgres -d drive_db -f init.sql

# 4. Appliquer les migrations
psql -U postgres -d drive_db -f migrations/add-org-code.sql
psql -U postgres -d drive_db -f migrations/add-user-organization-memberships.sql
psql -U postgres -d drive_db -f migrations/add-owner-space-columns.sql
psql -U postgres -d drive_db -f migrations/add-files-table.sql
psql -U postgres -d drive_db -f migrations/add-deleted-at-files.sql

# 5. Démarrer le serveur
npm start
```

L'application est accessible sur [http://localhost:3000](http://localhost:3000).

## Variables d'environnement

| Variable       | Description                          | Exemple           |
|----------------|--------------------------------------|-------------------|
| `DB_HOST`      | Hôte PostgreSQL                      | `localhost`       |
| `DB_PORT`      | Port PostgreSQL                      | `5432`            |
| `DB_NAME`      | Nom de la base de données            | `drive_db`        |
| `DB_USER`      | Utilisateur PostgreSQL               | `postgres`        |
| `DB_PASSWORD`  | Mot de passe PostgreSQL              |                   |
| `JWT_SECRET`   | Clé secrète pour les tokens JWT      |                   |
| `JWT_EXPIRES_IN` | Durée de validité des tokens       | `7d`              |
| `PORT`         | Port du serveur                      | `3000`            |
| `UPLOAD_PATH`  | Répertoire de stockage des fichiers  | `./uploads`       |

## API — Endpoints principaux

### Auth
| Méthode | Route   | Description          |
|---------|---------|----------------------|
| POST    | `/register` | Inscription      |
| POST    | `/login`    | Connexion        |
| GET     | `/me`       | Profil courant   |

### Organisations
| Méthode | Route                    | Description               |
|---------|--------------------------|---------------------------|
| POST    | `/organizations`         | Créer une organisation    |
| POST    | `/organizations/join`    | Rejoindre via code        |
| POST    | `/organizations/switch`  | Changer d'organisation    |
| POST    | `/organizations/leave`   | Quitter l'organisation    |

### Fichiers
| Méthode | Route                          | Description                   |
|---------|--------------------------------|-------------------------------|
| POST    | `/api/upload`                  | Uploader un fichier           |
| GET     | `/api/files`                   | Lister les fichiers           |
| DELETE  | `/api/files/:id`               | Mettre à la corbeille         |
| POST    | `/api/files/:id/restore`       | Restaurer depuis la corbeille |
| DELETE  | `/api/files/:id/permanent`     | Suppression définitive        |
| DELETE  | `/api/files/trash/empty`       | Vider la corbeille            |
| POST    | `/api/files/:id/move`          | Déplacer vers un dossier      |
| GET     | `/api/files/:id/download`      | Télécharger un fichier        |
| GET     | `/api/storage`                 | Usage du stockage             |

### Dossiers
| Méthode | Route                        | Description                      |
|---------|------------------------------|----------------------------------|
| GET     | `/folders`                   | Lister les dossiers              |
| POST    | `/folders`                   | Créer un dossier                 |
| DELETE  | `/folders/:id`               | Supprimer un dossier             |
| POST    | `/api/folders/:id/unlock`    | Déverrouiller un dossier confidentiel |

## Structure du projet

```
Projet-Drive-B1/
├── public/
│   ├── index.html      # Page de connexion / inscription
│   ├── drive.html      # Interface principale
│   └── script.js       # Logique frontend
├── migrations/         # Scripts de migration SQL
├── uploads/            # Fichiers uploadés
├── server.js           # Serveur Express (routes, logique)
├── auth.js             # Middleware d'authentification JWT
├── db.js               # Pool de connexion PostgreSQL
├── storage.js          # Configuration Multer
├── init.sql            # Schéma initial de la base de données
└── .env.example        # Template des variables d'environnement
```

## Schéma de la base de données

- `organizations` — Organisations avec code unique à 4 chiffres
- `users` — Utilisateurs avec rôle et organisation
- `user_organization_memberships` — Appartenance multi-organisations
- `folders` — Dossiers (normal / shared / confidential)
- `files` — Fichiers avec suppression douce (`deleted_at`)
