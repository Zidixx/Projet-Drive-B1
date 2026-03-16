#!/bin/bash
# Exécute la migration add-org-code.sql (psql via Homebrew)
# Usage: ./run-migration.sh   ou   bash run-migration.sh

cd "$(dirname "$0")"

# Chercher psql (Homebrew sur Mac)
if [ -x "/opt/homebrew/opt/postgresql@16/bin/psql" ]; then
  PSQL="/opt/homebrew/opt/postgresql@16/bin/psql"
elif [ -x "/opt/homebrew/opt/postgresql@17/bin/psql" ]; then
  PSQL="/opt/homebrew/opt/postgresql@17/bin/psql"
elif command -v psql &>/dev/null; then
  PSQL="psql"
else
  echo "psql introuvable. Ajoute PostgreSQL au PATH, par exemple :"
  echo '  export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"'
  exit 1
fi

# Mot de passe depuis .env si présent (sinon psql demandera)
export PGPASSWORD="${DB_PASSWORD:-nathan}"

$PSQL -U postgres -d drive_db -f migrations/add-org-code.sql

echo "Migration terminée (vérifiez les messages ci-dessus)."
