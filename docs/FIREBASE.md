# Firebase — Firestore pour les historiques

## 1. Ce qui est en place

| Élément | Rôle |
|---|---|
| `firebase-admin` (dépendance) | SDK **serveur** : c'est lui, et lui seul, qui parlera à Firestore |
| `firebase.json` | déclare les règles et les index Firestore |
| `firestore.rules` | **tout est refusé côté navigateur** ; le SDK Admin contourne ces règles |
| `firestore.indexes.json` | aucun index composite nécessaire pour le modèle retenu |
| `.firebaserc` | projet par défaut : `altredige` |
| `npm run verif-firebase` | écrit, relit et supprime `_health/verif` : prouve l'accès réel |

La configuration web fournie ( `apiKey`, `appId`, `measurementId`… ) est
**publique par nature** et **ne donne aucun accès à Firestore**. Le backend ne
l'utilise pas et elle n'est pas versionnée : le serveur passe par un compte de
service.

## 2. Ce qu'Alex doit faire (une seule fois)

### a. Se connecter à la CLI Firebase — interactif, obligatoire

```bash
npx firebase-tools@latest login
npx firebase-tools@latest projects:list
```

C'est la seule étape que je ne peux pas faire à ta place : elle ouvre le
navigateur et attend ta validation. Une fois connecté, je peux créer la base et
déployer les règles depuis le terminal.

### b. Créer la base Firestore (si elle n'existe pas déjà)

```bash
npx firebase-tools@latest firestore:databases:create --project altredige --location europe-west1
```

`europe-west1` (Belgique) est la région la plus proche d'Abidjan parmi les
régions Firestore disponibles ; elle garde les données dans l'Union européenne.
Le choix est **définitif** pour une base donnée.

### c. Déployer les règles

```bash
npx firebase-tools@latest deploy --only firestore:rules --project altredige
```

### d. Créer le compte de service du backend

Console Firebase → **Paramètres du projet** → **Comptes de service** →
**Générer une nouvelle clé privée**. Enregistre le fichier JSON **hors du
dépôt**, par exemple :

```
C:\OASIS\secrets\altredige-firebase-adminsdk.json
```

Ne me colle pas son contenu : indique-moi seulement le chemin. Le fichier est
déjà exclu de Git (`*-firebase-adminsdk-*.json`).

### e. Variables du serveur

Dans `.env` (et sur le serveur de production) :

```dotenv
FIREBASE_PROJECT_ID=altredige
FIREBASE_SERVICE_ACCOUNT=C:\OASIS\secrets\altredige-firebase-adminsdk.json
```

### f. Vérifier

```bash
npm run verif-firebase
```

Le script écrit un document technique, le relit, le supprime, et affiche
`FIRESTORE OK`. Il ne touche à aucune donnée métier.

## 3. Modèle de données proposé (à valider)

```
devices/{deviceHash}/histories/{historyId}
    title          string, 200 caractères max
    contract_type  string
    markdown       string, 200 Ko max
    version        number
    messages       tableau de { role, content }, 30 max
    created_at     timestamp
    updated_at     timestamp
    expires_at     timestamp  (TTL Firestore)
```

- `deviceHash` = SHA-256 d'un cookie `HttpOnly` `lc_device` (256 bits, aléatoire).
  **Avant Google Auth, il n'existe pas d'identité utilisateur** : le navigateur
  est la seule clé possible. Deux appareils = deux historiques.
- L'isolation est structurelle : chaque appareil a sa sous-collection ; aucun
  document n'est lisible par un autre appareil, même en connaissant un identifiant.
- Pas d'index composite : `orderBy('updated_at', 'desc')` dans une
  sous-collection utilise l'index automatique.
- Plafond : 100 historiques par appareil (les plus anciens sont supprimés).

## 4. API proposée — à ajouter au contrat **avant** le code

| Méthode | Route | Réponse |
|---|---|---|
| `GET` | `/api/history` | `{ items: [{ id, title, contract_type, version, created_at, updated_at }] }`, tri décroissant, 50 max |
| `GET` | `/api/history/:id` | le document complet + `messages` ; `404` si inconnu |
| `PUT` | `/api/history/:id` | upsert ; `200 { id, updated_at }` ; limites ci-dessus |
| `DELETE` | `/api/history/:id` | `204`, idempotent |

Toutes passent par l'authentification existante (`X-Access-Code`) et par une
limite de débit dédiée. Le cookie `lc_device` est posé à la première réponse
(`HttpOnly`, `SameSite=Lax`, `Secure` en production, un an).

Le contrat actuel affirme le contraire — « le serveur est sans état, le document
vit dans le navigateur » (`API-CONTRACT.md`, §1). Ces routes ne seront donc
implémentées qu'après validation explicite et mise à jour du contrat.

## 5. Sécurité et conformité

- Firestore n'est **jamais** exposé au navigateur : règles `allow read, write: if false`.
- La clé de compte de service n'entre ni dans Git, ni dans un journal, ni dans
  une réponse HTTP.
- Les documents contiennent des données personnelles (noms, adresses, loyers) :
  la note `NOTE-CONFORMITE-DONNEES.md` devra dire où elles sont stockées, combien
  de temps, et comment les supprimer.
- Purge automatique par TTL sur `expires_at` ; suppression manuelle via
  `DELETE /api/history/:id`.
- Aucun contenu de contrat dans les journaux, comme partout ailleurs.

## 6. Ce qui n'est pas fait, volontairement

- **Pas de Crashlytics** : le lien fourni documente l'assistance IA pour les
  plantages d'applications mobiles/web. Le backend LexCanvas n'en a pas besoin.
- **Pas de SDK web Firebase** : il exposerait Firestore au navigateur, alors que
  l'authentification n'est pas encore individuelle.
- **Pas encore de routes d'historique** : le contrat est normatif et affirme le
  contraire ; la mise à jour du contrat précède le code.
- **Pas d'authentification Google** : elle se branchera sur `AccessVerifier`
  (`src/middleware/auth.ts`) ; les historiques passeront alors de `deviceHash`
  à `uid`.
