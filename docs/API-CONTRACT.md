# LexCanvas — Contrat d'API (source de vérité)

Ce document est **normatif**. Le frontend (un seul fichier HTML) et le backend sont construits par deux agents différents, sans se parler. Tout ce qui n'est pas écrit ici n'existe pas. En cas de désaccord entre ce contrat et une spec, **le contrat gagne**. Toute modification du contrat se fait ici d'abord, puis dans le code.

Version du contrat : `1.2`

---

## 1. Principes

- Le serveur est **sans état pour le chat** : le client envoie à chaque requête l'historique de conversation et le document courant. Le document vit dans le navigateur (et `localStorage`), pas sur le serveur.
- **Historiques (optionnel)** : si `HISTORY_ENABLED=1` et si l'utilisateur est authentifié individuellement (Google/Firebase), le serveur conserve des snapshots de contrats dans Firestore. Sans identité individuelle (code partagé), rien n'est conservé côté serveur et les routes d'historique refusent l'accès. Voir §3.6 à §3.9.
- **Profils d'entreprise (compte Google)** : si Firebase est configuré, chaque utilisateur peut enregistrer jusqu'à cinq profils de son entreprise, isolés par `uid`. Le chat reçoit le profil sélectionné ou celui par défaut. Voir §3.10.
- Le chat est en **streaming SSE** sur un `POST` (donc lecture via `fetch` + `ReadableStream`, pas `EventSource`).
- Le document est un **Markdown restreint** (section 5). Ce sous-ensemble est le même pour le rendu du Canvas, l'export Word et l'impression PDF.
- Le serveur sert aussi le frontend : `GET /` renvoie `public/index.html`. Toutes les URL d'API sont donc **relatives** (`/api/...`), sans domaine codé en dur.

## 2. Authentification

Le serveur choisit son mécanisme avec la variable `AUTH_MODE` :

| Mode | Justificatif accepté | Identité | Usage |
|---|---|---|---|
| `code` (défaut) | `X-Access-Code: <ACCESS_CODE>` | `null` | Mode historique. Si `ACCESS_CODE` est vide, l'accès est ouvert (développement uniquement). |
| `firebase` | `Authorization: Bearer <idToken>` | `uid` Firebase | Production avec Google. Le code partagé est ignoré. |
| `hybrid` | L'un ou l'autre | `uid` si jeton, sinon `null` | Transition : l'ancien front continue avec le code, le nouveau se connecte avec Google. Sans `ACCESS_CODE`, équivaut à `firebase`. |

Règles :

- `/api/health` reste **public** dans tous les modes.
- Toute autre route `/api/*` exige un justificatif valide. À défaut : `401`, code `unauthorized`.
- Le jeton Firebase est un **ID token** obtenu par le SDK Firebase après une connexion Google. Le serveur le vérifie avec le SDK Admin ; il ne fait jamais confiance à un `uid` envoyé par le client.
- Les routes d'historique (§3.6 à §3.9) exigent une **identité individuelle** (`uid`). Un code partagé ne suffit jamais : `401` avec un message invitant à se connecter avec Google.
- Le jeton se transmet uniquement dans l'en-tête `Authorization`, jamais dans l'URL. Il n'est jamais journalisé.
- En production, `AUTH_MODE=code` exige `ACCESS_CODE`. `AUTH_MODE=firebase` n'exige pas de code partagé.

### 2.1 Côté frontend (Google)

