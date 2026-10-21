# LexCanvas — Spécification backend

Public : l'agent de code qui construit le backend. Lire d'abord `README.md`, puis `docs/API-CONTRACT.md` (normatif). Cette spec décrit **comment** implémenter ce que le contrat promet.

## 1. Décisions d'architecture (déjà prises, ne pas rouvrir)

| Sujet | Décision | Raison |
|---|---|---|
| Runtime | Node.js ≥ 20, TypeScript strict, ESM | `export-docx.mjs` est en ESM Node, réutilisé tel quel |
| Serveur HTTP | **Hono** + `@hono/node-server` (helper `streamSSE`) | Léger, SSE natif. Express accepté seulement si Hono bloque, à signaler |
| Front | Un seul `public/index.html` servi par le serveur | Le front n'est pas React : pas de Next.js, pas de Vercel AI SDK `useChat` |
| LLM | SDK officiel `@anthropic-ai/sdk`, modèle dans `LLM_MODEL` (défaut `claude-sonnet-5-5`) | Contrôle total du streaming et des outils |
| État | **Aucun état serveur** : le client renvoie historique + document | Déploiement trivial, pas de base de données pour la V1 |
| Persistance | `localStorage` côté front uniquement | Suffisant pour le challenge |
| PDF | Côté navigateur (`window.print()`) | Pas d'endpoint PDF en V1.0 |
| Hébergement | Hôte Node avec connexions longues (Railway, Render, Fly, VPS). **Pas de fonctions serverless à timeout court** | Un contrat en streaming peut durer 60 à 90 s |

Isole l'appel au fournisseur dans `src/llm.ts` (une seule fonction de streaming). Changer de fournisseur ne doit toucher que ce fichier.

## 2. Arborescence cible

```
lexcanvas/
├── AGENTS.md
├── README.md
├── package.json
├── tsconfig.json
├── .env.example                  # ANTHROPIC_API_KEY, LLM_MODEL, PORT, ACCESS_CODE, ...
├── docs/                         # API-CONTRACT.md, SPEC-BACKEND.md, SPEC-FRONTEND.md
├── reference/                    # fichiers fournis, ne pas modifier (voir README)
├── public/
│   └── index.html                # le front (page provisoire tant qu'il n'est pas livré)
├── data/
│   └── templates/                # un JSON par type de contrat (schéma : reference/template.*.example.json)
├── prompts/
│   └── system.fr.md              # copie de reference/system-prompt.fr.md, avec {{CATALOGUE}}
├── src/
│   ├── server.ts                 # app Hono, routes, fichiers statiques, middlewares
│   ├── config.ts                 # lecture et validation des variables d'environnement (zod)
│   ├── routes/chat.ts            # POST /api/chat (SSE)
│   ├── routes/export.ts          # POST /api/export/docx
│   ├── routes/meta.ts            # GET /api/health, GET /api/templates
│   ├── agent/loop.ts             # boucle agentique (section 4)
│   ├── agent/tools.ts            # définitions + exécution des 3 outils
│   ├── agent/prompt.ts           # assemblage prompt système + catalogue + contexte document
│   ├── doc/edit.ts               # application atomique des edits (section 5)
│   ├── doc/validate.ts           # placeholders + conformité au sous-ensemble + articles requis
│   ├── export/docx.ts            # enveloppe TypeScript autour de reference/export-docx.mjs
│   ├── llm.ts                    # client Anthropic, retries, annulation
│   ├── middleware/               # auth (ACCESS_CODE), rateLimit, bodyLimit, requestId
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
| `ANTHROPIC_API_KEY` | (obligatoire) | Clé du fournisseur |
| `LLM_MODEL` | `claude-sonnet-5-5` | Modèle utilisé |
| `PORT` | `3000` | Port d'écoute |
| `ACCESS_CODE` | (vide) | Si défini, exigé en en-tête `X-Access-Code` |
| `MAX_STEPS` | `6` | Itérations maximales de la boucle agentique |
| `MAX_OUTPUT_TOKENS` | `8000` | Plafond de jetons par appel au modèle |
| `REQUEST_TIMEOUT_MS` | `120000` | Durée maximale d'un flux |
| `RATE_CHAT_PER_HOUR` / `RATE_EXPORT_PER_MIN` | `30` / `10` | Limites par IP |
| `LOG_LEVEL` | `info` | Niveau de logs |

Valide-les au démarrage avec `zod` ; échoue vite avec un message clair si `ANTHROPIC_API_KEY` manque.

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
- **Système** : `prompts/system.fr.md` avec `{{CATALOGUE}}` remplacé par la liste `id — label — description` des modèles `ready`. Marque ce bloc, et la liste des outils, avec `cache_control` (mise en cache du prompt) si le SDK installé le supporte.
- **Historique** : les `messages` du client tels quels (texte seul).
- **Dernier message utilisateur** : deux blocs de texte. D'abord `<document_courant version="N">…markdown…</document_courant>` (ou `<document_courant>(aucun document)</document_courant>`), puis le texte de l'utilisateur. Si `contract_type` est fourni, ajoute une ligne `Type choisi par l'utilisateur : <id>`.

