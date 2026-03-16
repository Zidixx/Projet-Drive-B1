# Connexion PostgreSQL – mot de passe refusé

Si tu as **"password authentication failed for user postgres"** :

## Option 1 : Utiliser ton mot de passe actuel

Si tu te connectes déjà à Postgres avec un mot de passe (par exemple avec `psql -U postgres`), mets **ce même mot de passe** dans le fichier `.env` :

```env
DB_PASSWORD=ton_mot_de_passe_actuel
```

Puis redémarre le serveur (`npm start`).

---

## Option 2 : Définir le mot de passe "nathan" pour postgres

Si tu veux que l’app utilise le mot de passe `nathan` (comme dans `.env`), il faut l’assigner à l’utilisateur `postgres` dans PostgreSQL.

1. Ouvre un terminal et connecte-toi à Postgres (avec ton mot de passe actuel ou en tant que ton utilisateur macOS si l’auth est en `peer`) :
   ```bash
   psql -U postgres -d postgres
   ```
   Si ça demande un mot de passe et que tu ne le connais pas, essaie :
   ```bash
   sudo -u postgres psql -d postgres
   ```
   (sur macOS avec Homebrew, parfois : `psql -d postgres` sans `-U postgres`)

2. Dans `psql`, exécute :
   ```sql
   ALTER USER postgres PASSWORD 'nathan';
   ```

3. Quitte avec `\q`, puis relance ton serveur Node.

---

## Option 3 : Vérifier la méthode d’authentification

Sur macOS avec Postgres installé via Homebrew, l’authentification peut être en `trust` ou `peer` pour les connexions locales. Si tu veux une connexion par mot de passe depuis Node, il faut que dans `pg_hba.conf` (dans le répertoire de données Postgres) une ligne pour `localhost` utilise `md5` ou `scram-sha-256` au lieu de `peer`. Après modification, redémarre Postgres.

Pour trouver `pg_hba.conf` :
```bash
psql -U postgres -c "SHOW hba_file"
```
