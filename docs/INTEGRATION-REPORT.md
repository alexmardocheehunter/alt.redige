# LexCanvas — Rapport d'intégration (phase C)

**Date** : 21 octobre 2026
**Périmètre** : branchement du frontend livré (`index (1).html`) sur le backend, et
mise en conformité du backend avec `AGENT-PROTOCOL.md` et
`docs/INTEGRATION-CHECKLIST.md`.

---

## 1. En résumé

| Point | État |
|---|---|
| Frontend installé et servi par `GET /` | **fait** |
| CSP compatible avec le script inline du front (nonce par réponse) | **fait** |
| Enveloppe `seq` / `t` sur chaque événement | **fait** |
| `ask_user` + `done(awaiting_input)` + `answers` en entrée | **fait** |
| `phase`, `plan`, `step` | **fait** |
| `tool_start`, `tool_end` | **fait** |
| `sources`, `suggestions` | **fait** |
| `retry` | **fait** |
| `thinking_*` | **non implémenté** (décision assumée, §5) |
| Le front appelle réellement `/api/chat` | **fait** — branchement ajouté (§3) |
| Export Word / PDF depuis le front | **fait** — Word par l'API, PDF par `window.print()` |
| Boutons de démarrage depuis `/api/templates` | **fait** — les 9 modèles publiés alimentent les boutons |
| Carte de question riche (`ask_user` en carte) | **non** — la question s'affiche dans la bulle |

Le backend est prêt et conforme au protocole. Le frontend livré **n'est pas** le
front v2 décrit par `SPEC-FRONTEND.md` : c'est le prototype, qui appelait
`window.claude.use('sample')` au lieu de `fetch('/api/chat')`. Le branchement a
donc été fait (§3) ; il reste des écarts de confort, listed en §4.

---

## 2. Ce que le backend a été modifié pour

### 2.1 Le front est installé

`index (1).html` a été repris dans `public/index.html`. Le fichier a ensuite reçu
le code de branchement (intégré, §3) et la suppression des deux scripts CDN.
`public/app-api.js` en est la source, injectée par
`scripts/inject-app-api.mjs` au moment du build.

### 2.2 Content-Security-Policy : nonce par réponse

La CSP appliquée par le serveur interdisait tout script inline
(`script-src 'self'`). Le frontend livré en contient un : la page était donc
bloquée.

