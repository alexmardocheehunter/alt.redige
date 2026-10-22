# alt.redige — Audit complet de l'application

**Date** : 22 octobre 2026
**Objet** : l'application dans son ensemble — l'agent de rédaction, son
interface, le corpus juridique, l'exploitation — et **toutes ses
interactions**.
**Méthode** : lecture du code, exécution de la suite de tests, capture du
contexte réellement envoyé au modèle, campagne d'évaluation contre le vrai
modèle. Chaque affirmation est vérifiable dans le dépôt ; ce qui n'est pas
résolu est signalé comme tel.

---

## 1. Verdict

| Domaine | État | Réserve |
|---|---|---|
| Architecture, stack, outillage | **terminé** | — |
| API HTTP + flux SSE | **terminé** | contrat mis à jour (C1–C5) |
| Boucle agentique, outils, garde-fous | **terminé** | 12 garde-fous |
| Corpus juridique (11 modèles + référentiel) | **terminé** | relecture juriste jamais faite |
| Filtre de sécurité | **fonctionnel** | `advisory` par défaut : journalise, ne bloque pas |
| Interface | **branchée, pas finale** | le front v2 n'est pas livré |
| Comportement réel du modèle | **partiellement conforme** | 4 à 7/10 en évaluation réelle |
| Mise en production | **non** | clé à tourner, hébergeur à choisir, conformité à informer |

**Phrase de synthèse** : la mécanique est complète et testée ; ce qui n'est pas
prouvé, c'est la qualité du contrat que le modèle produit réellement, et
l'interface finale.

---

## 2. Ce que fait l'agent

### 2.1 Le principe

L'agent ne rédige pas dans le chat. Il rédige **dans le document** (le « Canvas »),
via les outils. Le chat ne sert qu'à poser des questions et à expliquer. Le
document est la seule source de vérité : le modèle reçoit le document courant à
chaque tour et ne doit jamais se fier à sa mémoire de la conversation.

### 2.2 Le tour, étape par étape

```
1. Le client envoie : messages[], document {markdown, version}, contract_type, answers[]
2. Le garde-fou de sécurité classe le dernier message utilisateur
      → si "unsafe" et hors domaine : HTTP 400 avant l'ouverture du flux
3. Le serveur compose le contexte :
      system   = prompts/system.fr.md + catalogue des 11 types
      messages = historique tronqué + dernier message utilisateur
                 (<document_courant> + <type_choisi> + <modele_contrat> + <demande_utilisateur>)
      tools    = les 5 outils
4. L'appel au modèle part en flux SSE ; le serveur relaie :
      phase / plan / step / tool_start / tool_end / thinking_* / retry / warning
      text_delta   → texte de la bulle du chat (filtré : jamais le contrat)
      canvas_delta → brouillon du document (non exportable)
      canvas_set   → document définitif, versionné, validé
      ask_user     → question ; le tour s'arrête
      clause_explained → explication d'une clause
5. Les outils s'exécutent, leurs résultats repartent au modèle, la boucle
   recommence — 6 étapes au maximum (MAX_STEPS)
6. done(end_turn) | done(awaiting_input) | error
```

### 2.3 Les cinq outils

| Outil | Entrée | Effet |
|---|---|---|
| `get_template` | `contract_type` | Renvoie squelette, champs, notes juridiques du modèle de référence. **N'est plus appelé quand le type est connu** : le bloc `<modele_contrat>` est déjà dans le contexte. |
| `create_canvas` | `title`, `contract_type`, `markdown`, `replace?` | Écrit le contrat complet. `replace: true` pour tout recommencer. |
| `edit_canvas` | `edits: [{old_str, new_str}]` (1 à 20) | Remplace des chaînes exactes, uniques dans le document. Tout ou rien. |
| `ask_user` | `question`, `kind`, `options?`, `fields?` | Pose une question ; le tour s'arrête sur `done(awaiting_input)`, la réponse arrive au tour suivant. |
| `explain_clause` | `article`, `quote`, `explanation`, `obligations?`, `risks?`, `depends_on?` | Explique une clause à partir du texte **présent** dans le document. Contrôlé avant émission. |

### 2.4 Le contexte réellement envoyé

Capturé sur le réseau (serveur local parlant le protocole OpenRouter), pas
reconstruit — voir `docs/CONTEXTE-MODELE.md` et `docs/contexte-modele/`.

