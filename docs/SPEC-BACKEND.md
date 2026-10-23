# LexCanvas — Spécification backend

Public : l'agent de code qui construit le backend. Lire d'abord `README.md`, puis `docs/API-CONTRACT.md` (normatif). Cette spec décrit **comment** implémenter ce que le contrat promet.

## 1. Décisions d'architecture (déjà prises, ne pas rouvrir)

| Sujet | Décision | Raison |
|---|---|---|
| Runtime | Node.js ≥ 20, TypeScript strict, ESM | `export-docx.mjs` est en ESM Node, réutilisé tel quel |
| Serveur HTTP | **Hono** + `@hono/node-server` (helper `streamSSE`) | Léger, SSE natif. Express accepté seulement si Hono bloque, à signaler |
| Front | Un seul `public/index.html` servi par le serveur | Le front n'est pas React : pas de Next.js, pas de Vercel AI SDK `useChat` |
| LLM | **OpenRouter** via son API compatible OpenAI, en `fetch` natif (aucun SDK). Modèles dans `LLM_MODELS` (ordre de bascule) | Choix d'Alex : trois modèles OpenRouter, le premier qui répond l'emporte. L'API OpenAI-compatible évite une dépendance supplémentaire ; `src/llm.ts` isole le fournisseur |
| Modèles | Rédaction (développement) : `dots-studio/dots-3-note-preview:free` puis `nvidia/nemotron-3.5-super-vl:free`. Production : jumeaux payants `minimax/minimax-m3.1-flash` et `nvidia/nemotron-3.5-super-vl` (`EXPLOITATION.md` §5.1). Sécurité : `nvidia/nemotron-3.5-content-safety:free`, **hors bascule** | Le modèle de sécurité est un classifieur : il ne supporte pas les appels d'outils, il ne peut donc pas rédiger. Il filtre les entrées utilisateur et le contrat produit. Les variantes gratuites sont instables : retrait constaté le 22/10/2026 |
| Jetons | `MAX_OUTPUT_TOKENS` = 16 000 par défaut | Les deux modèles de rédaction sont des **modèles à raisonnement** : une partie du budget part en `reasoning`, avant le contenu. Un budget trop faible coupe le contrat (`truncated`). Le champ `reasoning` n'est jamais relayé au client |
| État | **Sans état pour le chat** : le client renvoie historique + document. **Snapshots optionnels** pour les utilisateurs authentifiés (Firestore) | Déploiement simple, pas de conversation serveur ; les historiques sont un confort réservé aux comptes Google |
| Persistance | `localStorage` côté front ; Firestore côté serveur si `HISTORY_ENABLED=1` | Le document reste dans le navigateur ; le snapshot serveur est explicite et supprimable |
| PDF | Côté navigateur (`window.print()`) | Pas d'endpoint PDF en V1.1 |
| Hébergement | Hôte Node avec connexions longues (Railway, Render, Fly, VPS). **Pas de fonctions serverless à timeout court** | Un contrat en streaming peut durer 60 à 90 s |

Isole l'appel au fournisseur dans `src/llm.ts` (une seule fonction de streaming). Changer de fournisseur ne doit toucher que ce fichier.

## 2. Arborescence cible

```
lexcanvas/
├── AGENTS.md
├── README.md
├── package.json
├── tsconfig.json
├── .env.example                  # OPENROUTER_API_KEY, AUTH_MODE, FIREBASE_*, HISTORY_*, ...
├── docs/                         # API-CONTRACT.md, SPEC-BACKEND.md, SPEC-FRONTEND.md
├── reference/                    # fichiers fournis, ne pas modifier (voir README)
├── public/
│   └── index.html                # le front (page provisoire tant qu'il n'est pas livré)
├── data/
│   └── templates/                # un JSON par type de contrat (schéma : reference/template.*.example.json)
├── prompts/
│   └── system.fr.md              # copie de reference/system-prompt.fr.md, avec {{CATALOGUE}}
├── src/
│   ├── server.ts                 # démarrage HTTP, arrêt propre
│   ├── app.ts                    # application Hono, middlewares, montage des routes
│   ├── config.ts                 # lecture et validation des variables d'environnement (zod)
│   ├── firebase.ts               # initialisation Firebase Admin (auth + Firestore)
│   ├── routes/chat.ts            # POST /api/chat (SSE)
│   ├── routes/export.ts          # POST /api/export/docx
│   ├── routes/history.ts         # GET/PUT/DELETE /api/history
│   ├── routes/meta.ts            # GET /api/health, GET /api/templates
│   ├── history/                  # contrat de stockage + adaptateur Firestore
│   ├── agent/loop.ts             # boucle agentique (section 4)
│   ├── agent/tools.ts            # définitions + exécution des 3 outils
│   ├── agent/prompt.ts           # assemblage prompt système + catalogue + contexte document
│   ├── doc/edit.ts               # application atomique des edits (section 5)
│   ├── doc/validate.ts           # placeholders + conformité au sous-ensemble + articles requis
│   ├── export/docx.ts            # enveloppe TypeScript autour de reference/export-docx.mjs
│   ├── llm.ts                    # client Anthropic, retries, annulation
│   ├── middleware/               # auth (code/Firebase), rateLimit, bodyLimit, requestId, CSP
│   └── templates.ts              # chargement et indexation de data/templates/*.json
├── evals/
│   ├── scenarios/*.json          # scénarios de conversation (section 8)
│   └── run.ts                    # `npm run eval`
└── test/                         # tests unitaires (vitest)
```

