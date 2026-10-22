# alt.redige — Audit de l'état de l'agent

**Date** : 22 octobre 2026
**Objet** : état vérifié du backend (agent de rédaction de contrats), de l'interface
et du corpus juridique, tel qu'il est réellement en dépôt.
**Méthode** : lecture du code, exécution de la suite de tests, capture du
contexte réellement envoyé au modèle, campagne d'évaluation contre le vrai
modèle. Chaque affirmation ci-dessous est vérifiable dans le dépôt ; les points
non résolus sont signalés comme tels.

---

## 1. Verdict

| Domaine | État | Réserve |
|---|---|---|
| Architecture, stack, outillage | **terminé** | — |
| API HTTP + flux SSE | **terminé** | 6 modifications de contrat proposées, non validées |
| Boucle agentique, outils, garde-fous | **terminé** | — |
| Corpus juridique (11 modèles + référentiel) | **terminé** | Relecture juriste jamais faite |
| Filtre de sécurité | **fonctionnel** | Mode `advisory` par défaut : il journalise, il ne bloque pas |
| Interface | **branchée, pas finale** | Le front v2 n'est pas livré ; le prototype reste branché |
| Comportement réel du modèle | **partiellement conforme** | 4 à 7/10 en évaluation réelle |
| Mise en production | **non** | Clé à tourner, hébergeur à choisir, conformité à informer |

**Phrase de synthèse** : la mécanique est complète et testée ; ce qui n'est pas
prouvé, c'est la qualité du contrat que le modèle produit réellement, et
l'interface finale.

---

## 2. Ce que fait l'agent

### 2.1 Le principe

L'agent ne rédige pas dans le chat. Il rédige **dans le document** (le « Canvas »),
via quatre outils. Le chat ne sert qu'à poser des questions et à expliquer. Le
document est la seule source de vérité ; le modèle reçoit le document courant à
chaque tour et ne doit jamais se fier à sa mémoire.

### 2.2 Le tour, étape par étape

```
1. Le client envoie : messages[], document {markdown, version}, contract_type, answers[]
2. Le garde-fou de sécurité classe le dernier message utilisateur
      → si "unsafe" et hors domaine : HTTP 400 avant l'ouverture du flux
3. Le serveur compose le contexte :
      system   = prompts/system.fr.md + catalogue des 11 types
      messages = historique tronqué + dernier message utilisateur
                 (<document_courant> + <type_choisi> + <modele_contrat> + <demande_utilisateur>)
      tools    = les 4 outils
4. L'appel au modèle part en flux SSE ; le serveur relaie :
      phase / plan / step / tool_start / tool_end / thinking_* / retry / warning
      text_delta   → texte de la bulle du chat
      canvas_delta → brouillon du document (non exportable)
      canvas_set   → document définitif, versionné, validé
5. Les outils s'exécutent, leurs résultats repartent au modèle, la boucle
   recommence — 6 étapes au maximum (MAX_STEPS)
6. done(end_turn) | done(awaiting_input) | error
```

### 2.3 Les quatre outils

| Outil | Entrée | Effet |
|---|---|---|
| `get_template` | `contract_type` | Renvoie squelette, champs, notes juridiques du modèle de référence. **N'est plus appelé quand le type est connu** (le bloc `<modele_contrat>` est déjà dans le contexte). |
| `create_canvas` | `title`, `contract_type`, `markdown`, `replace?` | Écrit le contrat complet. `replace: true` pour tout recommencer. |
| `edit_canvas` | `edits: [{old_str, new_str}]` (1 à 20) | Remplace des chaînes exactes, uniques dans le document. Tout ou rien. |
| `ask_user` | `question`, `kind`, `options?`, `fields?` | Pose une question ; le tour s'arrête sur `done(awaiting_input)`, la réponse arrive au tour suivant. |

### 2.4 Le contexte réellement envoyé

Capturé sur le réseau (serveur local parlant le protocole OpenRouter), pas
reconstruit — voir `docs/CONTEXTE-MODELE.md` et `docs/contexte-modele/`.

| Élément | 1re question | 2e question |
|---|---|---|
| `system` | 8 087 car. | 8 087 car. (identique) |
| `messages` | 2 | 4 |
| message utilisateur | 3 666 car. (avec le modèle de contrat) | 2 125 car. (avec le document) |
| `tools` | 4 | 4 |
| `model` | `minimax/minimax-m3.1-flash:free` | idem |
| `max_tokens` | 16 000 | 16 000 |

Le prompt système est un **fichier Markdown** (`prompts/system.fr.md`, 7 Ko,
35 lignes), pas un JSON : rôle, déroulé, règles non négociables, règles
d'écriture des références juridiques, puis le catalogue des types. Le reste est
du JSON OpenAI-compatible.