**Streaming de `create_canvas`.** Utilise l'événement du SDK qui expose l'instantané du JSON partiel des arguments (dans le SDK TypeScript : l'événement `inputJson`, qui fournit un `snapshot`). À chaque événement, lis `snapshot.markdown` ; si la nouvelle valeur **commence par** la valeur déjà émise, émets uniquement le suffixe ; sinon n'émets rien (le `canvas_set` final corrigera). **Vérifie le nom exact de l'événement dans la version installée du SDK** avant de coder. Si l'événement n'existe pas, solution de repli : accumule `partial_json` et extrais la valeur de `"markdown"` avec un petit extracteur de chaîne JSON tolérant.

**Annulation.** Passe `AbortSignal` (lié à la fermeture de la connexion client) au SDK. À l'annulation : aucune écriture supplémentaire, journalise `aborted`.

**Erreurs fournisseur.** Une seule nouvelle tentative (attente 1 s) sur 429 / 5xx / surcharge, uniquement **avant** que le moindre événement `canvas_*` ait été émis. Après, pas de nouvelle tentative : `error` avec `retryable: true`.

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
- `validators` du modèle (règles juridiques chiffrées) : **vide en V1**. Prévois l'emplacement, n'implémente aucune règle sans contenu validé par un juriste.

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

- **Auth** : `ACCESS_CODE` optionnel (comparaison à temps constant).
- **Limites** : taille de corps 1 Mo, `rateLimit` en mémoire par IP (fenêtre glissante), `MAX_OUTPUT_TOKENS`, `REQUEST_TIMEOUT_MS`. Derrière un proxy, lis l'IP depuis `X-Forwarded-For` uniquement si `TRUST_PROXY=1`.
- **CORS** : même origine uniquement (le front est servi par le serveur). Variable `ALLOWED_ORIGIN` seulement si besoin d'un front séparé en développement.
- **Journaux** : `request_id`, route, durée, statut, jetons, nombre d'étapes, codes d'erreur. **Jamais** le contenu des messages ni des contrats : ce sont des données personnelles (identités, adresses, pièces).
- **En-têtes** : `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. SSE sans compression.
- **Arrêt propre** : sur `SIGTERM`, refuser les nouveaux flux et laisser terminer les flux en cours (30 s max).
- **Disponibilité** : `GET /api/health` ne dépend pas du fournisseur LLM.

## 10. Critères d'acceptation globaux (version 1.0)

- Un `curl -N` sur `/api/chat` reproduit le flux de l'exemple du contrat (section 6).
- Un contrat de bail complet se génère en streaming, puis une modification (« préavis de 3 mois ») touche exactement une clause.
- L'export `.docx` du contrat généré s'ouvre dans Word sans avertissement, avec numérotation correcte et placeholders surlignés.
- Coupure de connexion pendant la génération : l'appel au LLM est interrompu (vérifié par un test).
- Les 10 scénarios d'évaluation passent, ou chaque échec est documenté dans `docs/KNOWN-ISSUES.md`.