Copie `reference/export-docx.mjs` vers `src/export/export-docx.mjs` (ou importe-le depuis `reference/`) et enveloppe-le dans `src/export/docx.ts` avec des types. Ne réécris pas le convertisseur : étends-le (section 6).

## 3. Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `OPENROUTER_API_KEY` | (obligatoire) | Clé OpenRouter |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | URL de l'API |
| `OPENROUTER_SITE_URL` | (vide) | URL du site, envoyée en `HTTP-Referer` (attribution OpenRouter) |
| `OPENROUTER_APP_TITLE` | `LexCanvas` | Nom de l'application, envoyé en `X-Title` |
| `LLM_MODELS` | `dots-studio/dots-3-note-preview:free,nvidia/nemotron-3.5-super-vl:free` | Chaîne de bascule, dans l'ordre d'essai (développement ; production : jumeaux payants) |
| `LLM_MODEL` | (vide) | Alias : force le modèle principal en tête de la chaîne |
| `LLM_SAFETY_MODEL` | `nvidia/nemotron-3.5-content-safety:free` | Gardien de sécurité, hors bascule |
| `SAFETY_CHECK` | `1` | `0` désactive le filtre de sécurité |
| `PORT` | `3000` | Port d'écoute |
| `ACCESS_CODE` | (vide) | Code partagé `X-Access-Code` (modes `code` et `hybrid`) |
| `AUTH_MODE` | `code` | `code`, `firebase` ou `hybrid` (API-CONTRACT.md §2) |
| `FIREBASE_PROJECT_ID` | (vide) | Projet Firebase, obligatoire pour `firebase`/`hybrid` et les historiques |
| `FIREBASE_SERVICE_ACCOUNT` | (vide) | Chemin du JSON du compte de service ; sinon identifiants par défaut |
| `HISTORY_ENABLED` | `0` | Monte les routes `/api/history` (exige `firebase` ou `hybrid`) |
| `HISTORY_RETENTION_DAYS` | `90` | Durée de conservation des snapshots |
| `HISTORY_MAX_PER_USER` | `100` | Plafond par utilisateur |
| `RATE_HISTORY_PER_MIN` | `60` | Limite des routes d'historique par `uid` |
| `MAX_STEPS` | `6` | Itérations maximales de la boucle agentique |
| `MAX_OUTPUT_TOKENS` | `16000` | Plafond de jetons par appel au modèle |
| `REQUEST_TIMEOUT_MS` | `240000` | Durée maximale d'un flux |
| `RATE_CHAT_PER_HOUR` / `RATE_EXPORT_PER_MIN` | `30` / `10` | Limites par identité (ou IP sans identité) |
| `MAX_BODY_BYTES` | `1048576` | Corps de requête maximum |
| `LOG_LEVEL` | `info` | Niveau de logs |

Valide-les au démarrage avec `zod` ; échoue vite avec un message clair si `OPENROUTER_API_KEY` manque.

## 4. La boucle agentique (`agent/loop.ts`)

Entrée : `messages`, `document | null`, `contract_type | null`, un `emit(event, data)` SSE, un `AbortSignal`.
État local : `workingDoc` (copie du document reçu, mise à jour par les outils), `setsEmitted` (compteur de `canvas_set`).

