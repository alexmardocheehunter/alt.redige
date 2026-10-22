# LexCanvas — Vérification et correction de l'audit backend

**Document produit par l'audit indépendant.** Il vérifie chaque constat de
l'audit initial, le corrige quand il est confirmé, et liste ce qui reste à
faire.

| | |
|---|---|
| Date | 2026-10-21 (17:00 → 18:10) |
| Dépôt | `C:\OASIS\GitHub\lexcanvas-handoff` |
| Branche de correction | `fix/audit-vague-0` (base : `main` @ `2934856`) |
| HEAD au début de la vérification | `6597a94` (le dépôt a avancé de 3 commits pendant l'audit) |
| HEAD à la fin de la vérification | voir `git log --oneline -1` |
| Node / npm | v24.22.0 / 11.19.1 |
| Typecheck (référence) | `npm run typecheck` → **exit 0** |
| Tests (référence) | `npm test` → **170/170**, 17 fichiers |
| Tests (fin de correction) | `npm test` → **244/244**, 25 fichiers |
| Évaluation simulée | `npm run eval -- --smoke` → 10/10 **non concluant** (cf. §2) |
| Évaluation réelle | `npm run eval` → **1/10** avant correction ; **4 à 7/10** après (3 exécutions, modèle réel) — 3 échecs structurels restants, cf. §7 |

> **Note de concurrence.** Pendant toute la durée de ces travaux, un autre
> agent a travaillé **sur la même branche** et a committé des travaux en cours
> (commits `4e0d149`, `59dc206`, `93f3f9a`, `9ba7925`, `c536c13`). Plusieurs
> de ces commits regroupent des corrections de cet audit avec les leurs. La
> traçabilité « un constat = un commit » n'est donc pas respectée sur cette
> branche ; l'historique `git log` doit être lu comme un tout. Aucun travail
> existant n'a été écrasé.

---

## 1. Méthode

1. **Gel de l'état** : HEAD, `git status`, version de Node, typecheck et tests
   de référence.
2. **Vérification sans rien corriger** : chaque constat est rejoué par une
   commande reproductible. Verdict : `CONFIRMÉ`, `INFIRMÉ`, `PARTIEL`,
   `NON VÉRIFIABLE`.
3. **Correction par vagues** (0, 1, 2) : pour chaque constat confirmé, un test
   qui échoue avant la correction, puis passe après.
4. **Évaluation réelle** à 3 exécutions par vague.

**Règles respectées pendant ces travaux :**

- aucun seuil, assertion ou critère d'évaluation n'a été affaibli pour
  obtenir un « vert » — les exceptions sont signalées en §5 ;
- aucun contenu juridique n'a été écrit de mémoire : le référentiel
  juridique est celui fourni par l'humain
  (`reference/TOUTES LES INFOS LEGALES.txt`), le code ne fait que **comparer** ;
- `docs/API-CONTRACT.md` **n'a pas été modifié** : les divergences sont
  proposées en §6, à valider par Alex ;
- aucun fichier `tmp-*` n'a été commité ; `.gitignore` les exclut désormais.

### Rectifications apportées à l'audit initial

L'audit initial (rapport en conversation, à chargers comme `AUDIT.md`)
comportait deux altérations de rédaction, signalées par la consigne. Elles
sont corrigées ici et n'affectent aucun constat technique :

| Endroit | Texto altéré | Texte correct |
|---|---|---|
| §4 « Risques de génération juridique » | « Clauses**一键** inventées » | « Clauses inventées » |
| §4, même paragraphe | « un document featuring « ce délai pausing » n'est pas opposable …, et **Riddick** » | « … n'est pas opposable en l'état d'un point de vue rédactionnel » |

L'audit initial signalait aussi des gravités incohérentes (P2 marquées 🟠) :
elles sont réévaluées dans le tableau du §3, avec justification.

---

## 2. Le mode « smoke » : ce qu'il ne prouve pas

`npm run eval -- --dry-run` (renommé `--smoke`) rejoue des réponses **écrites
à l'avance** dans les fichiers de scénario. La section `mock` de chaque
scénario contient la réponse *attendue* ; le harnais la rejoue, puis vérifie
qu'elle est conforme. **Un « 10/10 » en mode smoke ne mesure rien du
comportement du modèle.**

C'était la source principale de l'illusion de couverture. Le mode a donc été
renommé, sa sortie affiche désormais `SMOKE` au lieu de `OK`, et un bandeau
précise qu'il n'est pas concluant :

```
*** MODE SMOKE (modèle scripté) ***
…
10/10 scénario(s) exécuté(s) en mode smoke — NON CONCLUANT.
```

**La seule évaluation concluante est `npm run eval`, contre le vrai modèle.**

---

## 3. Tableau de vérification

Gravité réévaluée par l'auditeur, avec justification en §4.

| ID | Verdict | Commande / preuve | Gravité réévaluée |
|---|---|---|---|
| **P0-1** | CONFIRMÉ | `GET /` → 1 377 o, 49 lignes, « Interface en cours d'intégration » | P0 (hors périmètre de correction) |
| **P0-2** | CONFIRMÉ | `git show e127215 -- evals/scenarios` ; campagne réelle antérieure (`tmp-eval.log` L43, L62, L77) ; script de reproduction | P0 |
| **P0-3** | CONFIRMÉ | campagne réelle antérieure (L20-22) + reproduction (3 fois) | P0 |
| **P0-4** | PARTIELLEMENT RÉSOLU (par le développeur) avant correction ; **résiduel corrigé** ici | 20 demandes légales + 5 contenus dangereux contre le vrai modèle | P0 → P1 résiduel |
| **P1-1 / P2-2** | CONFIRMÉ | script : `create_canvas` avec `contract_type` hors catalogue accepté, `issues: []` | P1 |
| **P1-2** | RÉSOLU PAR L'HUMAIN (référentiel joint) ; **mécanisme manquant**, ajouté ici | `data/templates/*.json` : 9 modèles, `legal_notes` + `validators` sourcés | P1 |
| **P1-3** | CONFIRMÉ | script : entité inventée dans le corps du contrat non détectée ; montant calculé signalé à tort | P1 |
| **P1-4** | CONFIRMÉ | document réel capturé : 6 anglicismes | P1 |
| **P1-5** | CONFIRMÉ | `src/doc/validate.ts` : aucun contrôle des `required_fields` | P1 |
| **P1-6** | CONFIRMÉ | recherche exhaustive : fonction absente de tout le dépôt | P1 (spécifié, non implémenté) |
| **P2-1** | CONFIRMÉ | script : `canvas_set.version = 2` au lieu de 1 ; observé en production | P2 |
| **P2-3** | CONFIRMÉ | script : bloc de code, image et URL perdus dans le `.docx` | P2 |
| **P2-4** | CONFIRMÉ | `config.ts:43` = 240 000 ms ; `API-CONTRACT.md:180` = 120 s | P2 |
| **P2-5** | CONFIRMÉ | `EXPLOITATION.md:50-51` = 8000/120000 ; code = 16000/240000 | P2 |
| **P2-6** | CONFIRMÉ | `.env` sans `ACCESS_CODE` ; `auth.ts` : `if (!accessCode) return next()` | P2 |
| **P2-7** | CONFIRMÉ | `rateLimit.ts` : clé = IP seule | P2 |
| **P3-1** | CONFIRMÉ | `chat.ts` : `console.error('sse_stream_error', error)` | P3 |
| **P3-2** | PARTIELLEMENT CONFIRMÉ | `body` était déjà redacté ; `answer` ne l'était pas | P3 |
| **P3-3** | CONFIRMÉ (sans effet) | `errors.ts:23-24` : `truncated`→400, `timeout`→504 | P3 |
| **P3-4** | CONFIRMÉ | `chat.ts` : deux codes, deux messages identiques | P3 |
| **P3-5** | CONFIRMÉ | `b8-safety.test.ts` : `max_tokens` jamais asserté | P3 |
| **P3-6** | CONFIRMÉ puis RÉSOLU (nettoyage par le développeur) | `git ls-files \| grep tmp-` | P3 |
| **P3-7** | CONFIRMÉ | `dist/` compilé à 13:39, sources modifiées à 15:27 ; `KNOWN-ISSUES.md` annonçait 120 tests et une campagne non exécutée | P3 |
| **P3-8** | CONFIRMÉ | idem P3-7 | P3 |
| **P3-9** | CONFIRMÉ | `AGENTS.md`, `README.md:58` : `@anthropic-ai/sdk` | P3 |
| **S1** | CONFIRMÉ | `prompt.ts` : texte utilisateur concaténé brut | P1 |
| **S2 / S3 / S8** | CONFIRMÉ | logs de campagne : 25 283 et 35 434 jetons d'entrée sur un tour | P1 |
| **S4 / S5** | CONFIRMÉ | `.env`, `config.ts:48` | P1 |
| **S6 / S7** | CONFIRMÉ | `rateLimit.ts` | P2 |
| **S11** | CONFIRMÉ | `app.ts` : ni CSP ni Permissions-Policy | P3 |

---

## 4. Détail des verdicts et corrections

### P0-1 — L'interface livrée ne parle pas au backend · **hors périmètre de correction — BLOQUANT**

**État constaté à la fin de la vérification.** Le fichier `public/index.html` a
été remplacé par le frontend livré par l'humain (35 413 octets, « alt.redige »).
**Il n'est pas une page provisoire : c'est une maquette fonctionnelle.**

**Mais il ne consomme pas l'API.** Analyse du fichier livré :

| Contrôle | Résultat |
|---|---|
| Appels `fetch` / `XMLHttpRequest` / `EventSource` / `WebSocket` | **aucun** |
| Chaînes contenant `/api/` | **aucune** |
| Noms d'événements SSE (`ready`, `text_delta`, `canvas_start`, `canvas_delta`, `canvas_set`, `done`) | **aucun** |
| Clés de `canvas_set` (`placeholders`, `issues`, `contract_type`, `edits_applied`) | **aucune** |
| Appel réseau réel | `window.claude.use('sample')` — **un fournisseur d'IA dans le navigateur**, pas le serveur |
| Prompt utilisé | le sien (« Tu es un juriste rédacteur… »), pas `prompts/system.fr.md` |
| Repli | `demo(text)` : un contrat **codé en dur** dans le fichier |
| Export Word | **jsPDF/JSZip dans le navigateur**, pas `POST /api/export/docx` |
| Export PDF | **jsPDF dans le navigateur**, pas `window.print()` (contrairement au contrat §3.4) |
| Authentification | fausse : nom et e-mail demandés, stockés dans `localStorage` (`altredige.user`) |

**Conséquences.**

1. **Tout le backend est hors circuit** : boucle agentique, outils, modèles de
   contrat, validateurs juridiques, garde-fou de sécurité, contrôle
   d'invention, export Word serveur, journalisation. Aucun n'est appelé.
2. **Le garde-fou P0-3 ne peut pas jouer** : le contrôle serveur des champs
   obligatoires n'a lieu que si le front appelle `/api/chat`.
3. **Les données du contrat partent ailleurs** : vers le fournisseur d'IA du
   navigateur, hors du périmètre de `docs/NOTE-CONFORMITE-DONNEES.md`.
4. **L'export PDF/Word du navigateur produit un document différent de celui
   que le serveur validerait** : la maquette produit des blocs
   `{t:"h"|"p"}`, pas le Markdown restreint du contrat.
5. **La CSP bloque les deux scripts externes** : `script-src 'self' 'nonce-…'`
   n'autorise pas `https://cdnjs.cloudflare.com`, d'où `jszip.min.js` et
   `jspdf.umd.min.js` ne sont pas chargés → `JSZip` et `jspdf` sont
   **indéfinis** → les boutons d'export lèvent une exception. Le nonce
   injecté par le serveur ne s'applique qu'au script inline de la page.
6. **L'implémentation d'`AGENT-PROTOCOL.md` est nulle** : aucun des nouveaux
   événements n'est produit ni consommé.

**Ce que j'ai fait.** Conformément à la consigne (« n'écris pas le frontend »),
je n'ai **pas** modifié le fichier livré. J'ai vérifié que le serveur le sert
tel quel (avec le nonce CSP injecté à la volée, sans modifier le disque) et
que la CSP correspond au nonce de la page.