| Élément | 1re question | 2e question |
|---|---|---|
| `system` | 8 087 car. | 8 087 car. (identique) |
| `messages` | 2 | 4 |
| message utilisateur | 3 666 car. (avec le modèle de contrat) | 2 125 car. (avec le document) |
| `tools` | 5 | 5 |
| `model` | `minimax/minimax-m3.1-flash:free` | idem |
| `max_tokens` | 16 000 | 16 000 |

Le prompt système est un **fichier Markdown** (`prompts/system.fr.md`, 7 Ko,
35 lignes), pas un JSON : rôle, déroulé, règles non négociables, règles
d'écriture des références juridiques, puis le catalogue des types. Le reste est
du JSON OpenAI-compatible.

---

## 3. Les interactions, une par une

### 3.1 L'utilisateur envoie un message

| Étape | Qui | Ce qui se passe |
|---|---|---|
| 1 | client | `POST /api/chat` : `{messages, document, contract_type, answers}` + `X-Request-Id` (+ `X-Access-Code`) |
| 2 | serveur | quotas, corps ≤ 1 Mo, code d'accès, arrêt en cours |
| 3 | serveur | `ready` (`request_id`) — **toujours le premier événement** |
| 4 | serveur | garde-fou de sécurité sur le dernier message |
| 5 | serveur | composition du contexte (système, historique, document, modèle de contrat) |
| 6 | modèle | appel en flux, avec les 5 outils |
| 7 | serveur | relais des événements de progression |
| 8 | modèle | appel d'outil(s) |
| 9 | serveur | exécution de l'outil, garde-fous, `canvas_set` si le document change |
| 10 | modèle | dernier tour : réponse en texte |
| 11 | serveur | `done(stop_reason, usage)` — **toujours le dernier événement** |

### 3.2 L'agent pose une question

| Qui | Ce qui se passe |
|---|---|
| modèle | appelle `ask_user` |
| serveur | **une seule question par tour** : au-delà, l'appel est refusé |
| serveur | émet `ask_user` avec `question_id`, `kind`, `question`, `why`, `blocking`, `allow_other`, `options` ou `fields` |
| serveur | émet `done(stop_reason: "awaiting_input")` **immédiatement après** |
| client | affiche la carte de question ; l'utilisateur répond |
| client | renvoie un **nouveau** `POST /api/chat` : le texte de la réponse dans `messages`, et `answers` (structuré) en complément |
| serveur | l'agent reçoit la réponse au tour suivant, comme un message ordinaire |

`answers` n'est jamais la source unique : le texte lisible reste dans
`messages`, comme le veut le protocole.

### 3.3 L'agent modifie le contrat

| Qui | Ce qui se passe |
|---|---|
| modèle | appelle `edit_canvas` avec 1 à 20 remplacements |
| serveur | chaque `old_str` doit être **présent et unique** ; sinon tout est refusé |
| serveur | garde-fou : un article disparu → refus ; trop de blocs touchés → refus |
| serveur | garde-fou : une mention normative hors référentiel → refus |
| serveur | **renumérotation** : les `## Article N` sont renumérotés à la suite, les renvois internes suivent |
| serveur | `canvas_start(mode: "edit")` puis `canvas_set(mode: "edit", edits_applied)` |
| client | le document est remplacé, la version est incrémentée, un toast « Annuler » est proposé |

### 3.4 L'utilisateur édite le contrat à la main

| Qui | Ce qui se passe |
|---|---|
| client | le champ Markdown est éditable ; le texte est renvoyé tel quel au tour suivant |
| serveur | le document reçu **fait foi** : il est renvoyé dans `<document_courant>` et sert de base à toute modification |
| serveur | garde-fou : un article supprimé par l'utilisateur n'est pas « perdu » au sens de l'outil — mais une modification IA qui le supprime, elle, est refusée |

### 3.5 L'utilisateur annule

| Qui | Ce qui se passe |
|---|---|
| client | `AbortController.abort()` |
| serveur | l'abort est propagé à l'appel au modèle (≤ 2 s) |
| serveur | **aucun** `canvas_set` n'est émis après l'annulation |
| client | le document précédent est conservé, le brouillon est jeté |

### 3.6 L'utilisateur exporte