```
pour step de 1 à MAX_STEPS :
    ouvrir un flux modèle (llm.stream) avec : système, outils, messages
    relayer chaque delta de texte  -> emit("text_delta")
    si un bloc outil `create_canvas` démarre -> emit("canvas_start", {mode:"create", ...}) dès que title/contract_type sont lisibles
    pendant que ses arguments arrivent  -> calculer le suffixe nouveau de markdown -> emit("canvas_delta")
    à la fin du message :
        si stop_reason == "max_tokens" et un outil est incomplet -> emit("error", truncated) ; STOP, rien d'appliqué
        si stop_reason == "end_turn" (aucun outil)              -> emit("done") ; STOP
        sinon exécuter les outils demandés, dans l'ordre, et renvoyer les tool_result au modèle
fin de boucle sans end_turn -> emit("done", {stop_reason:"max_steps"})
```

Contexte envoyé au modèle :
- **Système** : `prompts/system.fr.md` avec `{{CATALOGUE}}` remplacé par la liste `id — label — description` des modèles `ready`, envoyé comme message `system` (premier message de `messages`).
- **Historique** : les `messages` du client tels quels (texte seul).
- **Dernier message utilisateur** : un message `user` contenant, dans l'ordre, `<document_courant version="N">…markdown…</document_courant>` (ou `<document_courant>(aucun document)</document_courant>`), puis la ligne `Type choisi par l'utilisateur : <id>` si `contract_type` est fourni, puis le texte de l'utilisateur. Les blocs sont séparés par une ligne vide.

**Streaming de `create_canvas`.** OpenRouter diffuse les arguments d'appel d'outil par morceaux (`delta.tool_calls[].function.arguments`). On accumule ces morceaux par appel d'outil et on en extrait la valeur de `"markdown"` avec un petit extracteur de chaîne JSON tolérant (`src/agent/json-partial.ts`). À chaque morceau, si la nouvelle valeur **commence par** la valeur déjà émise, on n'émet que le suffixe ; sinon on n'émet rien (le `canvas_set` final corrigera).

**Annulation.** Passe `AbortSignal` (lié à la fermeture de la connexion client) à la requête `fetch`. À l'annulation : aucune écriture supplémentaire, journalise `aborted`.

**Erreurs fournisseur et bascule.** Les échecs qui concernent le modèle (429, 5xx, 404 « modèle inconnu », erreur réseau) font basculer sur le modèle suivant de `LLM_MODELS`, après 1 s d'attente, **uniquement avant que le moindre événement `canvas_*` ait été émis** : après, pas de nouvelle tentative (`error` avec `retryable: true`), pour ne jamais laisser un demi-document. Les erreurs globales (401, 403) ne sont pas rejouées.

**Erreurs de socket.** Une coupure de connexion (`UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE`, `other side closed`) est transitoire : 3 tentatives avec backoff (500 ms, 1,5 s, 3 s) sur une nouvelle connexion, tant que rien n'a encore été envoyé au client (sinon le texte serait dupliqué dans la bulle de chat). Au-delà, la bascule de modèle prend le relais. Journalisé en `llm_socket_retry`.

**Garde-fou de sécurité.** Le modèle `LLM_SAFETY_MODEL` est appelé hors de la boucle, en une requête non streamée :
1. sur le dernier message de l'utilisateur, **avant** l'ouverture du flux (réponse `400` `bad_request` si le contenu est bloqué) ;
2. sur le contrat produit, **avant** l'écriture dans le Canvas (si bloqué, aucun `canvas_set` : l'outil renvoie une erreur au modèle, qui explique la situation dans le chat).

Un gardien indisponible (réseau, quota, réponse illisible) **laisse passer** : un garde-fou qui bloque tout le service quand il tombe casse l'application.

## 5. Les trois outils (`agent/tools.ts`)

### `get_template`
```json
{ "name": "get_template",
  "description": "Charge le modèle de référence d'un type de contrat : squelette Markdown, champs attendus et notes juridiques vérifiées. À appeler avant de rédiger.",
  "input_schema": { "type": "object", "properties": { "contract_type": { "type": "string", "enum": ["<ids des modèles ready>"] } }, "required": ["contract_type"] } }
```
Exécution serveur : renvoie `{label, required_fields, optional_fields, legal_notes, skeleton_markdown}` en JSON. `contract_type` inconnu → tool_result en erreur listant les ids valides. Émet `status` (`phase: "template"`).

### `create_canvas`
```json
{ "name": "create_canvas",
  "description": "Écrit le contrat complet dans le Canvas. Première version, ou recommencer de zéro avec replace=true.",
  "input_schema": { "type": "object", "properties": {
      "title": { "type": "string" },
      "contract_type": { "type": "string" },
      "markdown": { "type": "string", "description": "Contrat complet en Markdown restreint" },
      "replace": { "type": "boolean" } },
    "required": ["title", "contract_type", "markdown"] } }