1. Charger le SDK Firebase JS et l'initialiser avec la configuration web du projet (`apiKey`, `authDomain`, `projectId`, `appId`). Ces valeurs sont publiques ; la clé du compte de service reste sur le serveur.
2. Proposer « Se connecter avec Google » via `GoogleAuthProvider` (`signInWithPopup` ou `signInWithRedirect`).
3. Avant chaque appel `/api/*`, envoyer `Authorization: Bearer <idToken>` obtenu par `getIdToken()`.
4. En cas de `401`, forcer un rafraîchissement (`getIdToken(true)`) et réessayer **une fois** ; si l'échec persiste, déconnecter l'utilisateur et revenir à l'écran de connexion.
5. Ne pas stocker le jeton à la main dans `localStorage` : le SDK gère sa persistance et son renouvellement.
6. En mode `hybrid`, le code partagé peut rester disponible comme solution de secours. En mode `firebase`, le champ de code doit être masqué.
7. La politique CSP du serveur autorise déjà les domaines Firebase/Google nécessaires (`www.gstatic.com`, `apis.google.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `*.firebaseapp.com`, `accounts.google.com`). Toute autre ressource externe exige une mise à jour du contrat et de `src/middleware/csp.ts`.

## 3. Endpoints

### 3.1 `GET /api/health`
Réponse `200` : `{"ok": true, "contract_version": "1.1", "model": "<nom du modèle>"}`.

### 3.2 `GET /api/templates`
Liste des types de contrats disponibles (pour afficher les boutons de démarrage).

```json
{
  "templates": [
    { "id": "bail-habitation", "label": "Bail d'habitation", "description": "Location d'un logement à usage d'habitation", "status": "ready" }
  ]
}
```
`status` ∈ `"ready"` | `"draft"`. Le frontend n'affiche que `ready` (et garde une liste de secours codée en dur si l'appel échoue).

### 3.3 `POST /api/chat` (SSE)

**Requête** (`Content-Type: application/json`)

```json
{
  "messages": [
    { "role": "user", "content": "Je veux un bail pour un studio à Yopougon à 70 000 FCFA" },
    { "role": "assistant", "content": "Quelle est la durée du bail ?" },
    { "role": "user", "content": "12 mois" }
  ],
  "document": { "markdown": "# Contrat de bail ...", "version": 3 },
  "contract_type": "bail-habitation"
}
```

| Champ | Règle |
|---|---|
| `messages` | Texte seul, alternance `user`/`assistant`, le dernier est `user`. 1 à 30 éléments (le client tronque aux 30 derniers). Chaque `content` ≤ 8 000 caractères. Les appels d'outils ne sont **jamais** renvoyés dans l'historique. |
| `document` | `null` si aucun contrat n'existe. Sinon `markdown` (≤ 200 000 octets) et `version` (entier ≥ 1, informatif). C'est la **version actuelle**, y compris les modifications manuelles de l'utilisateur. |
| `contract_type` | Optionnel. Indice de type (identifiant de `/api/templates`) quand l'utilisateur a cliqué sur un bouton de démarrage. `null` sinon. |
| `company_profile_id` | Optionnel. Identifiant du profil d'entreprise sélectionné (§3.10), 8 à 64 caractères `[A-Za-z0-9_-]`. Le serveur résout ce profil ; s'il est absent ou inconnu, il utilise le profil par défaut de l'utilisateur. Sans profil, le chat fonctionne normalement. Le contenu du profil n'est jamais renvoyé dans le flux. |

**Réponse** : `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Pas de compression sur ce flux.

Format des événements : lignes `event: <nom>` puis `data: <JSON sur une seule ligne>` puis ligne vide. Un commentaire `: ping` est envoyé toutes les 15 secondes.

| Événement | Données | Sens |
|---|---|---|
| `ready` | `{"request_id": "..."}` | Le flux est ouvert. Toujours le premier. |
| `text_delta` | `{"text": "..."}` | Morceau de texte à **ajouter** à la bulle de chat de l'assistant. |
| `status` | `{"phase": "template"\|"drafting"\|"editing", "label": "..."}` | Libellé court en français à afficher pendant le travail (ex. « Chargement du modèle de bail… »). |
| `canvas_start` | `{"mode": "create"\|"edit", "title": "..."?, "contract_type": "..."?}` | Le serveur commence à écrire dans le Canvas. En `create`, `title` et `contract_type` sont présents. |
| `canvas_delta` | `{"text": "..."}` | **Uniquement en mode `create`.** Morceau de Markdown à **ajouter** à la fin du Canvas en cours d'écriture. |
| `canvas_set` | voir ci-dessous | **Version définitive** du document. Remplace tout ce que le client avait accumulé. |
| `error` | `{"code": "...", "message": "...", "retryable": true\|false}` | Échec pendant le flux. Voir section 4. |
| `done` | `{"stop_reason": "end_turn"\|"max_steps", "usage": {"input_tokens": 0, "output_tokens": 0}}` | Fin normale. Toujours le dernier événement d'un flux réussi. |

`canvas_set` :

```json
{
  "mode": "create",
  "markdown": "# Contrat de bail ...",
  "version": 4,
  "title": "Contrat de bail à usage d'habitation",
  "contract_type": "bail-habitation",
  "edits_applied": 2,
  "validation": {
    "placeholders": 8,
    "issues": [
      { "code": "missing_article", "severity": "warning", "message": "Article « Résiliation » absent" }
    ],
    "fields": {
      "required": [ { "key": "bailleur", "label": "Identité du bailleur", "filled": false } ],
      "optional": [ { "key": "caution", "label": "Caution", "filled": true } ]
    }
  },
  "legal_notice": {
    "required": true,
    "text": "Ce document doit être relu et validé par un professionnel du droit avant signature."
  }
}
```
- `version` = `document.version` reçu + nombre de `canvas_set` déjà émis dans ce flux + 1. Si `document` était `null`, on part de 0.
- `edits_applied` n'existe qu'en mode `edit`.
- `validation.placeholders` = nombre d'occurrences de `[À COMPLÉTER ...]` dans `markdown`.
- `severity` ∈ `"info"` | `"warning"` | `"error"`. Le frontend affiche les `warning` et `error` dans une liste repliable ; il ne bloque jamais seul.

**Règles côté client (obligatoires)**
1. Avant de traiter un flux, le client mémorise `previousDoc` (le document actuel).
2. Pendant `canvas_delta`, le client affiche le texte accumulé comme **brouillon** (non enregistré, non exportable).
3. Le document n'est remplacé et enregistré qu'à la réception de `canvas_set`.
4. Si le flux se termine par `error` ou se coupe sans `canvas_set` après un `canvas_start`, le client **restaure `previousDoc`** et affiche l'erreur. Jamais de demi-contrat.
5. Le client bloque l'édition manuelle du Canvas tant qu'un flux est actif.

**Annulation** : le client appelle `AbortController.abort()`. Le serveur doit détecter la fermeture de la connexion et **interrompre l'appel au LLM** (pour ne plus consommer de jetons).

### 3.4 `POST /api/export/docx`

**Requête** : `{"markdown": "...", "title": "Contrat de bail", "footer": "texte optionnel de pied de page"}`
- `markdown` obligatoire, ≤ 200 000 octets. `title` optionnel (sert au nom de fichier). `footer` optionnel, ≤ 200 caractères.

**Réponse `200`** : corps binaire, `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `Content-Disposition: attachment; filename="<slug-du-titre>.docx"`.
**Erreurs** : JSON `{"error": {"code": "...", "message": "..."}}` avec le statut HTTP de la section 4.

L'export **PDF** se fait côté navigateur (`window.print()` + feuille de style d'impression). Il n'y a pas d'endpoint PDF dans la version 1.1.

### 3.5 `POST /api/export/docx` — document hors sous-ensemble

Si le Markdown contient une construction interdite (image, lien, bloc de code,
titre de niveau 4 ou plus), la réponse est `400` avec le code
`bad_request` et un message listant les constructions fautives. Aucun `.docx`
n'est produit : le client doit corriger le document ou proposer une version
conforme, jamais livrer un fichier différent du contrat affiché.

### 3.6 `GET /api/history`

Historiques de l'utilisateur authentifié, **sans le contenu** des contrats.

- Authentification : jeton Firebase obligatoire (`uid`). Un code partagé renvoie `401`.
- Réponse `200`, `Cache-Control: no-store` :

```json
{
  "items": [
    {
      "id": "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c",
      "title": "Bail d’habitation — Yopougon",
      "contract_type": "bail-habitation",
      "version": 4,
      "created_at": "2026-10-23T10:00:00.000Z",
      "updated_at": "2026-10-23T10:05:00.000Z"
    }
  ]
}
```

- 50 éléments maximum, triés par `updated_at` décroissant.
- Les documents expirés (plus de `HISTORY_RETENTION_DAYS`, 90 jours par défaut) sont exclus.
- Si `HISTORY_ENABLED=0`, la route répond `404` avec le code `not_found`.

### 3.7 `GET /api/history/:id`

- Authentification : jeton Firebase obligatoire.
- `:id` respecte `^[A-Za-z0-9_-]{8,64}$`.
- Réponse `200`, `Cache-Control: no-store` :

```json
{
  "id": "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c",
  "title": "Bail d’habitation — Yopougon",
  "contract_type": "bail-habitation",
  "markdown": "# Bail d’habitation…",
  "version": 4,
  "messages": [
    { "role": "user", "content": "Rédige un bail pour un studio…" },
    { "role": "assistant", "content": "Voici une première version…" }
  ],
  "created_at": "2026-10-23T10:00:00.000Z",
  "updated_at": "2026-10-23T10:05:00.000Z"
}
```

- Un identifiant inconnu, expiré ou appartenant à un autre utilisateur renvoie `404` `not_found`. Le serveur ne révèle jamais l'existence d'un document d'autrui.

### 3.8 `PUT /api/history/:id`

Crée le document s'il n'existe pas, le remplace sinon (upsert).

**Requête** (`Content-Type: application/json`) :

```json
{
  "title": "Bail d’habitation — Yopougon",
  "contract_type": "bail-habitation",
  "markdown": "# Bail d’habitation…",
  "version": 4,
  "messages": [
    { "role": "user", "content": "Rédige un bail pour un studio…" },
    { "role": "assistant", "content": "Voici une première version…" }
  ]
}
```

| Champ | Règle |
|---|---|
| `id` (URL) | `^[A-Za-z0-9_-]{8,64}$`. Le client peut utiliser `crypto.randomUUID()`. |
| `title` | Chaîne non vide, 200 caractères maximum après suppression des espaces de début et de fin. |
| `contract_type` | `null` ou chaîne de 64 caractères maximum (identifiant de `/api/templates`). |
| `markdown` | Chaîne, 200 000 octets UTF-8 maximum. Peut être vide. |
| `version` | Entier de 1 à 1 000 000. |
| `messages` | Tableau de 0 à 30 éléments, rôles `user`/`assistant` alternés, `content` ≤ 8 000 caractères. Le dernier message peut être de l'un ou l'autre rôle. |

**Réponse `200`**, `Cache-Control: no-store` : `{"id": "<id>", "updated_at": "<ISO 8601>"}`.

- Chaque écriture remplace intégralement le document : un message retiré côté client ne réapparaît pas.
- Chaque écriture repousse l'expiration à maintenant + `HISTORY_RETENTION_DAYS`.
  La purge physique est assurée par la politique TTL Firestore si l'offre Blaze
  est active ; sur l'offre Spark, l'exploitant planifie `npm run purge-history`
  et les lectures traitent tout document expiré comme absent.
- Un utilisateur conserve au maximum `HISTORY_MAX_PER_USER` documents (100 par défaut). À la création d'un nouveau document au-delà de la limite, le plus ancien (`updated_at`) est supprimé.
- Un document expiré est traité comme absent et peut être recréé avec le même identifiant.

### 3.9 `DELETE /api/history/:id`

- Authentification : jeton Firebase obligatoire.
- Réponse `204`, sans corps. **Idempotent** : supprimer un document absent renvoie aussi `204`.
- La suppression est immédiate côté serveur ; la purge (TTL Firestore ou
  `npm run purge-history`) ne sert qu'aux documents non supprimés.

### 3.10 Profils d'entreprise

Chaque compte Google peut enregistrer jusqu'à **cinq profils** de son entreprise. Un profil appartient à un seul `uid` : les routes ci-dessous ne lisent et n'écrivent que sous `users/{uid}/companies/{id}` avec le SDK Admin. Aucune donnée d'entreprise n'est accessible avec le seul code partagé, et aucune n'est journalisée.

- Authentification : jeton Firebase obligatoire (`uid`). Un code partagé renvoie `401`.
- Toutes les réponses portent `Cache-Control: no-store`.
- Tous les champs métier sont facultatifs. Un profil doit toutefois contenir au moins une valeur non vide. Les valeurs sont copiées telles quelles, sans interprétation juridique.

**Champs**

| Champ | Type | Limite | Sens |
|---|---|---|---|
| `id` | string | 8 à 64 caractères `[A-Za-z0-9_-]` | Identifiant stable, choisi par le client (`crypto.randomUUID()`). |
| `label` | string | 80 | Nom affiché dans le sélecteur. À défaut, le client affiche `legal_name` ou « Mon entreprise ». |
| `legal_name` | string | 200 | Raison sociale ou dénomination. |
| `legal_form` | string | 80 | Forme juridique (SARL, SAS, EI…). |
| `capital` | string | 80 | Capital social, tel que saisi (montant et devise). |
| `rccm` | string | 80 | Numéro RCCM. |
| `tax_id` | string | 80 | Compte contribuable ou identifiant fiscal. |
| `address` | string | 300 | Adresse du siège. |
| `city` | string | 100 | Ville du siège. |
| `postal_box` | string | 100 | Boîte postale. |
| `representative_first_name` | string | 100 | Prénom du représentant. |
| `representative_last_name` | string | 100 | Nom du représentant. |
| `representative_role` | string | 120 | Qualité ou fonction du représentant. |
| `phone` | string | 50 | Téléphone de l'entreprise. |
| `email` | string | 200 | Courriel de l'entreprise. |
| `signature_place` | string | 120 | Lieu de signature habituel. |
| `logo` | string | 120 000 | Data URL d'image (`data:image/png`, `jpeg`, `webp` ou `gif`), ou chaîne vide. |
| `is_default` | boolean | — | Profil par défaut. Un profil est toujours par défaut ; le premier créé le devient automatiquement. |
| `created_at` | string | ISO 8601 | Renseigné par le serveur. |
| `updated_at` | string | ISO 8601 | Renseigné par le serveur. |

**`GET /api/company-profiles`**

Réponse `200` :

```json
{
  "items": [
    {
      "id": "6f4c2d1e-8a3b-4c5d-9e7f-0a1b2c3d4e5f",
      "label": "Ma société",
      "legal_name": "Exemple SARL",
      "legal_form": "SARL",
      "capital": "1 000 000 FCFA",
      "rccm": "CI-ABJ-2026-B-00000",
      "tax_id": "0000000 A",
      "address": "Cocody, Rue des Jardins",
      "city": "Abidjan",
      "postal_box": "01 BP 0000 Abidjan 01",
      "representative_first_name": "Awa",
      "representative_last_name": "Kone",
      "representative_role": "Gérante",
      "phone": "+225 00 00 00 00 00",
      "email": "contact@exemple.ci",
      "signature_place": "Abidjan",
      "logo": "",
      "is_default": true,
      "created_at": "2026-10-27T10:00:00.000Z",
      "updated_at": "2026-10-27T10:00:00.000Z"
    }
  ]
}
```

Jusqu'à cinq profils, le profil par défaut d'abord, puis les plus récemment modifiés. L'export des données d'entreprise se fait en téléchargeant cette réponse côté client ; il n'existe pas de route d'export serveur.

**`PUT /api/company-profiles/:id`**

Corps JSON : tous les champs métier ci-dessus sauf `id`, `created_at`, `updated_at`. `is_default` est facultatif. Les champs absents sont enregistrés vides : le client envoie donc le profil complet. Réponse `200` : `{"profile": {…}}`.

- Si le profil n'existe pas, il est créé.
- Si `is_default` vaut `true`, les autres profils du même utilisateur perdent ce marqueur.
- Retirer `is_default` au profil par défaut sans désigner un autre profil le laisse par défaut.
- Un sixième profil renvoie `400` `bad_request`.
- Un `logo` qui n'est pas une data URL d'image autorisée, ou trop long, renvoie `400` `bad_request` ou `413` `payload_too_large`.

**`DELETE /api/company-profiles/:id`**

Réponse `204`, idempotente. Si le profil supprimé était celui par défaut, le profil le plus récemment modifié devient par défaut.

**`DELETE /api/company-profiles`**

Réponse `204`, idempotente. Supprime tous les profils de l'utilisateur authentifié, et seulement les siens.

**Préremplissage déterministe à la création**

À la création d'un contrat de travail, d'apprentissage, de stage ou de télétravail, le serveur remplace lui-même les espaces réservés **côté employeur** avec le profil sélectionné (ou par défaut). Le modèle ne fournit pas ces valeurs. Les espaces réservés de l'autre partie ne sont jamais touchés.

| Espace réservé (libellé exact du squelette) | Valeur du profil |
|---|---|
| `raison sociale de l'employeur`, `raison sociale de l'entreprise d'accueil` | `legal_name` |
| `adresse du siège`, `adresse de l'employeur`, `adresse de l'entreprise` | `address`, puis `city`, puis `postal_box`, séparés par « , » |
| `nom et prénom du représentant de l'employeur`, `nom du représentant` | `representative_first_name` + `representative_last_name` |
| `qualité du représentant` | `representative_role` |
| `nom et qualité du représentant` | nom complet, puis `representative_role` |
| `lieu` (signature) | `signature_place` |

Les autres espaces réservés restent intacts et sont comptés dans `validation.placeholders`. Les valeurs sont copiées au moment de la création : modifier un profil ne modifie aucun contrat existant.

**Outils du chat**

Le chat peut lire le profil injecté et le mettre à jour avec les outils internes `get_company_profile` et `save_company_profile`. `save_company_profile` refuse toute écriture sans confirmation explicite de l'utilisateur (`confirmed: true` et message de confirmation récent) : le modèle doit d'abord poser la question. Une modification de profil ne modifie pas le document courant.

### 3.11 Disponibilité des historiques et des profils

Les quatre routes d'historique (§3.6 à §3.9) ne sont montées que si `HISTORY_ENABLED=1`. Les routes de profils (§3.10) sont montées dès que Firebase/Firestore est configuré côté serveur. Sinon, elles répondent `404` avec le code `not_found`. Elles ne sont jamais accessibles avec le seul code partagé.

## 4. Erreurs

Avant l'ouverture du flux (validation, auth, limites) : réponse JSON classique `{"error": {"code", "message"}}`.
Après l'ouverture du flux : événement SSE `error`, puis fermeture.

| Code | HTTP (avant flux) | `retryable` | Quand |
|---|---|---|---|---|
| `bad_request` | 400 | non | JSON invalide, champ manquant, rôles mal alternés |
| `unauthorized` | 401 | non | Jeton Firebase ou `X-Access-Code` absent ou invalide ; historique demandé sans identité individuelle |
| `not_found` | 404 | non | Route inconnue, historique inconnu ou expiré, fonctionnalité désactivée |
| `payload_too_large` | 413 | non | Document ou message au-delà des limites |
| `rate_limited` | 429 | oui | Trop de requêtes (en-tête `Retry-After` en secondes) |
| `storage_unavailable` | 503 | oui | Stockage des historiques ou des profils d'entreprise momentanément indisponible |
| `llm_unavailable` | 503 | oui | Modèle indisponible ou surchargé après une nouvelle tentative |
| `llm_error` | 502 | oui | Erreur du fournisseur de modèle |
| `truncated` | — (flux) | oui | Le contrat généré a été coupé par la limite de jetons ; rien n'est appliqué |
| `timeout` | — (flux) | oui | Durée maximale de traitement dépassée |
| `internal` | 500 | non | Autre erreur serveur |

Le `message` est toujours en français, lisible par l'utilisateur final, sans détail technique.

## 5. Sous-ensemble Markdown du document

**Autorisé**
- `# Titre` : un seul, en tête du document (c'est le titre du contrat).
- `## Article N – Intitulé` et `### Sous-intitulé`.
- Paragraphes ; `**gras**` ; `*italique*`.
- Listes numérotées (`1.`) pour les alinéas ; listes à puces (`-`), un niveau d'imbrication (2 espaces).
- Tableaux GFM (blocs de signatures, échéanciers).
- `---` : filet horizontal.
- `<!-- pagebreak -->` : saut de page.
- Espace réservé : `[À COMPLÉTER : description courte]` (exactement ce format ; la description ne contient pas le caractère `]`).

**Interdit** (le serveur le signale en `validation.issues`, le frontend l'affiche en texte brut) : HTML autre que `<!-- pagebreak -->`, images, liens, blocs de code, titres de niveau 4 et plus, notes de bas de page, listes de tâches.

## 5 bis. Extension protocole agent

`AGENT-PROTOCOL.md` (racine du dépôt) **étend** le présent contrat de façon
strictement additive : il ajoute des événements (`phase`, `plan`, `step`,
`ask_user`, `tool_start`, `tool_end`, `sources`, `suggestions`, `thinking_*`,
`retry`, `warning`), l'enveloppe commune `seq` / `t` sur chaque `data:`, et
deux valeurs supplémentaires de `stop_reason` (`awaiting_input`, `cancelled`).

Aucun événement décrit aux §3.3 n'est modifié : le client qui ignore les
événements inconnus continue de fonctionner. Les codes d'erreur
`cancelled`, `conflict` et `content_filtered` s'ajoutent à ceux du §4.

En cas de divergence, le présent contrat reste la référence pour les
événements qu'il décrit ; `AGENT-PROTOCOL.md` fait foi pour les événements
qu'il ajoute.

## 6. Exemple de flux complet

```
event: ready
data: {"request_id":"req_8f2c"}

event: status
data: {"phase":"template","label":"Chargement du modèle de bail…"}

event: text_delta
data: {"text":"Je prépare votre contrat. "}

event: canvas_start
data: {"mode":"create","title":"Contrat de bail à usage d'habitation","contract_type":"bail-habitation"}

event: canvas_delta
data: {"text":"# Contrat de bail à usage d'habitation\n\nEntre les soussignés :\n\n"}

event: canvas_set
data: {"mode":"create","markdown":"# Contrat de bail ...","version":1,"title":"Contrat de bail à usage d'habitation","contract_type":"bail-habitation","validation":{"placeholders":8,"issues":[]}}

event: text_delta
data: {"text":"V1 prête : 8 champs restent à compléter (parties, durée, dépôt de garantie, préavis)."}

event: done
data: {"stop_reason":"end_turn","usage":{"input_tokens":5120,"output_tokens":2480}}
```

## 7. Limites par défaut (configurables côté serveur)

- Corps de requête : 1 Mo maximum.
- Durée maximale d'un flux : **240 secondes**. Les modèles de la chaîne sont des modèles à raisonnement : une génération complète dépasse 120 s.
- `/api/chat` : 30 requêtes par heure et par identité (ou par IP si aucune identité). `/api/export/docx` : 10 par minute et par identité (ou par IP).
- `/api/history/*` : 60 requêtes par minute et par `uid`. `/api/company-profiles/*` : 60 requêtes par minute et par `uid`.
- Historiques : 50 éléments dans la liste, 100 documents maximum par utilisateur, 200 000 octets de Markdown, 30 messages de 8 000 caractères maximum, conservation de 90 jours.
- Profils d'entreprise : 5 profils maximum par utilisateur, 120 000 caractères maximum pour le logo, 1 Mo maximum pour le corps de la requête.
- Toute limite dépassée renvoie le code `rate_limited` (429) ou `payload_too_large` (413) selon le cas.

## 8. Intégration Google, historiques et profils — résumé pour le frontend

1. L'authentification se fait **côté navigateur** avec le SDK Firebase JS (Google). Le backend ne redirige pas vers Google et ne pose pas de cookie de session.
2. Le front envoie l'ID token dans `Authorization: Bearer …` à chaque requête `/api/*`. Le code partagé (`X-Access-Code`) reste accepté uniquement en mode `hybrid` ou `code`.
3. Les historiques ne sont disponibles qu'après connexion Google et si le serveur a `HISTORY_ENABLED=1`. Le front peut les désactiver entièrement si `/api/history` répond `404` `not_found`.
4. Sauvegarde : générer un identifiant avec `crypto.randomUUID()`, puis `PUT /api/history/<id>` à chaque modification significative (pas à chaque frappe). Le serveur remplace le document et repousse l'expiration.
5. Au chargement, `GET /api/history` pour la liste, puis `GET /api/history/<id>` au clic. Afficher la date `updated_at` et proposer la suppression via `DELETE`.
6. Le front doit informer l'utilisateur que ses contrats sont conservés côté serveur pendant 90 jours (paramétrable) et peuvent être supprimés à tout moment. Cette information ne remplace pas une politique de confidentialité validée.
7. En cas de `401` : rafraîchir le jeton une fois, puis déconnecter. En cas de `503` `storage_unavailable` : proposer de réessayer, sans perdre le document local.
8. Le document reste la source de vérité du front : un historique est un **snapshot** et ne doit jamais écraser silencieusement une version locale plus récente.
9. Profils : `GET /api/company-profiles` au démarrage, après connexion Google et après un enregistrement par le chat. Le front affiche le profil par défaut et permet d'en choisir un autre lors de la création d'un contrat.
10. Le front envoie le profil choisi dans `company_profile_id` à chaque `POST /api/chat`. L'identifiant seul transite ; les valeurs restent côté serveur. Le front ne doit pas envoyer le contenu du profil dans l'historique de messages.
11. Le front ne demande jamais à l'utilisateur une information déjà présente dans le profil sélectionné. Il peut toujours signaler qu'un champ reste à compléter dans le contrat.
12. Le front propose dans « Mon entreprise » l'export (téléchargement du JSON de `GET /api/company-profiles`) et la suppression (`DELETE /api/company-profiles`). Il précise que ces données sont stockées sur le compte et supprimables à tout moment, et invite à ne pas enregistrer les données personnelles des autres parties.