| Qui | Ce qui se passe |
|---|---|
| client | `POST /api/export/docx` : `{markdown, title, footer}` |
| serveur | document vide → 400 ; corps > 200 Ko → 413 |
| serveur | **construction interdite dans le document → 400** : aucun `.docx` n'est produit |
| serveur | conversion en Word (A4, Times New Roman 11 pt, pied de page « Page X / Y ») |
| client | téléchargement du `.docx` ; le nom vient de `Content-Disposition` |
| client | le PDF passe par `window.print()` : **aucun endpoint PDF** |

### 3.7 Le client se trompe ou l'utilisateur se trompe

| Cas | Réponse |
|---|---|
| JSON invalide, rôles non alternés, dernier message ≠ `user` | 400 `bad_request` |
| message > 8 000 caractères, document > 200 000 octets, corps > 1 Mo | 413 `payload_too_large` |
| code d'accès absent ou faux | 401 `unauthorized` |
| trop de requêtes | 429 `rate_limited` + `Retry-After` |
| fournisseur saturé | 503 `llm_unavailable`, puis bascule de modèle |
| contrat coupé par la limite de jetons | `error` `truncated`, **rien n'est appliqué** |
| délai dépassé | `error` `timeout` |
| flux coupé par le client | restauration du document par le client |

---

## 4. Les garde-fous

Ils sont côté serveur. Un garde-fou qui laisse passer est un bug ; un garde-fou
qui bloque tout est un incident.

| # | Garde-fou | Déclencheur | Effet |
|---|---|---|---|
| G1 | Aucune information exploitable | tous les champs obligatoires vides | `create_canvas` **refusé**, l'agent doit poser une question |
| G2 | Article disparu | une modification supprime un article | modification **refusée** (`article_lost`) |
| G3 | Modification trop large | plus de 4 blocs touchés | modification **refusée** (`too_many_changes`) |
| G4 | Référence normative absente | mention hors `legal_notes` | modification **refusée** (`unsupported_reference`) |
| G5 | Fait non fourni | montant/date/nom propre absent de la demande | **avertissement** `fact_unverified` |
| G6 | Anglicisme | mot anglais dans l'acte | avertissement `anglicism` |
| G7 | Construction interdite | image, lien, code, titre N≥4 | avertissement `forbidden_construct` — **bloque l'export Word** (400) |
| G8 | Renvoi cassé | « l'article 12 » sans article 12 | avertissement `broken_reference` |
| G9 | Numérotation | le modèle écrit un numéro d'article | le serveur **renumérote** et corrige les renvois |
| G10 | Contrat dans le chat | le texte ressemble à un contrat | le texte **n'est pas relayé**, `warning` émis |
| G11 | Explication non étayée | extrait absent, affirmation juridique, citation hors référentiel, limite absente | explication **refusée** |
| G12 | Sécurité | message ou document dangereux | selon `SAFETY_MODE` : refus d'écriture ou simple journalisation |

---

## 5. Le corpus juridique

### 5.1 Onze modèles

`data/templates/*.json` — un fichier par type, même schéma.

| Identifiant | Type | Fondement principal |
|---|---|---|
| `bail-habitation` | Bail d'habitation | Code civil, CGI (art. 169 bis, 530, 716) |
| `bail-bureau` | Bail à usage de bureau (personne publique) | Loi 77-995, décret 79-715, CGI 587-590 et 964 |
| `bail-professionnel` | Bail professionnel (local commercial) | Acte Uniforme OHADA (2010), Code civil |
| `cdd-terme-precis` | CDD à terme précis | Code du travail art. 15.3, 15.4, 15.8 |
| `cdd-terme-imprecis` | CDD à terme imprécis | Code du travail art. 15.6 (tâche précise) |
| `cdi` | CDI | Code du travail, décret 96-195 (essai), 2013-791 (SMIG) |
| `stage-ecole` | Convention de stage-école | Code du travail art. 13.11, 13.12 |
| `stage-qualification` | Stage de qualification | Code du travail art. 13.14, 13.17, 13.18 |
| `apprentissage` | Contrat d'apprentissage | Code du travail art. 13.3, décret 96-286 |
| `teletravail` | Accord de télétravail | Décret 2022-31 |
| `prestation-service` | Prestation, sous-traitance, fourniture | Code du travail art. 11.5-11.7, CGI (BNC, TVA) |

Les deux CDD sont distincts : conditions de recours, motif de tâche précise,
durée maximale de deux ans, prime de précarité de 3 %.

### 5.2 Le référentiel des sources