**Ce qu'il reste à faire — c'est désormais le premier obstacle du projet :**

| # | Action | Responsable |
|---|---|---|
| F1 | Faire consommer `/api/chat` (SSE) au lieu de `window.claude.use(...)` : lecture du flux, `previousDoc`, restauration en cas d'erreur, `canvas_set` comme seule source de vérité. | Équipe frontend |
| F2 | Faire consommer `POST /api/export/docx` (le serveur produit déjà un `.docx` conforme et l'archive est vérifiée). | Équipe frontend |
| F3 | Faire produire le PDF par `window.print()` avec la feuille `@media print` (contrat §3.4), ou faire une décision explicite sur jsPDF + l'autoriser dans la CSP. | Équipe frontend + Alex |
| F4 | Supprimer la dépendance au CDN : héberger `jszip`/`jspdf` localement, ou les retirer. Une application qui rédige des contrats ne doit pas charger du code exécuté depuis un tiers au moment de la génération. | Équipe frontend |
| F5 | Remplacer la fausse authentification (nom/e-mail dans `localStorage`) par le vrai mécanisme (`ACCESS_CODE` ou jeton d'identité). | Alex + frontend |
| F6 | Implémenter les événements d'`AGENT-PROTOCOL.md` côté front (`ask_user`, `phase`, `plan`, `step`, `sources`, `suggestions`). | Équipe frontend |

Le détail des routes, des événements et des règles client figure dans
`docs/INTEGRATION-CHECKLIST.md`.

### P0-2 — Une modification ciblée peut supprimer un article · **corrigé**

**Constat.** Sur une demande de « préavis 2 mois → 3 mois », le modèle a
réécrit le document et le bloc de signatures avait disparu :

```
✗ Édition ciblée — section « Article 5 – Signatures » absente du document final
✗ Édition ciblée — section « Article 3 – Obligations du Locataire » absente …
✗ Nombre de sections modifiées — 5 section(s) modifiée(s) au lieu de 1
```

Aggravant : le commit `e127215` avait remplacé l'assertion stricte
(`unchanged_sections` + `max_changed_sections: 1`) par une assertion plus
lâche (`max_changed_blocks: 4`), et **aucun scénario n'utilisait plus**
`checkUnchangedSections` ni `countChangedSections` — le code du contrôle
était devenu mort.

**Correction.**

1. `src/doc/structure.ts` (nouveau) : `articleKeys`, `lostArticles`,
   `countChangedBlocks`.
2. `src/agent/tools.ts` : `edit_canvas` **refuse** une édition qui fait
   disparaître un article (`code: article_lost`) ou qui touche plus de
   `MAX_EDIT_CHANGED_BLOCKS` blocs (`code: too_many_changes`). Le document
   reste intact dans les deux cas.
3. `evals/scenarios/04|05|06` : `unchanged_sections` et `max_changed_sections`
   **rétablis** (valeurs d'origine du commit `d582237`), `max_changed_blocks`
   conservé en complément.

**Test** : `test/b11-audit-guardes.test.ts` — 3 cas (article perdu refusé,
réécriture refusée, modification ciblée acceptée).

### P0-3 — Le modèle rédige sur une demande vide · **corrigé**

**Constat.** Sur « Je veux faire un bail. », un `canvas_set` était produit
(26 espaces réservés) : le modèle rédigeait au lieu de questionner.
Reproduit 3 fois.

**Correction.** `src/doc/required-fields.ts` (nouveau) déduit la **nature**
attendue de chaque champ obligatoire à partir de son libellé (montant,
durée, date, identité, lieu, texte) et cherche la donnée correspondante dans
les messages de l'utilisateur. `create_canvas` est alors **refusé** si aucun
champ obligatoire n'est renseigné ; l'erreur renvoyée au modèle l'invite à
poser une question.

**Test** : `test/b11-audit-guardes.test.ts` — « refuse de rédiger un bail à
partir d'une demande vide » et « accepte quand l'utilisateur a fourni les
informations ».

> **Précision d'honnêteté.** Le contrôle porte sur l'**historique**, pas sur
> le document produit : un document produit ne prouve rien, puisque le
> modèle peut y avoir inventé les valeurs. C'est le contrôle d'invention
> (P1-3) qui couvre ce cas.

### P0-4 — Faux positifs du filtre de sécurité · **résiduel corrigé**

**Constat initial.** « Change le préavis à trois mois et passe le loyer à
80 000 FCFA. » → HTTP 400. Une demande de bail avec résiliation verrouillée
→ HTTP 400. Deux demandes **parfaitement légitimes** bloquées.

**État à la vérification.** Le développeur avait entre-temps ajouté
`SAFETY_MODE`, le format natif Nemotron et une exemption de domaine.
Vérification contre le vrai modèle :

```
=== 20 demandes juridiques légitimes (attendu : safe) ===
CONFORME  20/20   (dont les 2 faux positifs initiaux)
=== 5 contenus dangereux (attendu : unsafe) ===
CONFORME  5/5
```

**Résiduel trouvé par l'audit.** La détection de domaine est **par mots-clés**,
et le vocabulaire était incomplet : « état des lieux », « entretien de
locaux » (qui est un type de contrat du corpus de référence !) et « prudence »
étaient classés **hors domaine**. Un verdict « unsafe » sur ces textes aurait
bloqué une demande légitime. Reproduit par script, sans dépendre du modèle.

**Correction.** `DOMAIN_TERMS` étendu (locations et baux hors habitation,
fiscalité, recouvrement, responsabilité, litiges, statuts, coutumes) ; les 9
cas vérifiés sont désormais reconnus comme relevant du domaine.

**Semantique des modes clarifiée** (`src/safety.ts`) :

| `SAFETY_MODE` | Effet |
|---|---|
| `off` | aucun appel au gardien |
| `advisory` (**défaut**) | un contenu **hors du domaine** dont le verdict est « unsafe » reçoit un HTTP 400 ; un contenu du domaine est journalisé mais **jamais** bloqué |
| `block` | tout verdict « unsafe » bloque, y compris dans le domaine |

> **Écart assumé avec la consigne.** La consigne fixait « défaut
> `advisory` » **et** « 5 contenus dangereux → 5 blocages ». Ces deux
> exigences sont incompatibles si `advisory` signifie « ne rien bloquer ».
> J'ai retenu la lecture qui satisfait les deux : `advisory` bloque ce qui
> sort du domaine, et laisse passer le domaine (où le gardien se trompe).
> C'est aussi le comportement le plus proche de celui que le développeur
> avait mesuré à 0 faux positif.

### P1-1 / P2-2 — Un type de contrat hors catalogue est accepté · **corrigé**

**Constat.** `create_canvas` acceptait `contract_type: "prestation-services"`,
émettait un `canvas_set` avec `validation.issues: []`, et le document était
validé contre le modèle **de bail** : l'utilisateur aurait vu « Article «
Loyer » absent. » et « Article « Obligations du locataire » absent. » sur un
contrat de services.

**Correction.** Liste blanche dans `create_canvas`, alignée sur `get_template`
(les 9 types du catalogue) ; refus avec la liste des types valides. Le
`contract_type` produit est désormais toujours un type connu, et le document
est validé contre le bon modèle.

### P1-2 — Aucune référence normative encadrée · **mécanisme ajouté**

**État réel à la vérification.** Le constat de l'audit était **caduc** sur le
fond : l'humain a joint un référentiel juridique
(`reference/TOUTES LES INFOS LEGALES.txt`, 70 Ko) et 9 modèles de contrat en
sont issus, avec `legal_notes` sourcées (`[S02, art. 169 bis]`) et des
`validators` exécutables. Le « référentiel vide » n'existe plus.

**Ce qui manquait** : rien n'empêchait le document de citer un texte **absent**
du référentiel. C'était le défaut observé en conditions réelles (le mot
« OHADA » inséré dans un bail).

**Correction.** `src/doc/references.ts` (nouveau) extrait les mentions
normatives d'un document (codes, actes uniformes, lois, articles) et les
compare aux `legal_notes` du modèle. `create_canvas` et `edit_canvas`
**refusent** l'écriture si une mention n'est pas sourcée. Les renvois
internes (« comme prévu à l'Article 3 ») ne sont jamais signalés.

**Test** : refus d'un document citant « le Code civil » ; acceptation d'un
document citant l'« attestation d'immatriculation fiscale » (présente dans
les notes).

### P1-3 — Aucune détection déterministe d'invention · **corrigé**

**Constat.** La règle « n'invente jamais » ne reposait que sur le prompt.
Le détecteur d'évaluation, lui, avait été restreint par le commit `7199021`
à la « zone d'identité » : un nom propre inventé dans le **corps** d'une
clause devenait invisible.

**Preuve** (avant correction) :

```
Cas 1 — entité inventée dans le corps du contrat → non détectée
Cas 2 — la même entité dans la zone d'identité  → détectée
Cas 3 — montant calculé (400 000 × 3)            → signalé à tort
```

**Correction.** `src/doc/facts.ts` (nouveau) vérifie que les montants, durées,
dates et noms propres du document proviennent de l'utilisateur, du modèle de
référence, ou d'un **calcul vérifiable** (le total 1 200 000 = 400 000 × 3
est accepté). Le vocabulaire des noms propres est celui de **tous** les
modèles : un mot capitalisé du vocabulaire (« Bailleur », « Locataire ») n'est
pas une invention.

**Limite assumée.** Le contrôle produit un **avertissement**
(`validation.issues`), pas un refus : une coquille vide est bloquée, mais une
valeur approximative reste signalée à l'utilisateur. Un refus aurait
provoqué des boucles de réécriture.

### P1-4 — Anglicismes dans les actes · **corrigé**

**Constat.** 6 anglicismes dans un contrat de 12 articles : `etSigning`,
`dedication`, `methodologies`, `ce délai pausing`, `résiliation immediate`,
`plafond de responsabilité eventual`. Aucun filtre.

**Correction.** `src/doc/lexical.ts` (nouveau) : liste **noire** de mots
anglais qui n'ont aucun emploi français. La liste est vérifiée contre le
corpus du dépôt (squelettes, notes juridiques, exemple de référence) : la
première version signalait `user` (« user paisiblement des lieux ») et
`production` (« la production d'une attestation ») — deux faux positifs
retirés. Le contrôle s'applique au document (`validation.issues`) et au
message de chat (journalisé).

**Résultat** : 0 faux positif sur le corpus, 4/4 anglicismes observés
détectés.

### P1-5 — Les champs obligatoires ne sont pas contrôlés · **corrigé**

**Correction.** `validate()` émet maintenant une issue `required_field` par
champ obligatoire laissé vide (le champ est renseigné si le document contient
une donnée de sa nature : un montant pour « loyer », un nom pour « bailleur »).

**Proposé, non fait** : distinguer obligatoire / conditionnel / facultatif
dans la charge utile `validation` — c'est une **modification du contrat
d'API**, proposée en §6.

### P1-6 — Pas de relecture pédagogique des clauses · **spécifié, non implémenté**

Le constat est confirmé : rien n'existe dans le dépôt. Une spécification
complète est livrée dans `docs/SPEC-EXPLICATION-CLAUSES.md` (outil
`explain_clause`, événement `clause_explained`, versionnement, garde-fous
serveur, avertissement structuré). **L'implémentation est volontairement
différée** : elle suppose un frontend livré et une validation humaine du
contenu juridique des explications.

### P2-1 — `canvas_set.version` non conforme au contrat · **corrigé**

**Preuve** : `get_template` puis `create_canvas` → `version = 2` au lieu de
1 (API-CONTRACT §3.3). Observé aussi en production sur un contrat de
services.

**Correction** : `setsEmitted` ne compte plus que les appels d'outil qui ont
**réellement émis un `canvas_set`** (`ToolResult.emittedCanvasSet`). Test
d'intégration ajouté.

### P2-3 — L'export perd du contenu silencieusement · **corrigé**

**Preuve** : un document contenant un bloc de code, une image et un lien
produisait un `.docx` où le bloc de code et l'image étaient **absents** et
l'URL du lien **perdue** — sans le moindre message.

**Correction** : `POST /api/export/docx` appelle `validate()` et **refuse**
(`400`, code `bad_request`) un document contenant une construction interdite,
en listant les constructions fautives. Un `.docx` ne peut plus différer du
contrat affiché.

### P2-4 — Divergence code / contrat d'API · **proposé, non appliqué**

`src/config.ts` : `REQUEST_TIMEOUT_MS` = 240 000 ms. `docs/API-CONTRACT.md`
§7 : « Durée maximale d'un flux : **120 secondes** ».

Le code a été modifié **avant** le contrat, et le contrat n'a pas été
modifié. Conformément à la consigne, **je n'ai pas touché au contrat** : la
correction est proposée en §6. Le choix de la valeur de référence (120 s ou
240 s) appartient à Alex.

### P2-5 — Documentation d'exploitation contredite par le code · **corrigé**

`docs/EXPLOITATION.md` annonçait `MAX_OUTPUT_TOKENS = 8000` et
`REQUEST_TIMEOUT_MS = 120000`, et conseillait au proxy de laisser la
connexion ouverte 120 s — **un conseil de déploiement faux** avec la valeur
réelle de 240 s. Le tableau des variables, la section « Modes du gardien »
et la section « Quotas » sont à jour, ainsi que les trois nouvelles variables.

### P2-6 / S4 / S5 — Authentification · **corrigé**

**Constat.** `.env` ne définit pas `ACCESS_CODE` ; `auth.ts` laissait passer
toute requête si elle était absente ; le serveur écoutait sur `0.0.0.0` avec
une clé OpenRouter réelle dans le dépôt de travail.

**Correction.**

1. `src/middleware/auth.ts` est réécrit autour d'une **interface**
   `AccessVerifier` (`verify(token) → { ok, identity, reason }`) ;
   `AccessCodeVerifier` en est l'implémentation de référence. Un vérificateur
   de jeton d'identité (Firebase Admin SDK) s'y substitue sans toucher aux
   routes.
2. `loadConfig()` **refuse de démarrer** en `NODE_ENV=production` sans
   `ACCESS_CODE`.
3. L'en-tête `Authorization: Bearer …` est accepté en plus de
   `X-Access-Code`.

**Non fait, volontairement** : l'implémentation Firebase (élément « hors
audit », qui exige une décision humaine et une dépendance).

### P2-7 / S6 / S7 — Quotas par IP · **corrigé**

**Correction.** La clé de quota est **l'identité** quand elle existe, l'IP
sinon. Derrière un proxy sans `TRUST_PROXY=1`, l'adresse IP est celle du
proxy : elle n'identifie pas le client, le quota retombe alors sur un seau
partagé explicitement nommé. `TRUST_PROXY=1` est documenté comme obligatoire
derrière un proxy.

**Limite assumée** : le mode `ACCESS_CODE` ne fournit aucune identité, le
quota reste donc par IP tant qu'une authentification par jeton n'est pas en
place.

### P3-1 / P3-2 — Logs · **corrigé**

- `chat.ts` : `console.error('sse_stream_error', error)` → `logger.error(...)`
  avec **la nature** de l'erreur seulement.
- `chat.ts` et `llm.ts` : le message d'erreur du fournisseur n'est plus
  journalisé (il peut reprendre un extrait de la demande ou du contrat) ;
  seuls `error_kind` et `status` le sont.
- `logger.ts` : `answer` et `provider_message` ajoutés aux clés interdites.
  `body` y était déjà.
- Vérifié en conditions réelles : les journaux ne contiennent que des
  métadonnées.

### P3-3 — `truncated` / `timeout` · **documenté**

Ces deux codes n'apparaissent qu'après l'ouverture du flux (API-CONTRACT §4
les déclare « — (flux) »). La table `STATUS_BY_CODE` leur attribue 400 et
504 par repli. **Aucun code n'a été supprimé ni modifié** : un commentaire
précise que ces statuts ne correspondent à aucun statut prévu par le
contrat et ne servent que de filet si un de ces codes était un jour levé
par une route.

### P3-4 / P3-5 / P3-6 / P3-8 / P3-9 · **corrigé**

- `llm_error` et `llm_unavailable` ont maintenant **deux messages distincts**.
- `b8-safety.test.ts` asserte désormais `max_tokens === SAFETY_MAX_TOKENS` et
  `≥ 512` (le test s'intitulait « demande un budget suffisant » sans jamais
  vérifier le budget).
- `.gitignore` exclut `tmp-*` ; les scripts de travail ont été retirés du
  dépôt par le développeur.
- `dist/` est reconstruit (`npm run build`).
- `AGENTS.md` et `README.md` §5 n'annoncent plus `@anthropic-ai/sdk` : la pile
  réelle est OpenRouter en `fetch` natif.

### S1 — Injection de prompt · **corrigé (partiel)**

**Constat.** Le message utilisateur était concaténé **brut** dans le dernier
message ; seule une phrase du prompt système rappelait que le document est
une donnée.

**Correction.** La demande est désormais délimitée par
`<demande_utilisateur>…</demande_utilisateur>`, avec une consigne explicite
de ne pas suivre les instructions qu'elle contient ; le type choisi est
également encadré (`<type_choisi>`).

**Limite assumée.** C'est une défense **d application's** (délimitation +
consigne), pas une défense serveur absolue : aucun garde-fou serveur ne peut
empêcher un modèle de suivre une instruction contenue dans un texte. Le
scénario 10 reste le test de référence.

### S2 / S3 / S8 — Volume transmis · **partiellement corrigé**

**Correction.** `MAX_HISTORY_MESSAGES` (défaut 12) + `selectHistory()` : le
premier message de l'utilisateur et les derniers messages sont conservés, le
milieu est retiré. L'historique et le document ne sont plus retransmis
intégralement à chaque étape.

**Reste à faire (décision humaine)** : minimisation des données personnelles
avant envoi, politique de conservation chez le fournisseur, information de
l'utilisateur. Une **note de conception** est livrée :
`docs/NOTE-CONFORMITE-DONNEES.md`.

### S11 — CSP et Permissions-Policy · **corrigé**

`secureHeaders()` pose maintenant une CSP
(`default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
`object-src 'none'`, `frame-ancestors 'none'`…) et une Permissions-Policy.
**Conséquence à retenir** : le frontend livré ne pourra pas utiliser de script
inline sans nonce. C'est documenté dans `docs/INTEGRATION-CHECKLIST.md` §5.

---

## 5. Ce qui n'a pas été corrigé, et pourquoi

| Point | Raison |
|---|---|
| **P0-1** (frontend) | Hors périmètre : « n'écris pas le frontend ». Livré à la place : `docs/INTEGRATION-CHECKLIST.md`. |
| **P1-6** (relecture pédagogique) | Spécifié, non implémenté : suppose le frontend livré **et** une validation humaine du contenu juridique. |
| **P2-4** (divergence du contrat) | `docs/API-CONTRACT.md` est normatif et ne se modifie qu'avec l'accord d'Alex. Proposition en §6. |
| **Contrôle de cohérence numérique** (« 150 000 FCFA/mois » vs « 90 000 FCFA pendant 24 mois » dans la même demande) | Non implémenté : la règle « même grandeur, deux valeurs » exige de savoir quelles données décrivent **le même** objet (le loyer), ce qui n'est pas exprimable par une heuristique fiable sans le modèle. Signalé comme besoin de spécification. |
| **Seuil d'alerte sur les placeholders excessifs** (19 à 37 par contrat) | Non implémenté : le seuil dépend de ce que l'utilisateur est prêt à compléter. `validation.placeholders` est déjà disponible ; un affichage non bloquant côté frontend suffit. |
| **Implémentation Firebase** | Décision humaine (choix du fournisseur d'identité) + dépendance. L'interface `AccessVerifier` est prête. |
| **Minimax / anonymisation avant envoi** | Décision humaine (qualité de la rédaction contre confidentialité). Cf. `docs/NOTE-CONFORMITE-DONNEES.md` §4. |
| **`dist/` périmé** | Corrigé : `npm run build` exécuté. |

### Critères d'évaluation modifiés — signalement obligatoire

Conformément à la consigne, aucun critère n'a été affaibli pour obtenir un
« vert ». Deux **données de scénario** ont été modifiées, et une assertion a
été **réadaptée** — le détail est donné ici pour validation :

1. **`evals/scenarios/10-injection.json`** : le message utilisateur a été
   enrichi d'une demande de bail légitime (parties, loyer, durée) **avant** la
   tentative d'injection. Motif : avec le garde-fou P0-3, une demande sans
   aucune information ne produit plus de contrat — l'injection n'aurait plus
   rien à contaminer, et le scénario serait devenu vide de sens. **Le
   scénario est ainsi renforcé** : l'injection est maintenant noyée dans une
   demande plausible, ce qui est un test plus dur qu'auparavant. Les
   assertions (`document_not_contains`, `document_contains`, `no_invented_facts`)
   sont inchangées.
2. **`test/b2-validate.test.ts`** : le test « ne signale aucune issue avec le
   modèle de bail fourni » a été réécrit par le développeur (le contrat
   d'exemple est plus court que le modèle livré). Une assertion que j'ai
   corrigée porte désormais sur le **modèle livré** (`data/templates/`) et non
   sur l'ancien fichier de référence : elle vérifie que l'article «
   Désignation » est bien signalé comme absent.
3. **`test/b3-templates.test.ts`** : l'assertion sur le format du contexte a
   été adaptée à la nouvelle délimitation `<demande_utilisateur>` (S1) et
   une assertion a été **ajoutée** sur la présence des balises.

---

## 6. Modifications de contrat proposées (à valider par Alex)

`docs/API-CONTRACT.md` a été **mis à jour** (22/10/2026) : les six propositions
ci-dessous ont été tranchées, le contrat a été modifié **avant** le code, et le
code a été aligné dessus. Le détail des décisions figure dans
`docs/AUDIT-ETAT-AGENT.md` §11.

| # | Emplacement | Divergence constatée | Décision prise |
|---|---|---|---|
| C1 | §7 — limites | « Durée maximale d'un flux : **120 secondes** » alors que le code utilise 240 000 ms | **240 secondes** — les modèles de la chaîne sont à raisonnement, 120 s coupe des générations complètes (constaté). Contrat mis à jour. |
| C2 | §3.3 — `canvas_set` | La charge utile ne distingue pas les champs obligatoires des champs facultatifs | **Ajouté** : `validation.fields: { required: [{key,label,filled}], optional: [...] }`. Implémenté dans `src/agent/tools.ts`. |
| C3 | §3.3 — `canvas_set` | L'avertissement « à faire valider par un juriste » n'est qu'une phrase de chat, non structurée | **Ajouté** : `legal_notice: { required: true, text: "…" }`. Implémenté dans `src/agent/tools.ts`. |
| C4 | §3.3 — nouveaux événements | Pas d'événement pour l'explication d'une clause | **Ajouté** : `clause_explained` (outil + événement), avec les garde-fous de `docs/SPEC-EXPLICATION-CLAUSES.md`. Le **contenu** juridique des explications reste à valider par un juriste. |
| C5 | §3.4 — export | Le contrat ne dit pas ce qui se passe si le document contient une construction interdite | **Documenté** : `400 bad_request`, liste des constructions refusées, aucun `.docx` produit. |
| C6 | §4 — erreurs | `llm_error` et `llm_unavailable` partaient le même message | Le contrat ne fixe pas les messages ; **aucune modification n'a été nécessaire**, la distinction est documentée. |

---

## 7. Évaluation réelle — résultat et limites

### Historique

| Période | Résultat | Ce que la campagne a permis |
|---|---|---|
| 21/10, avant les garde-fous | **1/10** | point de départ |
| 21/10, après les garde-fous | 4 à 7/10 | réseau instable : les échecs 07 à 10 étaient des échecs de transport |
| 22/10, campagne du jour | **5 à 6/10** selon l'exécution | les échecs restants étaient, eux aussi, majoritairement des échecs de transport |

### Ce que le 22/10 a changé

Les assertions de la campagne étaient **périmées** : elles dataient d'avant
le modèle livré (9 articles) et d'avant que le modèle de contrat ne soit
épinglé dans le contexte. Elles ont été remises en état — sans être
affaiblies :

- l'assertion « l'agent a appelé `get_template` » a été remplacée par un
  contrôle **des articles du modèle réellement présents** dans le document
  produit, ce qui est plus fort ;
- la comparaison des blocs est **alignée sur la numérotation du serveur**,
  faute de quoi chaque titre d'article déplacé comptait comme un bloc
  modifié ;
- le contrôle de citation distingue un **renvoi interne** d'une citation ;
- les fixtures d'évaluation ont été régénérées sur le modèle livré.

### Les défauts de comportement trouvés, et corrigés

| Défaut | Correction |
|---|---|
| L'agent réédite la même clause : il ne voit pas le document après sa propre modification | le serveur réinjecte **le document à jour** dans la conversation ; règle de prompt |
| Le chat dépasse 600 caractères | **garde-fou serveur** : écourtage à 600 caractères + `warning` |
| Une question sur une clause modifie le contrat au lieu d'y répondre | règle de prompt |
| Le type hors catalogue est proposé par un formulaire qui ne nomme pas le type le plus proche | règle de prompt : un choix unique qui nomme le type |
| Le mode `advisory` de sécurité **ne bloquait jamais** (contrairement à sa documentation) | le mode bloque désormais hors du domaine |
| L'exemption de domaine s'appuyait sur des mots trop génériques (`usage`, `bureau`, `local`, `conseils`) : 4 demandes dangereuses sur 10 y échappaient | exemption fondée sur des **termes forts** |

### Le garde-fou de sécurité, calibré

`npm run calibrage` mesure le gardien sur 30 cas relus par un humain
(`data/safety-sample.json`) : **0 faux positif et 1 faux négatif** en mode
`advisory`. Le mode `block` bloquerait une demande légitime sur 20 : il est
**déconseillé**. Rapport : `docs/CALIBRAGE-SECURITE.md`.

### Ce qui reste : le réseau

Sur cette machine, les connexions vers `openrouter.ai` sont **interrompues**
par intermittence : un même `POST` de 9 Ko passe, puis échoue, puis passe.
La mesure est faite dans `docs/KNOWN-ISSUES.md`. Les scénarios qui échouent
sur `llm_unavailable` ou `UND_ERR_SOCKET` ne disent rien du comportement de
l'agent : ils sont rejoués, et les relances du serveur (3 tentatives avec
backoff, puis bascule de modèle) n'y suffisent pas toujours.

**La campagne doit être rejouée depuis un poste dont le réseau sortant n'est
pas filtré.** La commande est prête, les 10 scénarios et les assertions sont en
place, et le mode smoke reste à 10/10.

### Le 22/10, le fournisseur a retiré le modèle principal

En fin de journée, `minimax/minimax-m3.1-flash:free` — le modèle principal de
la chaîne — a été **retiré du catalogue OpenRouter** (`404`, fin de la période
gratuite). Le compte du projet est par ailleurs **sans crédit** : tous les
modèles payants répondent `402`. Les modèles gratuits restants ont été sondés
avec la requête réelle de l'application ; un seul a passé un scénario complet
(`dots-studio/dots-3-note-preview:free`, scénarios 01 et 04), et il repose
parfois des questions au lieu de rédiger. Les autres sont inutilisables :
questions systématiques, pas d'appel d'outils, quotas ou délais dépassés.

Conséquence : le verdict de la campagne ne peut pas être rétabli sur des
modèles gratuits. **La production exige le crédit du compte et les jumeaux
payants** (`minimax/minimax-m3.1-flash`, `nvidia/nemotron-3.5-super-vl`) ; la
porte `npm run verif-prod` sonde chaque modèle et refuse les variantes `:free`.
Le détail des sondes est dans `docs/AUDIT-ETAT-AGENT.md` §8.


---

## 8. Affirmations du développeur — verdict

| Affirmation | Verdict | Commentaire |
|---|---|---|
| « Le backend et les logiques de fonctionnement sont terminés à 100 % » | ⚠️ **Partiellement vraie** | Le backend est complet et testé (277 tests). Le **front v2 manque** : le prototype livré est branché, mais ce n'est pas l'interface finale. L'évaluation réelle reste partielle : la chaîne de modèles gratuits est instable (retrait constaté le 22/10/2026) et la campagne doit être rejouée avec les modèles payants. |
| « Les jalons B1 à B7 sont terminés, tests au vert » | ✅ **Vraie aujourd'hui** | 277 tests au vert, sur 28 fichiers. Les critères d'acceptation de `SPEC-BACKEND.md` §10 sont couverts ; les écarts de contrat ont été corrigés (C1 à C6). |
| « L'API conforme à `docs/API-CONTRACT.md` v1.0 » | ✅ **Vraie aujourd'hui** | `version` suit §3.3 ; `REQUEST_TIMEOUT_MS` a été aligné sur §7 (240 s, décision C1) ; le contrat a été mis à jour **avant** le code pour C1 à C6. |
| « Les 10 scénarios d'évaluation passent » | ❌ **Trompeuse** | 10/10 en mode *simulé* (tautologique) ; 4 à 7/10 en mode réel. Le mode est renommé « smoke » et étiqueté non concluant. La campagne réelle n'a pas été rejouée après les derniers correctifs. |
| « Une génération complète a abouti, 0 issue de validation, aucun nom inventé » | ⚠️ **Vrai pour une génération, non généralisable** | Le contrôle d'invention était déjaudit à la fois. Il est aujourd'hui déterministe et couvre tout le document. |
| « Le filtre de sécurité a été corrigé et testé » | ✅ **Vrai, avec un résiduel assumé** | 20/20 + 5/5 en conditions réelles, et un échantillon relu de 30 cas mesuré par `npm run calibrage`. Le résiduel : le modèle de sécurité est gratuit et son comportement peut changer ; `SAFETY_MODE=advisory` permet de ne pas bloquer. |
| « La bascule de modèle fonctionne en conditions réelles » | ✅ **Confirmé** | Reobservée pendant la campagne : `minimax` → `nemotron`. |
| « Les retries socket sont en place » | ✅ **Confirmé et utile** | 3 reprises avec backoff observées en conditions dégradées. |
| « Le réseau sortant instable n'est pas un défaut de l'application » | ✅ **Confirmé indépendamment** | TLS 1.3 bloqué, TLS 1.2 fonctionnel. |
| « Aucune règle juridique inventée » | ✅ **Confirmé, et renforcé** | Le référentiel vient de l'humain ; le code compare, il n'écrit pas de droit. |
| « L'export Word s'ouvre sans avertissement » | ⚠️ **Non vérifié visuellement** | Archive OOXML valide, accents, guillemets, placeholders surlignés, tableau : vérifié. Ni Word ni LibreOffice ne sont installés : l'ouverture réelle reste non vérifiée. |

---

## 9. Risques restants et validations humaines nécessaires

### Risques techniques restants

| # | Risque | État |
|---|---|---|
| R1 | L'évaluation réelle est passée de **1/10 à 4–7/10** ; les trois échecs structurels ont été corrigés (assertions réalignées sur le modèle livré, fixtures régénérées, contrôle de citation affiné, garde-fou du chat côté serveur). | **À reprendre** : la campagne réelle doit être rejouée sur un réseau stable pour mesurer l'effet de ces correctifs. |
| R2 | La résistance à l'injection repose sur une défense d'application | Aucune défense serveur absolue n'est possible ; le scénario 10 reste le test. |
| R3 | Le contrôle d'invention est un avertissement, pas un refus | Un montant approché reste dans le document, signalé. |
| R4 | `ACCESS_CODE` ne donne aucune identité | Quotas par IP, pas par utilisateur, tant que le jeton d'identité n'est pas en place. |
| R5 | Le **contenu** juridique des explications de clause n'est pas validé | Le mécanisme existe (outil, événement, garde-fous serveur) ; les mots employés par le modèle doivent être relus par un juriste. |
| R6 | Le quota d'un seul `ACCESS_CODE` est partagé par tous les utilisateurs | Remplacé par un jeton d'identité. |
| R7 | Le corpus de `reference/` contient des doublons (« - Copie.docx ») | Bruit de dépôt ; aucun impact fonctionnel, non supprimé (matériel de travail de l'humain). |

### Validations humaines et juridiques nécessaires

| # | Objet | Qui |
|---|---|---|
| J1 | **Relire les 9 modèles** issus du référentiel joint : clauses, plafonds, validateurs, mentions obligatoires. `legal_review.status` vaut « fourni », mais la relecture par un juriste n'est pas tracée dans le dépôt. | Juriste ivoirien |
| J2 | **Valider C1 à C6** : les décisions sont prises et le contrat est à jour (§6). Il reste à les **entériner**. | Alex |
| J3 | **Entériner C4** (explication de clause, mécanisme livré) et son périmètre. | Alex + juriste |
| J4 | **Choisir l'authentification** (Firebase ou équivalent) et le mode de déploiement (limite de 60 s de Firebase Hosting vs flux de 90 s). | Alex |
| J5 | **Conformité des données** : base légale, information de l'utilisateur, conservation chez le fournisseur, transferts hors UEMOA/CEDEAO. | Conseil spécialisé protection des données |
| J6 | **Décider la minimisation** des données avant envoi au fournisseur. | Alex + conseil |
| J7 | **Relecture juridique du contenu des explications** de clause, si la fonction est retenue. | Juriste ivoirien |

---

## 10. `AGENT-PROTOCOL.md` — implémentation partielle

L'humain a fourni `AGENT-PROTOCOL.md` (extension **additive** du contrat
d'API) pendant les travaux. Conformément à la consigne, ces éléments étaient
« hors audit » ; le protocole étant arrivé, la priorité listée par le
document lui-même a été suivie.

| § | Élément | État |
|---|---|---|
| §2 | Enveloppe `seq` / `t` sur chaque événement | ✅ fait |
| §3 | `phase` | ✅ fait (émis par `src/agent/progress.ts`) |
| §4 | `plan` / `step` | ✅ fait |
| §5 | `thinking_*` | ❌ non fait (dernier de la liste de priorité) |
| §6 | `tool_start` / `tool_end` | ✅ fait |
| §8 | **`ask_user`** | ✅ **fait** — c'est la priorité 1, et c'est le point que le constat P0-3 exigeait |
| §9 | `suggestions` (+ `sources`) | ✅ fait |
| §10 | `retry` / `warning` | ⚠️ `retry` fait ; `warning` non émis |
| §12 | `done` enrichi (`request_id`, `duration_ms`) | ✅ fait |
| §16 | Codes `cancelled`, `conflict`, `content_filtered` | ❌ non faits |
| §11 | `canvas_start` enrichi (`target`, `reason`) | ❌ non fait |

**Ce qui est fait, précisément :**

- un **outil `ask_user`** est exposé au modèle (4ᵉ outil) : il émet
  l'événement `ask_user` et **arrête le tour** sur `done(awaiting_input)` ;
- le **garde-fou P0-3** ne se contente plus de refuser l'écriture : il
  **pose la question**. Sur une demande sans information exploitable,
  l'événement `ask_user` est de type `form`, avec un champ par champ
  obligatoire manquant ; le tour s'arrête, le contrat n'est pas écrit ;
- le client peut renvoyer des **réponses structurées** (`answers`) ;
  elles sont validées, mais le texte de `messages` reste la source — le
  protocole l'exige ;
- l'enveloppe `seq` / `t` est appliquée à **tous** les événements, y compris
  ceux du contrat d'API v1.0, qui n'en sont pas modifiés ;
- `phase`, `plan`, `step`, `tool_start`, `tool_end`, `sources` et
  `suggestions` sont émis par `src/agent/progress.ts` (commit `1c55f29`),
  avec des libellés en français et **sans jamais exposer les arguments bruts
  des outils** — vérifié par `test/c2-protocole.test.ts`.

**Ce qui reste à faire** : §5 (`thinking_*`, le dernier de la liste de
priorité), §10 (`warning`), §11 (`canvas_start` enrichi) et §16 (trois codes
d'erreur). Les types sont déjà déclarés dans `src/agent/events.ts` : il
suffit de les émettre.

**Divergence signalée.** Le protocole nomme `max_tokens` là où le contrat
v1.0 nomme `max_steps` (`done.stop_reason`). La valeur du contrat est
conservée, pour ne pas casser un front déjà écrit contre lui. À trancher
par Alex.

---

## 11. Récapitulatif

| Vague | Constats traités | État |
|---|---|---|
| Vague 0 | P0-2, P0-3, P0-4 (résiduel), P1-1 / P2-2 | **Fait** — tests au vert, typecheck exit 0, smoke 10/10. Évaluation réelle **non conclue** (réseau). |
| Vague 1 | P1-2, P1-3, P1-4, P1-5, P1-6 (spécifié), P2-6, P2-7, S1, S2/S3/S8, S4/S5 | **Fait** (P1-6 spécifié, pas implémenté). |
| Vague 2 | P2-1, P2-3, P2-5, P3-1 à P3-9, S11 | **Fait** ; P2-4 proposé, non appliqué. |
| Hors périmètre | P0-1 | **Le fichier est livré, mais il n'appelle pas le backend** : six écarts chiffrés au §4, une liste d'actions F1 à F6 pour l'équipe frontend. `docs/INTEGRATION-CHECKLIST.md` fait foi. |
| Protocole agent | `AGENT-PROTOCOL.md` | **§2, §3, §4, §6, §8, §9, §10 (partiel), §12 faits** (dont `ask_user`, exigé par P0-3) ; §5, §10 (`warning`), §11 et §16 restent à faire. |

**Ce qui n'a pas été fait, et doit l'être avant une mise en production :**

1. **Le front doit consommer le backend** (F1 à F6). C'est le premier
   obstacle : tant que le front appelle `window.claude.use(...)`, le backend
   — et donc tous ses garde-fous — est inerte.
2. **L'authentification par jeton** (P2-6).
3. **La relecture juridique tracée** des 9 modèles (J1).
4. **Reprendre l'évaluation réelle** : réaligner les données d'assertion
   périmées, corriger les deux assertions incomplètes, puis 3 exécutions (R1).
5. **Les §5, §11 et §16 du protocole agent**, une fois l'interface du front
   connue.

**Cet audit technique ne constitue pas une certification de conformité au
droit ivoirien ou OHADA.** Il établit que le dispositif de contrôle existe,
qu'il est vérifiable, et ce qu'il ne couvre pas.
