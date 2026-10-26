# Firebase — authentification Google et historiques

## 1. Ce qui est en place

| Élément | Rôle |
|---|---|
| `firebase-admin` (dépendance) | SDK **serveur** : vérification des ID tokens et accès Firestore |
| `src/firebase.ts` | initialisation unique (compte de service ou identifiants par défaut) |
| `src/middleware/auth.ts` | `FirebaseTokenVerifier`, `HybridVerifier`, mode `AUTH_MODE` |
| `src/history/` | contrat de stockage + adaptateur Firestore |
| `src/routes/history.ts` | `GET/PUT/DELETE /api/history` (API-CONTRACT.md §3.6–3.9) |
| `firebase.json` | déclare les règles et les index Firestore |
| `firestore.rules` | **tout est refusé côté navigateur** ; le SDK Admin contourne ces règles |
| `firestore.indexes.json` | index de groupe de collections sur `histories.expires_at` (pour la purge) ; aucun index composite applicatif |
| `.firebaserc` | projet par défaut : `altredige` |
| `npm run verif-firebase` | écrit, relit et supprime `_health/verif` : prouve l'accès réel |
| `npm run verif-auth` | crée un jeton custom, l'échange via l'API web et le vérifie avec le SDK Admin |
| `npm run verif-history` | écrit, lit, liste et supprime un historique contre un serveur réel |
| Projet Firebase | `altredige` (compte CLI vérifié le 22/10/2026) |
| Base Firestore | `(default)`, **eur3** (multi-région UE), Native, créée le 22/10/2026 |
| Règles Firestore | **déployées le 22/10/2026** : `allow read, write: if false` |

La configuration web fournie (`apiKey`, `appId`, `measurementId`…) est
**publique par nature** et **ne donne aucun accès à Firestore**. Le backend ne
l'utilise pas et elle n'est pas versionnée : le serveur passe par un compte de
service. Le frontend s'en servira uniquement pour l'authentification Firebase.

## 2. État au 23/10/2026

| Étape | État |
|---|---|
| Connexion CLI (`firebase login`) | **fait** — projet `altredige` courant |
| Base Firestore | **existe** — `(default)`, région `eur3` (UE), Native |
| Règles Firestore | **déployées** — compilation et release réussies |
| Compte de service du backend | **fait** — clé créée, stockée hors du dépôt |
| `npm run verif-firebase` | **FIRESTORE OK** — écriture, relecture et suppression vérifiées le 22/10/2026 |
| Authentification Firebase | **codée et vérifiée** — `npm run verif-auth` → `AUTH OK` (23/10/2026) |
| Historiques | **codés et vérifiés de bout en bout** — `npm run verif-history` → `HISTORIQUES OK` (23/10/2026) |
| TTL Firestore | **activé côté facturation, en attente d'IAM** - Blaze est actif ; `npm run setup-ttl` renvoie `403` tant que le compte de service n'a pas `roles/datastore.owner`. La purge planifiée `npm run purge-history` reste le repli opérationnel. |
| Frontend Google | **branché** - `public/index.html` utilise Firebase JS 10.12.2 (`signInWithPopup`), envoie l'ID token en `Authorization: Bearer` et synchronise les historiques via `/api/history`. |

> **Région** : `europe-west1` avait été choisie, mais créer une deuxième base
> exige l'offre payante (`403 — billing required`). La base existante est en
> `eur3`, une multi-région **européenne** : la localisation UE est respectée.
> Elle n'est pas supprimée pour être recréée (suppression irréversible, aucune
> donnée à perdre aujourd'hui mais aucun bénéfice immédiat). Si `europe-west1`
> devient une exigence, activer la facturation puis créer une base nommée
> `lexcanvas` dans cette région.

### 2.1 Compte de service du backend — fait

La clé a été générée dans la console puis **déplacée hors du dépôt** :

```
C:\OASIS\secrets\altredige-firebase-adminsdk.json
```

`.env` pointe dessus via `FIREBASE_SERVICE_ACCOUNT`. Le fichier est exclu de
Git. Ne jamais le copier dans le dépôt ni le coller dans un message. En cas de
doute, le révoquer dans la console et en générer un autre.

### 2.2 Variables du serveur

Dans `.env` (et sur le serveur de production) :

```dotenv
AUTH_MODE=hybrid                 # code | firebase | hybrid
FIREBASE_PROJECT_ID=altredige
FIREBASE_SERVICE_ACCOUNT=C:\OASIS\secrets\altredige-firebase-adminsdk.json
HISTORY_ENABLED=1
HISTORY_RETENTION_DAYS=90
HISTORY_MAX_PER_USER=100
```

