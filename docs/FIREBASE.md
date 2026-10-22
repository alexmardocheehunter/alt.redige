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
| Projet Firebase | `altredige` (compte CLI vérifié le 22/10/2026) |
| Base Firestore | `(default)`, **eur3** (multi-région UE), Native, créée le 22/10/2026 |
| Règles Firestore | **déployées le 22/10/2026** : `allow read, write: if false` |

La configuration web fournie ( `apiKey`, `appId`, `measurementId`… ) est
**publique par nature** et **ne donne aucun accès à Firestore**. Le backend ne
l'utilise pas et elle n'est pas versionnée : le serveur passe par un compte de
service.

## 2. État au 22/10/2026

| Étape | État |
|---|---|
| Connexion CLI (`firebase login`) | **fait** — projet `altredige` courant |
| Base Firestore | **existe** — `(default)`, région `eur3` (UE), Native |
| Règles Firestore | **déployées** — compilation et release réussies |
| Compte de service du backend | **fait** — clé créée, stockée hors du dépôt |
| `npm run verif-firebase` | **FIRESTORE OK** — écriture, relecture et suppression vérifiées le 22/10/2026 |

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
FIREBASE_PROJECT_ID=altredige
FIREBASE_SERVICE_ACCOUNT=C:\OASIS\secrets\altredige-firebase-adminsdk.json
```

### 2.3 Vérifier

```bash
npm run verif-firebase
```

Le script écrit un document technique, le relit, le supprime, et affiche
`FIRESTORE OK`. Il ne touche à aucune donnée métier. Vérifié le 22/10/2026.

## 3. Décisions prises (22/10/2026)

| Sujet | Décision |
|---|---|
| Identité des historiques | **attendre Google Auth** : aucune route d'historique avant l'authentification individuelle ; le front garde `localStorage` en attendant |
| Conservation | **90 jours** après la dernière modification (TTL Firestore + suppression manuelle) |
| Région Firestore | **eur3** (multi-région UE) — base existante ; `europe-west1` exigerait l'offre payante pour une seconde base |

Conséquence : Firestore est **prêt** (base, règles et compte de service
vérifié) mais **aucune donnée n'y est écrite** tant que Google Auth n'est pas
branché. Le contrat d'API reste donc inchangé : le serveur demeure sans état.

## 4. Modèle de données prévu (après Google Auth)

```
users/{uid}/histories/{historyId}
    title          string, 200 caractères max
    contract_type  string
    markdown       string, 200 Ko max
    version        number
    messages       tableau de { role, content }, 30 max
    created_at     timestamp
    updated_at     timestamp
    expires_at     timestamp  (TTL Firestore, 90 jours)
```

- `uid` = identité Firebase issue du jeton Google vérifié par le SDK Admin.
- L'isolation est structurelle : chaque utilisateur a sa sous-collection.
- Pas d'index composite : `orderBy('updated_at', 'desc')` dans une
  sous-collection utilise l'index automatique.
- Plafond : 100 historiques par utilisateur (les plus anciens sont supprimés).
- Suppression du compte = suppression récursive de `users/{uid}`.
- **TTL à activer** le jour du branchement, sur le champ `expires_at` du groupe
  de collections `histories` (console Firestore → TTL, ou
  `gcloud firestore fields ttls update expires_at --collection-group=histories --enable-ttl`).
  Tant que le TTL n'est pas activé, `expires_at` est écrit mais rien n'est purgé.


## 5. API prévue (après Google Auth)

| Méthode | Route | Réponse |
|---|---|---|
| `GET` | `/api/history` | `{ items: [{ id, title, contract_type, version, created_at, updated_at }] }`, tri décroissant, 50 max |
| `GET` | `/api/history/:id` | le document complet + `messages` ; `404` si inconnu |
| `PUT` | `/api/history/:id` | upsert ; `200 { id, updated_at }` ; limites ci-dessus |
| `DELETE` | `/api/history/:id` | `204`, idempotent |

Toutes passeront par l'authentification Firebase : le front envoie le jeton
d'identité Google (`Authorization: Bearer <idToken>`), le serveur le vérifie
avec le SDK Admin et utilise `uid` comme clé. Les routes ne seront montées
qu'une fois ce vérificateur en place.

Le contrat actuel affirme le contraire — « le serveur est sans état, le document
vit dans le navigateur » (`API-CONTRACT.md`, §1). Ces routes ne seront donc
implémentées qu'après validation explicite et mise à jour du contrat.

## 6. Sécurité et conformité

- Firestore n'est **jamais** exposé au navigateur : règles `allow read, write: if false`.
- La clé de compte de service n'entre ni dans Git, ni dans un journal, ni dans
  une réponse HTTP.
- Les documents contiennent des données personnelles (noms, adresses, loyers) :
  la note `NOTE-CONFORMITE-DONNEES.md` devra dire où elles sont stockées, combien
  de temps, et comment les supprimer.
- Purge automatique par TTL sur `expires_at` ; suppression manuelle via
  `DELETE /api/history/:id`.
- Aucun contenu de contrat dans les journaux, comme partout ailleurs.

## 7. Ce qui n'est pas fait, volontairement

- **Pas de Crashlytics** : le lien fourni documente l'assistance IA pour les
  plantages d'applications mobiles/web. Le backend LexCanvas n'en a pas besoin.
- **Pas de SDK web Firebase** : il exposerait Firestore au navigateur, alors que
  l'authentification n'est pas encore individuelle.
- **Pas encore de routes d'historique** : le contrat est normatif et affirme le
  contraire ; la mise à jour du contrat précède le code.
- **Pas d'authentification Google** : elle se branchera sur `AccessVerifier`
  (`src/middleware/auth.ts`) ; les historiques passeront alors de `deviceHash`
  à `uid`.