---

## 3. Les garde-fous

Ils sont côté serveur, dans `src/agent/tools.ts` et `src/doc/`. Un garde-fou qui
laisse passer est un bug ; un garde-fou qui bloque tout est un incident.

| # | Garde-fou | Déclencheur | Effet |
|---|---|---|---|
| G1 | Aucune information exploitable | tous les champs obligatoires vides | `create_canvas` **refusé**, l'agent doit poser une question |
| G2 | Article disparu | une modification supprime un article | modification **refusée** (`article_lost`) |
| G3 | Modification trop large | plus de 4 blocs touchés | modification **refusée** (`too_many_changes`) |
| G4 | Référence normative absente | mention hors `legal_notes` | modification **refusée** (`unsupported_reference`) |
| G5 | Fait non fourni | montant/date/nom propre absent de la demande | **avertissement** `fact_unverified` |
| G6 | Anglicisme | mot anglais dans l'acte | avertissement `anglicism` |
| G7 | Construction interdite | image, lien, code, titre N≥4 | avertissement `forbidden_construct` — **bloque l'export Word** (HTTP 400, `bad_request`) |
| G8 | Renvoi cassé | « l'article 12 » sans article 12 | avertissement `broken_reference` |
| G9 | Numérotation | le modèle écrit un numéro d'article | le serveur **renumérote** et corrige les renvois |
| G10 | Sécurité | message ou document dangereux | `safety` : selon `SAFETY_MODE`, refus d'écriture ou simple journalisation |

La numérotation (G9) mérite un mot : le serveur est l'autorité. Le modèle peut
écrire « Article 7 » là où il en faut 4, c'est rattrapé, et les renvois internes
suivent le déplacement de l'article visé. Ce n'est pas un système d'identifiants
stables (`art_objet`) — c'est un choix assumé, expliqué dans
`docs/VERIFICATION-AUDIT.md`.

---

## 4. Le corpus juridique

### 4.1 Onze modèles

`data/templates/*.json` — un fichier par type, même schéma.

| Identifiant | Type | Fondement principal |
|---|---|---|
| `bail-habitation` | Bail d'habitation | Code civil, CGI (art. 169 bis, 530, 716) |
| `bail-bureau` | Bail à usage de bureau (personne publique) | Loi 77-995, décret 79-715, CGI 587-590 et 964 |
| `bail-professionnel` | Bail professionnel (local commercial) | Acte Uniforme OHADA (2010), Code civil |
| `cdd-terme-precis` | CDT à terme précis | Code du travail art. 15.3, 15.4, 15.8 |
| `cdd-terme-imprecis` | CDD à terme imprécis | Code du travail art. 15.6 (tâche précise) |
| `cdi` | CDI | Code du travail, décret 96-195 (essai), 2013-791 (SMIG) |
| `stage-ecole` | Convention de stage-école | Code du travail art. 13.11, 13.12 |
| `stage-qualification` | Stage de qualification | Code du travail art. 13.14, 13.17, 13.18 |
| `apprentissage` | Contrat d'apprentissage | Code du travail art. 13.3, décret 96-286 |
| `teletravail` | Accord de télétravail | Décret 2022-31 |
| `prestation-service` | Prestation, sous-traitance, fourniture | Code du travail art. 11.5-11.7, CGI (BNC, TVA) |

Les deux CDD sont bien distincts : conditions de recours, motif de tâche
précise, durée maximale de deux ans, prime de précarité de 3 %.

### 4.2 Le référentiel des sources

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

### 4.3 Ce qui n'a pas été fait

- **Aucune relecture par un juriste** du texte que le modèle produit. Les règles
  sont codées, pas les réponses.
- Le corpus ne couvre pas le **bail commercial sous l'AUDCG** (lacune
  BLOQUANTE signalée dans le référentiel) ni la **signature électronique
  qualifiée**.

---

## 5. L'interface

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

## 6. Les tests

| Fichier | Objet | Lignes |
|---|---|---|
| `b1-skeleton.test.ts` | health, page, en-têtes, CSP | 92 |
| `b2-edit.test.ts` | édition atomique, tout ou rien | 103 |
| `b2-validate.test.ts` | sous-ensemble Markdown, articles | 113 |
| `b3-templates.test.ts` | chargement des modèles, contexte | 68 |
| `b4-chat.test.ts` | flux SSE complet, bascule, annulation | 344 |
| `b4-tools.test.ts` | outils, garde-fous | 163 |
| `b5-export*.test.ts` | export Word, en-têtes, refus | 155 |
| `b6-evals.test.ts` | harnais d'évaluation | 44 |
| `b7-hardening.test.ts` | quotas, arrêt propre, erreurs | 107 |
| `b7-renumerotation.test.ts` | numérotation et renvois | 60 |
| `b8-openrouter.test.ts` | bascule, format OpenRouter | 116 |
| `b8-safety.test.ts` | filtre de sécurité | 146 |
| `b9-bout-en-bout.test.ts` | bout en bout sur socket réelle | 265 |
| `b10-templates/validators/sources` | corpus, règles, référentiel | 279 |
| `b11-audit-guardes.test.ts` | les 10 garde-fous du protocole | 486 |
| `c1`…`c6` | interface, branchement, démarrage | 412 |
| **Total** | **28 fichiers** | **3 292 lignes** |