`data/legal-sources.json` est la **source unique** (18 entrées). Chaque entrée :
`code`, `aliases`, `country`, `status`, `to_verify`, `applies_to`.

| Statut | Signification | Nombre |
|---|---|---|
| `integrated` | texte présent et vérifié | 9 |
| `partial` | partiellement présent | 1 (annexe fiscale) |
| `not_found` | absent du corpus | 8 |

Les absents sont explicitement marqués : AUDCG (droit commercial général), loi
77-995, décret 79-715, loi 2018-575, sécurité privée, hygiène en milieu de
travail, louage du Code civil, décrets sur les stages.

**La règle qui en découle** est dans le prompt : ne jamais citer un numéro
d'article dont on n'est pas certain — écrire « en ses dispositions
applicables » ; ne pas transposer les références d'un autre pays.

### 5.3 Ce qui n'a pas été fait

- **Aucune relecture par un juriste** du texte que le modèle produit. Les règles
  sont codées, pas les réponses.
- Le corpus ne couvre pas le **bail commercial sous l'AUDCG** (lacune
  BLOQUANTE signalée dans le référentiel) ni la **signature électronique
  qualifiée**.

---

## 6. L'interface

`public/index.html` est un **fichier unique** qui porte le prototype et son
branchement. Le branchement (`public/app-api.js`, injecté par
`scripts/inject-app-api.mjs`) remplace `window.claude.use('sample')` par :

- `POST /api/chat` + décodage SSE (avec enveloppe `seq`/`t`) ;
- l'historique conforme au contrat (`{role, content}`, alternance stricte) ;
- la carte de question (`ask_user`), le bloc d'activité, les suggestions, les
  sources ;
- le rendu Markdown (gras, italique, `[À COMPLÉTER]` surlignés) ;
- l'export Word par l'API, le PDF par `window.print()` ;
- les boutons d'accueil alimentés par `GET /api/templates` ;
- le mode `?mock=1` (14 scénarios de la spec v2).

Un test de bout en bout (`test/b9-bout-en-bout.test.ts`) lève un serveur
OpenRouter local et exerce tout le chemin de production sur une vraie socket.

**Ce qui manque** : le front v2 décrit par `SPEC-FRONTEND.md` (carte de question
native, rendu Markdown natif, `?mock=1` complet, recherche et partage). Le
branchement actuel est un adaptation minimale du prototype.

---

## 7. Les tests

| Famille | Objet | Fichiers |
|---|---|---|
| `b1`–`b3` | squelette, édition, validation, modèles | 4 |
| `b4`–`b6` | flux SSE, outils, export, évaluations | 6 |
| `b7`–`b9` | durcissement, numérotation, OpenRouter, sécurité, bout en bout | 7 |
| `b10`–`b13` | corpus, règles, référentiel, nouveaux garde-fous, calibrage | 7 |
| `c1`–`c6` | interface, branchement, démarrage, UI agent | 6 |
| **Total** | | **27 fichiers de test, 261 tests** |

`npm run typecheck` sans erreur, `npm run build` sans erreur, `npm run eval
-- --smoke` à 10/10.

---

## 8. L'évaluation réelle

Campagne exécutée contre le vrai modèle, trois fois.

| Exécution | Au vert |
|---|---|
| run 1 | 4/10 (scénarios 01, 02, 03, 10) |
| run 2 | 5/10 (+ 07, 09) |
| run 3 | 4/10 (01, 02, 03, 10) |

Avant les garde-fous : **1/10**. Les trois échecs récurrents étaient
structurels ; **ils ont été corrigés depuis** :