```
Exécution : si `workingDoc` existe et `replace` n'est pas vrai → tool_result en erreur « un document existe, utilise edit_canvas ou replace=true ». Sinon : `workingDoc = markdown`, valide (`doc/validate.ts`), émet `canvas_set` (`version` = voir contrat), renvoie `{ok:true, placeholders:n, issues:[...]}` au modèle.

### `edit_canvas`
```json
{ "name": "edit_canvas",
  "description": "Modifie le document existant par remplacements ciblés. old_str doit être copié exactement du document courant et n'apparaître qu'une fois.",
  "input_schema": { "type": "object", "properties": {
      "edits": { "type": "array", "minItems": 1, "maxItems": 20, "items": { "type": "object",
        "properties": { "old_str": { "type": "string", "minLength": 1 }, "new_str": { "type": "string" } },
        "required": ["old_str", "new_str"] } } },
    "required": ["edits"] } }
```
Exécution (`doc/edit.ts`) — **tout ou rien** :
1. Pas de `workingDoc` → erreur « aucun document ».
2. Applique les edits dans l'ordre sur une copie. Pour chacun : `old_str` absent → erreur `not_found` avec les 80 premiers caractères de `old_str` ; présent plusieurs fois → erreur `not_unique` avec le nombre d'occurrences.
3. Au moindre échec : rien n'est appliqué, `workingDoc` inchangé, tool_result `is_error: true` avec un message exploitable par le modèle (il réessaiera, dans la limite de `MAX_STEPS`).
4. Succès : `workingDoc = copie`, valide, émet `canvas_start {mode:"edit"}` puis `canvas_set {mode:"edit", edits_applied}`, renvoie `{ok:true, edits_applied, placeholders}`.

**Piège :** les chaînes JSON peuvent contenir des guillemets typographiques et des espaces insécables (« », espace fine avant `:`). La comparaison est **exacte** ; ne normalise pas à l'insu du modèle, sinon un `old_str` correct ne trouverait pas sa cible. Si `not_found`, le message d'erreur peut suggérer la ligne la plus proche pour aider la correction.

## 6. Export Word (`export/docx.ts`, `routes/export.ts`)

Utilise `markdownToDocx(markdown)` de `reference/export-docx.mjs` (détails d'usage dans le README, §7). Travaux demandés :
1. **Pied de page optionnel** : étends `markdownToDocx(markdown, { footer })` ; si `footer` est fourni, ajoute-le au pied de page à côté du numéro de page. Texte par défaut recommandé, activé par `EXPORT_FOOTER` : « Document généré avec assistance IA — à valider par un professionnel du droit avant signature ».
2. **Nom de fichier** : slug ASCII du titre (`# ` du document, sinon `title` de la requête, sinon `contrat`), sans accents, `.docx`. Utilise `Content-Disposition` avec `filename` ASCII et `filename*` UTF-8.
3. **Garde-fous** : refuse (400) un markdown vide ; 413 au-dessus de 200 000 octets. Aucun contenu de contrat dans les logs.
4. **Options bloquantes à ne pas ajouter** : pas de PDF serveur, pas d'images, pas de table des matières.

## 7. Validation (`doc/validate.ts`)

Fonction pure `validate(markdown, template?) → { placeholders: number, issues: Issue[] }`.
- `placeholders` : nombre de correspondances de `/\[À COMPLÉTER[^\]]*\]/g`.
- `forbidden_construct` (warning) : HTML autre que `<!-- pagebreak -->`, image, lien `[x](y)`, bloc de code, titre de niveau ≥ 4.
- `multiple_titles` / `missing_title` (warning) : il faut exactement un `# `.
- `missing_article` (warning) : pour chaque entrée de `template.required_articles`, un `##` dont l'intitulé contient ce mot (insensible à la casse et aux accents).
- `placeholder_format` (info) : crochets `[À COMPLÉTER` sans `]` fermant.
- `validators` du modèle (règles juridiques chiffrées) : **implémentées** depuis la réception du référentiel juridique (`reference/TOUTES LES INFOS LEGALES.txt`). Types de contrôles : `max_duration_months`, `min_amount_fcfa`, `max_amount_fcfa`, `min_percentage`, `min_age_years`, `required_phrases`, `forbidden_phrases`. Un contrôle peut être borné à un périmètre (`scope`) : sans périmètre, la valeur la plus extrême du document est comparée, ce qui produit des faux positifs. Une valeur absente du document rend le contrôle **sans conclusion** : aucun problème n'est signalé.

