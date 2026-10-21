# LexCanvas — Contrat d'API (source de vérité)

Ce document est **normatif**. Le frontend (un seul fichier HTML) et le backend sont construits par deux agents différents, sans se parler. Tout ce qui n'est pas écrit ici n'existe pas. En cas de désaccord entre ce contrat et une spec, **le contrat gagne**. Toute modification du contrat se fait ici d'abord, puis dans le code.

Version du contrat : `1.0`

---

## 1. Principes

- Le serveur est **sans état** : le client envoie à chaque requête l'historique de chat et le document courant. Le document vit dans le navigateur (et `localStorage`), pas sur le serveur.
- Le chat est en **streaming SSE** sur un `POST` (donc lecture via `fetch` + `ReadableStream`, pas `EventSource`).
- Le document est un **Markdown restreint** (section 5). Ce sous-ensemble est le même pour le rendu du Canvas, l'export Word et l'impression PDF.
- Le serveur sert aussi le frontend : `GET /` renvoie `public/index.html`. Toutes les URL d'API sont donc **relatives** (`/api/...`), sans domaine codé en dur.

## 2. Authentification (optionnelle)

Si la variable d'environnement `ACCESS_CODE` est définie côté serveur, toute requête `/api/*` (sauf `/api/health`) doit porter l'en-tête `X-Access-Code: <code>`. Sinon : `401` avec le code `unauthorized`. Le frontend demande le code une fois (champ simple), le garde en `localStorage` (avec `try/catch`) et le renvoie ensuite.

## 3. Endpoints

### 3.1 `GET /api/health`
Réponse `200` : `{"ok": true, "contract_version": "1.0", "model": "<nom du modèle>"}`.

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
    ]
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

L'export **PDF** se fait côté navigateur (`window.print()` + feuille de style d'impression). Il n'y a pas d'endpoint PDF dans la version 1.0.

## 4. Erreurs

Avant l'ouverture du flux (validation, auth, limites) : réponse JSON classique `{"error": {"code", "message"}}`.
Après l'ouverture du flux : événement SSE `error`, puis fermeture.

| Code | HTTP (avant flux) | `retryable` | Quand |
|---|---|---|---|
| `bad_request` | 400 | non | JSON invalide, champ manquant, rôles mal alternés |
| `unauthorized` | 401 | non | `X-Access-Code` absent ou faux |
| `payload_too_large` | 413 | non | Document ou message au-delà des limites |
| `rate_limited` | 429 | oui | Trop de requêtes (en-tête `Retry-After` en secondes) |
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
- Durée maximale d'un flux : 120 secondes.
- `/api/chat` : 30 requêtes par heure et par IP. `/api/export/docx` : 10 par minute et par IP.
