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
| Le front appelle réellement `/api/chat` | **fait** — branchement ajouté (voir §3) |
| Export Word / PDF depuis le front | **fait** — Word par l'API, PDF par `window.print()` |
| Boutons de démarrage depuis `/api/templates` | **fait** — les 9 modèles publiés alimentent les boutons |

Le backend est prêt et conforme au protocole. **Le frontend livré n'est pas
encore le front v2** : c'est le prototype décrit par `SPEC-FRONTEND.md` §17,
qui appelle `window.claude.use('sample')` au lieu de `fetch('/api/chat')`.
L'adaptation du front n'est pas du ressort du backend (AGENTS.md : « Le front
est un fichier unique `public/index.html` que tu ne codes pas »).

---

## 2. Ce que le backend a été modifié pour

### 2.1 Le front est installé

`index (1).html` a été copié **tel quel** dans `public/index.html`. Le fichier
livré n'est pas modifié.

### 2.2 Content-Security-Policy : nonce par réponse

La CSP appliquée par le serveur interdisait tout script inline
(`script-src 'self'`). Le frontend livré en contient un : la page était donc
bloquée.

Le serveur émet maintenant un **nonce par réponse** et l'injecte dans les
balises `<script>` sans `src` au moment du service. Le fichier sur le disque
reste intact : `GET /` renvoie le fichier, plus l'attribut `nonce`.

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-…';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'
```

C'est la « modification du serveur » que la liste de contrôle mentionne
(`docs/INTEGRATION-CHECKLIST.md` §5).

**Vérifié dans un navigateur** : le script inline s'exécute (la page est
interactrice), et le nonce présent dans la réponse correspond à celui de la
CSP.

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

## 3. Écart principal : le frontend livré est le prototype

`index (1).html` ne contient **aucun** appel à `/api/chat` :

- l'appel IA passe par `window.claude.use('sample')`, avec un repli local
  `demo()` ;
- les boutons de démarrage (`SUGG`, `QUICK`) sont des listes codées en dur ;
- l'historique est dans `localStorage` (`altredige.convs`) ;
- l'écran de connexion simule Google.

La spécification v2 demande précisément l'inverse (`SPEC-FRONTEND.md` §17) :
remplacer `use()`/`demo()` par `fetch('/api/chat')` + SSE, tirer les boutons de
`/api/templates` et des `suggestions`, supprimer `JSZip`/`jsPDF`.

**Ce que le backend expose déjà pour le front v2** :

- `GET /api/templates` renvoie les **9** modèles publiés (avec `status`) ;
- `POST /api/chat` accepte `{messages, document, contract_type, answers}` et
  renvoie le flux complet du protocole ;
- `POST /api/export/docx` renvoie le `.docx` (le front n'a plus besoin de
  JSZip) ;
- l'export PDF passe par `window.print()` (le front n'a plus besoin de jspdf) ;
- `X-Request-Id` est accepté et renvoyé ;
- le code d'accès passe par l'en-tête `X-Access-Code` (le dialogue de saisie
  est prévu par la spécification §5.11).

---

## 4. Ce qui ne fonctionne pas encore côté front

### 4.1 Export Word / PDF : scripts externes bloqués

Le front charge encore deux scripts depuis un CDN :

```
https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
```

La CSP les bloque (c'est le comportement voulu, et la spécification v2 exige
« aucun script ni feuille de style externe »). Conséquence sur le prototype
livré : **les boutons d'export Word et PDF ne peuvent pas fonctionner** tant que
le front n'est pas mis à jour. Le message de la console est explicite :

> Loading the script '…/jszip.min.js' violates the following Content Security
> Policy directive: "script-src 'self' 'nonce-…'". The action has been blocked.

Le correctif est côté front : appeler `POST /api/export/docx` et
`window.print()`.

### 4.2 Les autres écarts fonctionnels

| Écart | Où |
|---|---|
| Pas d'appel à `/api/chat` | `index (1).html` — fonction `send()` |
| Boutons de démarrage codés en dur | `SUGG` / `QUICK` |
| Connexion Google simulée au lieu du code d'accès | `login` / `enter()` |
| Mode simulé `?mock=1` absent | la spécification v2 §8 et §15 l'exigent |
| Historique : format `altredige.convs` | à garder (décision §2 de `docs/DECISIONS-PHASE-C.md`) |

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
| `npm test` | 212 tests au vert (20 fichiers) |
| `npm run typecheck` | sans erreur |
| `npm run build` | sans erreur, `dist/server.js` démarre |
| `GET /` en navigateur | page rendue, script inline exécuté, **une seule erreur console** : les deux scripts CDN bloqués (§4.1) |
| `GET /api/health` | `{ok:true, contract_version:"1.0", model:"minimax/minimax-m3.1-flash:free"}` |
| `GET /api/templates` | 9 modèles `ready` |
| `POST /api/chat` (SSE) | flux complet conforme, enveloppe `seq`/`t` comprise |
| `POST /api/export/docx` | `.docx` valide |
| `npm run eval -- --smoke` | 10/10 en mode **smoke** : le harnais est validé, pas le comportement du modèle (un modèle scripté rejoue les scénarios) |

---

## 7. Ce qui reste à faire

1. **Adapter le front** : remplacer `window.claude.use()` par
   `fetch('/api/chat')` + décodage SSE, supprimer jszip/jspdf, brancher
   `/api/templates` et les `suggestions`, ajouter le mode `?mock=1`.
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