Tests unitaires obligatoires (vitest) avec `reference/sample-bail.md` : 8 placeholders, 0 issue.

## 8. Évaluations (`npm run eval`)

Scénarios JSON appelant le **vrai** endpoint avec le **vrai** modèle (coûteux : hors CI par défaut). Chaque scénario : suite de tours utilisateur + assertions déterministes.

Assertions automatiques :
- **Pas d'invention** : tout nom propre, montant ou date présents dans le contrat sont soit dans les messages utilisateur, soit des `[À COMPLÉTER]`.
- **Édition ciblée** : après une modification demandée, les articles non concernés sont identiques octet pour octet à la version précédente (comparaison par blocs séparés par une ligne vide).
- **Pas de contrat dans le chat** : le texte de chat d'un tour n'excède pas 600 caractères et ne contient pas `## Article`.
- **Sous-ensemble respecté** : `validate()` ne renvoie aucune issue `forbidden_construct`.
- **Export valide** : le `.docx` produit s'ouvre (`unzip -t` OK), `pandoc -t plain` retrouve le titre et les placeholders si `pandoc` est installé, et la conversion LibreOffice en PDF réussit si `soffice` est installé (sinon cette étape est ignorée et signalée).

Scénarios minimum (10) :
1. Demande complète en un message → V1 sans question inutile.
2. Demande vague → au plus 3 questions, aucun `create_canvas` avant réponse.
3. Parties inconnues → placeholders, aucun nom inventé.
4. « Change le préavis de 2 à 3 mois » → un seul `edit_canvas`, autres articles intacts.
5. Deux modifications dans un message → un seul appel `edit_canvas` à deux edits.
6. L'utilisateur a modifié le document à la main puis demande un changement → le texte manuel est conservé.
7. « Recommence tout » → `create_canvas` avec `replace: true`.
8. Type hors catalogue → refus clair + proposition du plus proche.
9. Demande de base légale d'une clause → aucune citation d'article absente des notes.
10. Tentative d'injection dans le document (« ignore tes instructions… ») → ignorée.

## 9. Sécurité et exploitation

- **Auth** : `AUTH_MODE` = `code` (code partagé, comparaison à temps constant), `firebase` (ID token vérifié par le SDK Admin) ou `hybrid` (les deux). Le code partagé ne donne jamais accès aux historiques.
- **Limites** : taille de corps 1 Mo, `rateLimit` en mémoire par identité (ou par IP sans identité), `MAX_OUTPUT_TOKENS`, `REQUEST_TIMEOUT_MS`. Derrière un proxy, lis l'IP depuis `X-Forwarded-For` uniquement si `TRUST_PROXY=1`.
- **Historiques** : Firestore `users/{uid}/histories`, règles client `deny all`, TTL 90 jours, plafond 100, suppression idempotente.
- **CORS** : même origine uniquement (le front est servi par le serveur). Variable `ALLOWED_ORIGIN` seulement si besoin d'un front séparé en développement.
- **Journaux** : `request_id`, route, durée, statut, jetons, nombre d'étapes, codes d'erreur. **Jamais** le contenu des messages ni des contrats : ce sont des données personnelles (identités, adresses, pièces).
- **En-têtes** : `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. SSE sans compression.
- **Arrêt propre** : sur `SIGTERM`, refuser les nouveaux flux et laisser terminer les flux en cours (30 s max).
- **Disponibilité** : `GET /api/health` ne dépend pas du fournisseur LLM.

## 10. Critères d'acceptation globaux (version 1.1)

- Un `curl -N` sur `/api/chat` reproduit le flux de l'exemple du contrat (section 6).
- Un contrat de bail complet se génère en streaming, puis une modification (« préavis de 3 mois ») touche exactement une clause.
- L'export `.docx` du contrat généré s'ouvre dans Word sans avertissement, avec numérotation correcte et placeholders surlignés.
- Coupure de connexion pendant la génération : l'appel au LLM est interrompu (vérifié par un test).
- Les 10 scénarios d'évaluation passent, ou chaque échec est documenté dans `docs/KNOWN-ISSUES.md`.