**244 tests au vert.** `npm run typecheck` sans erreur, `npm run build` sans
erreur.

---

## 7. L'évaluation réelle

Campagne exécutée contre le vrai modèle, trois fois (le réseau de la machine de
développement s'est rétabli dans la nuit du 21 au 22).

| Exécution | Au vert |
|---|---|
| run 1 | 4/10 (scénarios 01, 02, 03, 10) |
| run 2 | 5/10 (+ 07, 09) |
| run 3 | 4/10 (01, 02, 03, 10) |

Avant les garde-fous : **1/10**. L'amélioration est réelle mais l'amera n'est
pas verte. Les trois échecs récurrents sont **structurels**, pas aléatoires :

| Scénario | Cause | Nature |
|---|---|---|
| **04, 05, 06** | La liste `unchanged_sections` reprend les intitulés de l'ancien modèle de bail (« Article 2 – Durée et loyer ») alors que le modèle livré en a 9 (« Article 2 – Désignation du bien »). L'assertion cherche des sections qui n'existent plus. | **Données périmées** — à réaligner. Le garde-fou serveur, lui, fonctionne : les journaux montrent `changed_blocks: 2` et aucun article perdu. |
| **08** | Le modèle répond par une question (`ask_user`, 3 options) au lieu d'un refus en texte. L'assertion ne lit que `text_delta` et non la charge utile de `ask_user`. | **Assertion incomplète** — la proposition du type le plus proche est bien présente, dans les options. |
| **09** | (a) Le modèle a écrit **1 127 caractères de contrat dans le chat** au lieu du Canvas. (b) L'assertion `no_legal_citation` signale « Article 1 »…« Article 9 » comme des citations juridiques : ce sont les **renvois internes** du contrat à ses propres articles. | (a) **vrai défaut** de respect de la consigne ; (b) **faux positif** de l'assertion. |

Le mode **smoke** reste à 10/10, mais il ne mesure rien du modèle : il rejoue
des réponses écrites à l'avance. Il est étiqueté « non concluant » partout.

**Deux actions, distinctes** :
1. Réaligner les données de référence des scénarios 04/05/06 et compléter les
   assertions 08 et 09 — ce sont des corrections de données, pas un
   affaiblissement, mais elles modifient le référentiel d'évaluation et
   méritent d'être validées ;
2. Traiter le défaut (a) du scénario 09 : le modèle écrit le contrat dans le
   chat. C'est un sujet de prompt et de garde-fou, à traiter.

---

## 8. L'exploitation

| Variable | Défaut | Rôle |
|---|---|---|
| `OPENROUTER_API_KEY` | *(obligatoire)* | Clé du fournisseur |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API |
| `LLM_MODELS` | `minimax/…-flash:free,nvidia/…-super-vl:free` | Chaîne de bascule |
| `LLM_SAFETY_MODEL` | `nvidia/…-content-safety:free` | Gardien |
| `SAFETY_CHECK` | `1` | Coupe le gardien |
| `SAFETY_MODE` | `advisory` | `off` / `advisory` / `block` — **par défaut `advisory`** : le verdict est journalisé, rien n'est bloqué. Passer à `block` après calibrage. |
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

Le serveur est **sans état** : ni base, ni session, ni historique. Tout vit
dans le navigateur (`localStorage`).

Démarrage : `npm install` → `cp .env.example .env` → `npm start` (compile puis
lance). Le serveur annonce son URL et, si le port est occupé, donne un message
explicite au lieu d'une pile d'exécution.

**Sur cette machine**, le port 3000 est pris par un autre projet (serveur Astro)
: `.env` utilise `PORT=3123` → `http://localhost:3123`.

---

## 9. Sécurité et conformité

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

## 10. Les décisions en attente d'Alex

| # | Sujet | Proposition |
|---|---|---|
| C1 | Durée de flux : le contrat dit 120 s, le code 240 s | Trancher, puis aligner code **et** contrat. 120 s coupe des générations complètes (constaté). |
| C2 | `canvas_set.validation.fields` | Distinguer champs obligatoires et facultatifs dans la charge utile. |
| C3 | `canvas_set.legal_notice` | Rendre structuré l'avertissement de revalidation juridique. |
| C4 | `clause_explained` | Explication de clause — **seulement si** la relecture pédagogique est retenue (`docs/SPEC-EXPLICATION-CLAUSES.md`). |
| C5 | Export et construction interdite | Documenter le `400 bad_request` désormais retourné par `/api/export/docx`. |
| C6 | `llm_error` vs `llm_unavailable` | Aucune modification du contrat ; distinguer les messages. |

Hors de portée de la V1 (README §11) : audit d'un contrat importé, comptes et
paiement, base de données, historique serveur, PDF serveur, multilingue, tests de
charge.

---

## 11. Le skill

`skill principal de redaction-contrats/` (22 fichiers, ~110 Ko), ajouté le
21/10 : 11 modèles Markdown, 7 références, 2 scripts Python, 4 scénarios.

Audit complet dans `docs/AUDIT-SKILL.md`. Verdict : **skill de très bonne
qualité**, discipline juridique exemplaire (neutralité, « points de départ,
pas vérité à jour », interdiction de citer un article incertain, repli en champ à
compléter pour un autre pays). Trois défauts mineurs, tous dans
`check_neutrality.py` (crash Windows, faux positifs) et un problème de chemin.

**Le skill et le backend ne partagent pas le même format de document et ne
couvrent pas les mêmes types.** Le skill a des modèles de : consultance,
assistance technique, formation, maintenance, entretien de locaux, sécurité
privée, bail bureau/professionnel, CDD, stage de qualification, stage-école. Le
backend a regroupé les cinq premiers sous `prestation-service` et a ajouté CDI,
télétravail, apprentissage et bail d'habitation.

---

## 12. Ce qui reste à faire, par priorité

| Priorité | Action | Qui |
|---|---|---|
| **P0** | Tourner la clé OpenRouter (elle a été exposée en clair) | Alex |
| **P0** | Corriger le défaut « le contrat écrit dans le chat » (scénario 09) | dev |
| **P0** | Réaligner les assertions 04/05/06 et compléter 08/09 | dev, à valider |
| **P1** | Livrer le front v2 et réécrire le branchement | Alex / front |
| **P1** | Trancher C1 (durée de flux) et mettre le contrat à jour | Alex |
| **P1** | Relecture juridique du texte produit par le modèle | juriste |
| **P2** | Information de conformité à l'utilisateur | Alex |
| **P2** | Hébergeur, domaine, pipeline de déploiement | Alex |
| **P2** | Rotation des identités : `AccessVerifier` → jeton individuel | dev |

---

## 13. Carte des fichiers

```
prompts/system.fr.md          le prompt système (rôle, déroulé, règles, catalogue)
data/templates/*.json         11 modèles de contrat
data/legal-sources.json       le référentiel des sources (source unique)
public/index.html             l'interface (fichier unique) + branchement injecté
scripts/inject-app-api.mjs    injecte le branchement dans la page
scripts/build.mjs             copie le convertisseur Word dans dist/
scripts/dump-contexte.ts      capture le contexte réellement envoyé au modèle
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
  agent/tools.ts              les 4 outils et les garde-fous
  agent/prompt.ts             system prompt, <document_courant>, <modele_contrat>
  agent/progress.ts           phase, plan, étapes, sources, suggestions
  agent/events.ts             types des événements SSE
  agent/json-partial.ts       extraction du JSON partiel des arguments d'outil
  doc/validate.ts             sous-ensemble Markdown, articles, règles
  doc/edit.ts                 édition atomique tout ou rien
  doc/structure.ts            articles, renumérotation, renvois
  doc/facts.ts                faits non fournis par l'utilisateur
  doc/references.ts           garde-fou de citations
  doc/lexical.ts              anglicismes
  doc/required-fields.ts      champs obligatoires renseignés ou non
  export/docx.ts              enveloppe TypeScript du convertisseur
  export/export-docx.mjs      le convertisseur (référence, étendu)
  middleware/                 requestId, requestLogger, auth, rateLimit, csp
  routes/                     chat, export, meta
evals/                        10 scénarios, assertions, mode smoke
test/                         28 fichiers de test
docs/                         14 documents (audit, exploitation, contrat, décisions…)
reference/                    originaux : contrats types, référentiel juridique
```

---

## 14. Comment reproduire les mesures

```bash
npm test                        # 244 tests
npm run typecheck
npm run build

# contexte réellement envoyé au modèle
npx tsx scripts/dump-contexte.ts          # → docs/contexte-modele/*.json
LLM_DEBUG_DIR=tmp/contexte npm start     # → chaque requête sortante, en direct

# évaluation
npm run eval -- --smoke         # 10/10, ne mesure pas le modèle
npm run eval                    # contre le vrai modèle : 4 à 7/10 aujourd'hui
```