Le serveur émet maintenant un **nonce par réponse** et l'injecte dans les
balises `<script>` sans `src` au moment du service. Le fichier sur le disque
reste la référence ; `GET /` renvoie le fichier plus l'attribut `nonce`.

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-…';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'
```

C'est la « modification du serveur » que la liste de contrôle mentionne
(`docs/INTEGRATION-CHECKLIST.md` §5).

**Vérifié dans un navigateur** : le script inline s'exécute (la page est
interactive), et le nonce présent dans la réponse correspond à celui de la CSP.

### 2.3 Protocole agent

`AGENT-PROTOCOL.md` est une extension **additive** du contrat d'API. Le
backend émet maintenant :

| Événement | Quand |
|---|---|
| `phase` | changement d'étape visible : `understanding` → `researching` → `planning` → `drafting` → `reviewing` → `finalizing` |
| `plan` | une fois par tour : 3 ou 4 étapes (création ou modification) |
| `step` | avancement d'une étape : `running` / `done` / `failed` / `skipped` |
| `tool_start` / `tool_end` | autour de chaque appel d'outil, avec un libellé français et un résumé du résultat — **jamais les arguments bruts** |
| `ask_user` | question posée par l'agent (déjà implémenté) |
| `sources` | sources juridiques mobilisées par le modèle (table reprise du référentiel validé, `data/legal-sources.json`) |
| `suggestions` | 2 à 4 suggestions de suite, en fin de tour |
| `retry` | relance du modèle sans fermer le flux |

L'enveloppe commune est appliquée : chaque `data:` porte `seq` (croissant par
tour) et `t` (ms depuis `ready`).

`done` est enrichi (`request_id`, `duration_ms`) et `stop_reason` accepte
`awaiting_input` en plus de `end_turn` et `max_steps`.

La requête accepte désormais `answers` (réponses structurées aux questions
posées au tour précédent) ; le texte de `messages` reste la source unique.

**Ordre des événements** (protocole §15) : `ask_user` est toujours
immédiatement suivi de `done` — la question n'est donc pas encadrée par
`tool_start`/`tool_end`.

---

## 3. Le frontend livré est le prototype — il a été branché

`index (1).html` ne contenait **aucun** appel à `/api/chat` :

- l'appel IA passait par `window.claude.use('sample')`, avec un repli local
  `demo()` ;
- les boutons de démarrage (`SUGG`, `QUICK`) étaient des listes codées en dur ;
- l'historique était dans `localStorage` (`altredige.convs`) ;
- l'écran de connexion simulait Google ;
- les boutons d'export n'avaient **aucun** gestionnaire, et la page chargeait
  `jszip` et `jspdf` depuis un CDN.

Tant que le front n'appelle pas l'API, l'application ne peut pas fonctionner.
Le branchement a donc été fait, **au strict minimum**, dans un fichier
séparé : `public/app-api.js`, injecté dans `public/index.html` par
`scripts/inject-app-api.mjs` (le front reste un fichier unique, comme l'exige
la spécification ; le nonce de la CSP autorise le script intégré).

### Ce qui a été branché

| Point | Avant | Après |
|---|---|---|
| Appel IA | `window.claude.use('sample')` | `POST /api/chat` + décodage SSE |
| Contrat produit | texte libre renvoyé par le prototype | `markdown`, `version`, `contract_type`, `answers` — le contrat d'API §3.3 |
| Historique | `{c, x}` | `{role, content}`, alternance stricte, 30 messages max |
| Annulation | — | `AbortController` + `X-Request-Id` |
| Erreurs | `demo()` silencieux | message français du serveur, `retryable` respecté |
| Code d'accès | — | `X-Access-Code`, demandé au premier 401 |
| Export Word | `JSZip` (CDN, bloqué) | `POST /api/export/docx` |
| Export PDF | `jsPDF` (CDN, bloqué) | `window.print()` + feuille `@media print` |
| Boutons d'accueil | 5 libellés codés en dur | `GET /api/templates` → les 9 modèles publiés |
| Mode `?mock=1` | — | conservé : le mode démo local répond sans serveur |
| Scripts externes | jszip + jspdf (cdnjs) | retirés (la CSP les bloquait de toute façon) |

### Ce qui a été vérifié dans un navigateur

- **Aucune erreur console.**
- La requête part vers `/api/chat` avec le corps du contrat.
- Le document s'affiche (titre, articles, paragraphes) à la réception de
  `canvas_set` ; la bulle de l'assistant affiche la réponse.
- Le second tour (une modification) renvoie l'historique `user → assistant →
  user` et le document courant — la version et le Markdown sont conformes à ce
  que le serveur attend.
- Les boutons d'accueil affichent les 9 modèles de `/api/templates`.
- Les boutons d'export sont actifs et l'export Word passe par l'API.
- Sur un appel réel, l'échec réseau vers OpenRouter est remonté en français à
  l'utilisateur (`llm_unavailable`), sans casse de la page.

---

## 4. Ce qui reste au prototype

| Écart | Conséquence |
|---|---|
| L'écran de connexion simule Google | le backend n'a pas de comptes (V1 sans base de données). Le code d'accès passe par l'en-tête `X-Access-Code`, pas par ce dialogue |
| Le document affiché est une vue en blocs | le backend est la source de vérité (Markdown) ; la page convertit pour l'affichage et reconvertit à l'envoi. La conversion perd la mise en forme fine (listes, tableaux) : le PDF imprimé est moins riche que le `.docx` |
| Pas de carte de question (`ask_user`) | la question s'affiche dans la bulle et l'utilisateur y répond dans le composeur : fonctionnel, mais pas la carte riche de la spec v2 §12.5 |
| Mode `?mock=1` incomplet | la spec v2 §15 décrit 14 scénarios de simulation ; seul le mode démo d'origine est conservé |
| `thinking_*` non exposé | décision assumée : les modèles de la chaîne sont des modèles à raisonnement, le protocole interdit d'exposer la chaîne de pensée (§5) |
| Historique : format `altredige.convs` | conservé tel quel (décision §2 de `docs/DECISIONS-PHASE-C.md`) |

---

## 5. Décisions de la phase C

Les cinq questions laissées ouvertes par `SPEC-FRONTEND.md` §17 sont
répondues dans `docs/DECISIONS-PHASE-C.md`. En résumé :

1. **Authentification** : code d'accès (`ACCESS_CODE`), pas d'OAuth — pas de
   base de données en V1 ; l'interface `AccessVerifier` est prête pour un
   jeton d'identité.
2. **Historique** : local seulement (`localStorage`). Pas d'endpoint
   `/api/conversations`.
3. **Réflexion résumée (`thinking_*`)** : désactivée par défaut. Les modèles de
   la chaîne sont des modèles à raisonnement : ce qu'ils produisent n'est pas
   un résumé, et le protocole interdit d'exposer la chaîne de pensée.
4. **`canvas_patch`** : pas en V2. `canvas_set` reste la source de vérité ;
   `canvas_start.target` permet déjà de surligner la zone concernée.
5. **Reprise après coupure** : le tour est rejoué. Le serveur est sans état ;
   l'idempotence vient de la règle de version du contrat.

---

## 6. Vérifications effectuées

| Vérification | Résultat |
|---|---|
| `npm test` | 221 tests au vert (22 fichiers) |
| `npm run typecheck` | sans erreur |
| `npm run build` | sans erreur, `dist/server.js` démarre |
| `GET /` en navigateur | page rendue, script inline exécuté, **zéro erreur console** |
| `GET /api/health` | `{ok:true, contract_version:"1.0", model:"minimax/minimax-m3.1-flash:free"}` |
| `GET /api/templates` | 9 modèles `ready` |
| `POST /api/chat` (SSE) | flux complet conforme, enveloppe `seq`/`t` comprise |
| `POST /api/export/docx` | `.docx` valide |
| `npm run eval -- --smoke` | 10/10 en mode **smoke** : le harnais est validé, pas le comportement du modèle (un modèle scripté rejoue les scénarios) |

---

## 7. Ce qui reste à faire

1. **Livrer le front v2** : il remplacera le prototype. Le branchement
   `public/app-api.js` sera alors à réécrire contre le vrai front (carte de
   question, `?mock=1` complet, rendu Markdown natif) — c'est un travail de
   front, pas de backend.
2. **Campagne `npm run eval` contre le vrai modèle** : impossible depuis la
   machine de développement (le réseau y coupe les `POST` au-delà de ~1 Ko —
   voir `docs/KNOWN-ISSUES.md`).
3. **Relecture juridique** du texte que l'IA produira : les règles sont
   codées, pas les réponses.
4. **Explications de clauses** (`docs/SPEC-EXPLICATION-CLAUSES.md`) :
   spécifiées mais **non implémentées** — deux modifications de contrat
   (`clause_explained`, `legal_notice`) attendent la validation d'Alex.
5. **Informations de conformité à l'utilisateur** (transfert vers un
   fournisseur hors UEMOA/CEDEAO) : à porter à la connaissance des
   utilisateurs — voir `docs/NOTE-CONFORMITE-DONNEES.md` §4.