Le frontend livré se connecte avec Google : la configuration cible est
`AUTH_MODE=firebase` (le code partagé est alors ignoré). `AUTH_MODE=hybrid`
reste disponible pour une transition si un ancien client envoie encore
`X-Access-Code`. `HISTORY_ENABLED=1` exige `AUTH_MODE=firebase` ou `hybrid` :
un historique doit être rattaché à un `uid`.

### 2.3 Vérifier

```bash
npm run verif-firebase
npm run verif-auth
npm run verif-history     # serveur en cours d'exécution, HISTORY_ENABLED=1
```

`verif-firebase` écrit un document technique, le relit, le supprime, et affiche
`FIRESTORE OK`. Il ne touche à aucune donnée métier.

`verif-auth` exige `FIREBASE_WEB_API_KEY` dans `.env` (clé web publique du
projet, utilisée uniquement par le script). Il crée un jeton custom pour un
utilisateur de test, l'échange contre un ID token via
`accounts:signInWithCustomToken`, le vérifie côté Admin, puis supprime
l'utilisateur de test. Aucun jeton n'est affiché ni journalisé.

`verif-history` fait la même authentification, puis appelle réellement
`PUT`, `GET /api/history`, `GET /api/history/:id`, `DELETE` et vérifie le
`404`. Il nettoie le document et l'utilisateur de test. Variables :
`HISTORY_TEST_URL` (défaut `http://localhost:3123`) et `FIREBASE_WEB_API_KEY`.

## 3. Décisions prises (22–23/10/2026)

| Sujet | Décision |
|---|---|
| Identité des historiques | **`uid` Firebase** vérifié côté serveur ; le code partagé n'a pas accès aux historiques |
| Conservation | **90 jours** après la dernière modification (purge planifiée, TTL si Blaze, suppression manuelle) |
| Région Firestore | **eur3** (multi-région UE) — base existante ; `europe-west1` exigerait l'offre payante pour une seconde base |
| Mode d'authentification | `code` par défaut (compatibilité), `firebase` pour la production Google, `hybrid` pour la transition |
| Plafond | 100 historiques par utilisateur |

## 4. Modèle de données

```
users/{uid}/histories/{historyId}
    title          string, 200 caractères max
    contract_type  string | null, 64 caractères max
    markdown       string, 200 Ko max
    version        number
    messages       tableau de { role, content }, 30 max
    created_at     timestamp
    updated_at     timestamp
    expires_at     timestamp  (purge après 90 jours)
```

- `uid` = identité Firebase issue du jeton Google vérifié par le SDK Admin.
  L'`uid` est validé (`^[A-Za-z0-9_-]{1,128}$`) avant de servir de chemin.
- L'isolation est structurelle : chaque utilisateur a sa sous-collection.
- Pas d'index composite applicatif : `orderBy('updated_at', 'desc')` dans une
  sous-collection utilise l'index automatique. L'index de groupe de collections
  sur `expires_at` ne sert qu'à la purge globale.
- Plafond : 100 historiques par utilisateur (les plus anciens sont supprimés à
  la création du 101e).
- La lecture filtre et purge les documents expirés même si le TTL n'a pas encore
  agi : le TTL Firestore peut mettre jusqu'à 24 h.
- Suppression du compte = suppression récursive de `users/{uid}`.
- **Purge** : politique TTL sur `expires_at` si l'offre Blaze est active ;
  sinon `npm run purge-history` (à planifier) et purge opportuniste à la
  lecture. Voir §6.1 et §6.2.

## 5. API

| Méthode | Route | Réponse |
|---|---|---|
| `GET` | `/api/history` | `{ items: [{ id, title, contract_type, version, created_at, updated_at }] }`, tri décroissant, 50 max |
| `GET` | `/api/history/:id` | le document complet + `messages` ; `404` si inconnu, expiré ou appartenant à un autre utilisateur |
| `PUT` | `/api/history/:id` | upsert ; `200 { id, updated_at }` ; limites du contrat |
| `DELETE` | `/api/history/:id` | `204`, idempotent |

Toutes passent par l'authentification Firebase : le front envoie le jeton
d'identité Google (`Authorization: Bearer <idToken>`), le serveur le vérifie
avec le SDK Admin et utilise `uid` comme clé. Les routes ne sont montées que si
`HISTORY_ENABLED=1` ; sinon elles répondent `404 not_found`.

Les quatre routes sont documentées dans `API-CONTRACT.md` §3.6 à §3.9. Le
contrat est passé en version `1.1` ; le serveur reste **sans état pour le
chat**, mais conserve des snapshots pour les utilisateurs authentifiés.

## 6. Sécurité et conformité

- Firestore n'est **jamais** exposé au navigateur : règles `allow read, write: if false`.
  Le front utilise Firebase **Auth** uniquement, pas Firestore.