| Scénario | Cause | Correction |
|---|---|---|
| 04, 05, 06 | `unchanged_sections` reprenait les intitulés de l'ancien modèle de bail | remplacé par la comparaison **par blocs** (la méthode de la spécification), insensible au renumérotage |
| 08 | l'assertion ne lisait que `text_delta`, pas la charge utile de `ask_user` | nouvelle assertion `ask_user_contains`, qui lit la question et ses options |
| 09 | le contrôle de citation confondait les renvois internes (« l'article 3 ») et les citations | `findLegalCitations` distingue les deux : renvoi interne ignoré, citation contrôlée |

Reste un **vrai défaut**, corrigé depuis : le modèle écrivait 1 127 caractères
de contrat dans le chat (scénario 09). Le prompt l'interdit désormais
explicitement, et un **garde-fou serveur** (G10) filtre le texte : un texte
qui ressemble à un contrat n'est pas relayé, un `warning` est émis.

**La campagne doit être rejouée** pour mesurer l'effet de ces corrections.

Le mode **smoke** reste à 10/10, mais il ne mesure rien du modèle : il rejoue
des réponses écrites à l'avance. Il est étiqueté « non concluant » partout.

---

## 9. L'exploitation

| Variable | Défaut | Rôle |
|---|---|---|
| `OPENROUTER_API_KEY` | *(obligatoire)* | Clé du fournisseur |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API |
| `OPENROUTER_SITE_URL` | *(vide)* | URL du site, envoyée en `HTTP-Referer` |
| `OPENROUTER_APP_TITLE` | `LexCanvas` | Envoyé en `X-Title` |
| `LLM_MODELS` | `minimax/…-flash:free,nvidia/…-super-vl:free` | Chaîne de bascule |
| `LLM_MODEL` | *(vide)* | Alias : force le modèle principal en tête |
| `LLM_SAFETY_MODEL` | `nvidia/…-content-safety:free` | Gardien |
| `SAFETY_CHECK` | `1` | Coupe le gardien |
| `SAFETY_MODE` | `advisory` | `off` / `advisory` / `block` |
| `MAX_STEPS` | `6` | Itérations de la boucle |
| `MAX_OUTPUT_TOKENS` | `16 000` | Budget par appel (raisonnement compris) |
| `MAX_HISTORY_MESSAGES` | `12` | Troncature de l'historique |
| `MAX_EDIT_CHANGED_BLOCKS` | `4` | Limite d'ampleur d'une modification |
| `REQUEST_TIMEOUT_MS` | `240 000` | Durée max d'un flux |
| `RATE_CHAT_PER_HOUR` | `30` | Quota chat |
| `RATE_EXPORT_PER_MIN` | `10` | Quota export |
| `MAX_BODY_BYTES` | `1 048 576` | Corps max |
| `ACCESS_CODE` | *(vide)* | Code d'accès partagé |
| `PORT` | `3000` | Port d'écoute |
| `LOG_LEVEL` | `info` | Niveau de logs |
| `TRUST_PROXY` | `0` | Lire l'IP dans `X-Forwarded-For` |
| `ALLOWED_ORIGIN` | *(vide)* | Front séparé en développement |
| `EXPORT_FOOTER` | *(vide)* | Pied de page des exports |

Le serveur est **sans état** : ni base, ni session, ni historique. Tout vit
dans le navigateur (`localStorage`).

Démarrage : `npm install` → `cp .env.example .env` → `npm start` (compile puis
lance). Le serveur annonce son URL et, si le port est occupé, donne un message
explicite au lieu d'une pile d'exécution.

**Sur cette machine**, le port 3000 est pris par un autre projet (serveur Astro)
: `.env` utilise `PORT=3123` → `http://localhost:3123`.

---

## 10. Sécurité et conformité

| Mesure | État |
|---|---|
| Code d'accès (`X-Access-Code`, comparaison à temps constant) | en place |
| Quotas par IP et par identité, fenêtre glissante | en place |
| Limite de corps, de flux, de jetons, d'étapes | en place |
| CSP stricte, nonce par réponse | en place |
| En-têtes `nosniff`, `no-referrer`, `frame-ancestors` | en place |
| **Aucun contenu de contrat ni de message dans les journaux** | en place (liste de clés interdites) |
| Capture du contexte sur demande (`LLM_DEBUG_DIR`) | en place, dossier ignoré par git |
| Information de l'utilisateur sur le transfert hors UEMOA/CEDEAO | **à faire** (`docs/NOTE-CONFORMITE-DONNEES.md` §4) |
| Clé API | **à tourner** : elle a été partagée en clair dans une conversation |

---

## 11. Les décisions prises

| # | Sujet | Décision |
|---|---|---|
| C1 | Durée de flux | **240 s** — le contrat a été mis à jour : les modèles sont à raisonnement, 120 s coupait des générations complètes |
| C2 | `canvas_set.validation.fields` | **ajouté** : champs obligatoires et facultatifs, avec leur état de remplissage |
| C3 | `canvas_set.legal_notice` | **ajouté** : l'avertissement de revalidation est structuré |
| C4 | `clause_explained` | **implémenté** : outil + événement, avec les garde-fous de `docs/SPEC-EXPLICATION-CLAUSES.md`. Le contenu juridique des explications reste à valider par un juriste |
| C5 | Export hors sous-ensemble | **documenté** dans le contrat : 400 `bad_request`, aucun `.docx` produit |
| C6 | `llm_error` / `llm_unavailable` | messages distincts, contrat inchangé |

Hors de portée de la V1 (README §11) : audit d'un contrat importé, comptes et
paiement, base de données, historique serveur, PDF serveur, multilingue, tests de
charge.

---

## 12. Ce qui reste à faire, par priorité

| Priorité | Action | Qui |
|---|---|---|
| **P0** | Tourner la clé OpenRouter (elle a été exposée en clair) | Alex |
| **P0** | Rejouer la campagne réelle pour mesurer les corrections (chat, assertions) | dev |
| **P1** | Livrer le front v2 et réécrire le branchement | Alex / front |
| **P1** | Relecture juridique du texte produit par le modèle | juriste |
| **P1** | Calibrer le filtre de sécurité sur un échantillon réel, puis passer `SAFETY_MODE=block` | dev + Alex |
| **P2** | Information de conformité à l'utilisateur | Alex |
| **P2** | Hébergeur, domaine, pipeline de déploiement | Alex |
| **P2** | Rotation des identités : `AccessVerifier` → jeton individuel | dev |

---

## 13. Carte des fichiers

```
prompts/system.fr.md          le prompt système (rôle, déroulé, règles, catalogue)
data/templates/*.json         11 modèles de contrat
data/legal-sources.json       le référentiel des sources (source unique)
data/safety-sample.json       l'échantillon de calibrage du gardien (référence humaine)
public/index.html             l'interface (fichier unique) + branchement injecté
scripts/inject-app-api.mjs    injecte le branchement dans la page
scripts/build.mjs             copie le convertisseur Word dans dist/
scripts/dump-contexte.ts      capture le contexte réellement envoyé au modèle
scripts/calibrage-securite.ts mesure le gardien sur l'échantillon relu
src/
  server.ts                   démarrage, arrêt propre
  app.ts                      middlewares, CSP, montage des routes
  config.ts                   variables d'environnement (zod)
  llm.ts                      client OpenRouter, bascule, retries
  llm-debug.ts                capture du contexte (LLM_DEBUG_DIR)
  safety.ts                   gardien de sécurité
  legal-sources.ts            lecture du référentiel
  templates.ts                chargement des modèles
  agent/loop.ts               la boucle agentique
  agent/tools.ts              les 5 outils et les garde-fous
  agent/prompt.ts             system prompt, <document_courant>, <modele_contrat>
  agent/progress.ts           phase, plan, étapes, sources, suggestions
  agent/chat-guard.ts         le contrat ne doit pas être écrit dans le chat
  agent/events.ts             types des événements SSE
  agent/json-partial.ts       extraction du JSON partiel des arguments d'outil
  doc/validate.ts             sous-ensemble Markdown, articles, règles
  doc/edit.ts                 édition atomique tout ou rien
  doc/structure.ts            articles, renumérotation, renvois
  doc/facts.ts                faits non fournis par l'utilisateur
  doc/references.ts           garde-fou de citations
  doc/lexical.ts              anglicismes
  doc/required-fields.ts      champs obligatoires renseignés ou non
  doc/explanation.ts          explication de clause : contrôles
  export/docx.ts              enveloppe TypeScript du convertisseur
  export/export-docx.mjs      le convertisseur (référence, étendu)
  middleware/                 requestId, requestLogger, auth, rateLimit, csp
  routes/                     chat, export, meta
evals/                        10 scénarios, assertions, mode smoke
test/                         27 fichiers de test
docs/                         15 documents (audit, exploitation, contrat, décisions…)
reference/                    originaux : contrats types, référentiel juridique
```

---

## 14. Comment reproduire les mesures

```bash
npm test                        # 255 tests
npm run typecheck
npm run build

# contexte réellement envoyé au modèle
npx tsx scripts/dump-contexte.ts          # → docs/contexte-modele/*.json
LLM_DEBUG_DIR=tmp/contexte npm start     # → chaque requête sortante, en direct

# évaluation
npm run eval -- --smoke         # 10/10, ne mesure pas le modèle
npm run eval                    # contre le vrai modèle
```