- La clé de compte de service n'entre ni dans Git, ni dans un journal, ni dans
  une réponse HTTP.
- Les jetons Firebase et les codes partagés ne sont jamais journalisés. Les
  erreurs de vérification sont journalisées sous forme de code (`auth/id-token-expired`,
  etc.), sans le jeton.
- Les documents contiennent des données personnelles (noms, adresses, loyers) :
  voir `NOTE-CONFORMITE-DONNEES.md` pour la localisation, la durée et la
  suppression.
- Purge : TTL automatique si l'offre Blaze est active ; sinon
  `npm run purge-history` (planifié) et purge opportuniste à la lecture ;
  suppression manuelle via `DELETE /api/history/:id`.
- Aucun contenu de contrat dans les journaux, comme partout ailleurs.
- Les requêtes d'historique sont limitées par `uid` (`RATE_HISTORY_PER_MIN`,
  60/min par défaut).

### 6.1 Activer la politique TTL

**Prérequis 1 : offre Blaze.** Elle est **activée** (23/10/2026). Sur l'offre
Spark, Google répond `403 — Project altredige has billing disabled.`

**Prérequis 2 : permission IAM.** `npm run setup-ttl` appelle l'API Admin
Firestore avec le compte de service. Tant que celui-ci n'a pas
`roles/datastore.owner`, l'API répond `403 The caller does not have permission`.
Accorder le rôle **temporairement**, lancer le script, puis le retirer :

```bash
# Console Google Cloud → IAM → compte de service
#   firebase-adminsdk-fbsvc@altredige.iam.gserviceaccount.com
# Ajouter : Cloud Datastore Owner (roles/datastore.owner)
npm run setup-ttl          # doit afficher TTL ACTIVÉ (état ACTIVE)
# Puis retirer le rôle (la politique TTL reste configurée).
```

La politique TTL s'applique au groupe de collections `histories`, champ
`expires_at` :

```bash
gcloud firestore fields ttls update expires_at \
  --collection-group=histories \
  --enable-ttl \
  --project=altredige
```

Sans `gcloud`, la même opération se fait dans la console Firebase :
**Firestore → TTL → Créer une politique**, collection `histories`, champ
`expires_at`. Ne pas laisser `roles/datastore.owner` sur le compte d'exécution
du serveur.

### 6.2 Purger sans TTL (repli opérationnel)

Tant que le TTL n'est pas actif, la conservation de 90 jours reste appliquée :
un document dont `expires_at` est passé est traité comme absent, puis supprimé
à la lecture. Pour nettoyer aussi les comptes inactifs, planifier la purge :

```bash
npm run purge-history -- --dry-run   # compte sans supprimer
npm run purge-history                # supprime par lots de 500
```

Planification quotidienne (exemple Linux) :

```cron
15 3 * * * cd /opt/lexcanvas && npm run purge-history >> /var/log/lexcanvas-purge.log 2>&1
```

Sur Windows, créer une tâche planifiée quotidienne qui exécute
`npm run purge-history` dans le dossier du projet. Le script ne lit ni
n'affiche aucun contenu de contrat.

L'index `histories.expires_at` (groupe de collections, ascendant) est déclaré
dans `firestore.indexes.json` et se déploie avec :

```bash
firebase deploy --only firestore:indexes --project altredige
```

La première construction peut prendre quelques minutes ; tant qu'il est
`CREATING`, la requête de purge répond `FAILED_PRECONDITION`.

## 7. Ce qui n'est pas fait, volontairement

- **Pas de Crashlytics** : le lien fourni documente l'assistance IA pour les
  plantages d'applications mobiles/web. Le backend LexCanvas n'en a pas besoin.
- **Pas de SDK Firestore dans le navigateur** : le front utilise Firebase Auth,
  jamais Firestore directement. Les règles restent donc `deny all`.
- **Pas de fournisseur de messagerie** : Google est le seul fournisseur prévu
  pour la V1. Le backend accepterait techniquement tout ID token Firebase
  valide ; la restriction à Google se fait dans la console Firebase.
- **Frontend Google branché** : `public/index.html` initialise Firebase JS
  (compat 10.12.2) et `public/app-api.js` gère `signInWithPopup`, l'ID token
  `Authorization: Bearer` et les historiques `/api/history` (liste, ouverture,
  sauvegarde, suppression). Le mode `?mock=1` fonctionne sans connexion.

> **Popup Google et COOP** : la page doit répondre
> `Cross-Origin-Opener-Policy: same-origin-allow-popups`. Avec `same-origin`,
> le popup se ferme après le consentement Google mais Firebase ne peut pas
> rendre la session à la page : l'utilisateur attend une à deux minutes et
> revient à l'écran de connexion. Le test C1 verrouille cet en-tête.
