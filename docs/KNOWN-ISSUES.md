# LexCanvas — Points connus

Liste honnête de ce qui ne marche pas encore, de ce qui est en attente, et des
choix techniques assumés. Mis à jour à chaque jalon.

---

## État de la phase A (backend)

Les jalons B1 à B7 sont terminés : tests au vert (195 tests, 18 fichiers), un
commit par jalon. L'API est **conforme à `docs/API-CONTRACT.md` v1.0 sur le
format des événements**, mais deux divergences subsistent et sont listées
dans `docs/VERIFICATION-AUDIT.md` §6 (la durée de flux et la charge utile
`validation`) : le contrat est normatif, il n'a pas été modifié.

Ce qui n'est **pas** fait, et pourquoi :

| Point | Statut |
|---|---|
| Campagne d'évaluation contre le vrai modèle | **1/10 au vert** (campagne du 21/10, avant les garde-fous). La campagne de contrôle après correction **n'a pas pu être conclue** : le réseau sortant vers `openrouter.ai` a été dégradé (429 et coupures de socket) pendant toute la fenêtre de travail. À relancer sur un réseau sain, 3 exécutions. |
| Mode « smoke » (anciennement « dry-run ») | 10/10, mais **non concluant** : il rejoue des réponses écrites à l'avance dans les scénarios. Il vérifie le harnais, pas le modèle. |
| Phase C — intégration du frontend | non commencée : le fichier `index.html` définitif n'a pas été livré. `public/index.html` est encore la page provisoire (49 lignes). La liste de contrôle que le frontend doit respecter est dans `docs/INTEGRATION-CHECKLIST.md`. |
| Relecture juridique des modèles | **contenu reçu** (référentiel joint) et 9 modèles construits ; reste la relecture du texte rédigé par l'IA |
| Vérification visuelle de l'export Word dans Word/LibreOffice | non faite : ni Word ni LibreOffice ne sont installés sur cette machine. L'archive OOXML est vérifiée par test (structure, surlignage, numérotation, pied de page) |
| Relecture pédagogique des clauses | **spécifiée, non implémentée** : `docs/SPEC-EXPLICATION-CLAUSES.md`. Suppose le frontend livré et une validation humaine du contenu juridique. |

---

## En attente de décision ou de contenu (Alex)

### Relecture juridique des modèles — CONTENU REÇU, DERNIÈRE VÉRIFICATION À FAIRE
Alex a fourni le référentiel juridique et contractuel
(`reference/TOUTES LES INFOS LEGALES.txt`, 70 Ko : sources S01 à S07, fiches par
type de contrat, matrice fiscale, liste blanche des références). Les neuf
modèles de `data/templates/` sont construits à partir de ce référentiel :

- `legal_notes` : les clauses interdites ou à risque de la fiche, avec leur
  référence `[S0x, art. …]` ;
- `validators` : les règles impératives chiffrées, **désormais exécutables** par
  `doc/validate.ts` (durée maximale, montant minimum, pourcentage, âge,
  mentions obligatoires, clauses interdites) ;
- `required_fields` / `optional_fields` : les champs obligatoires et
  conditionnels de la fiche ;
- `skeleton_markdown` : la structure réelle des contrats types, avec des espaces
  réservés.

**Ce qui reste à faire** : une relecture par un juriste du contenu effectivement
rédigé par le modèle (les règles sont codées, mais le texte produit par l'IA
n'a pas été relu). Le référentiel signale lui-même deux lacunes :
- le régime des **baux commerciaux** sous l'Acte Uniforme OHADA (AUDCG) n'est
  pas couvert — un bail commercial ne doit pas être rédigé sans vérification ;
- la **signature électronique qualifiée** n'est pas encadrée par les sources.

Ces deux points sont inscrits dans les notes du modèle `bail-habitation`.

### Les validateurs sont exécutables, mais rester des garde-fous
`doc/validate.ts` exécute les règles `validators` (type `max_duration_months`,
`min_amount_fcfa`, `min_percentage`, `min_age_years`, `required_phrases`,
`forbidden_phrases`). Limites assumées :

- une règle dont la valeur **n'apparaît pas** dans le document est **sans
  conclusion** : aucun problème n'est signalé (le document peut être encore
  vide) ;
- la recherche est faite paragraphe par paragraphe, et une règle peut être
  bornée à un périmètre (`scope`) : sans ce périmètre, la plus petite valeur
  trouvée dans le document est comparée, ce qui produit des faux positifs
  (une prime plus petite que le salaire de base, par exemple) ;
- les contrôles portent sur le texte, pas sur le sens : une règle peut être
  respectée dans les mots et violée dans les faits.

Un écart trouvé n'est pas une erreur fatale : il est remonté dans
`validation.issues` (severité `warning` ou `error`) et affiché par le frontend
sans bloquer l'export.

---

## Environnement de développement

### Clé `OPENROUTER_API_KEY` absente de la machine de développement
Sans clé, le serveur démarre (la validation de la configuration échoue
volontairement : `OPENROUTER_API_KEY` est obligatoire, cf. `SPEC-BACKEND.md` §3),
mais aucun appel au modèle ne peut aboutir. Conséquence : les scénarios
d'évaluation (`npm run eval`) et le flux `/api/chat` ne peuvent pas être exécutés
en local tant que la clé n'est pas fournie.

Une clé de test peut être posée dans `.env` (jamais commité) :

```
OPENROUTER_API_KEY=sk-or-...
```

### Le changement de fournisseur (Anthropic → OpenRouter) n'a pas été validé en conditions réelles
La bascule du fournisseur a été faite sur instruction d'Alex. Le format des
requêtes (API OpenAI-compatible d'OpenRouter), le streaming des appels d'outils
et la bascule entre modèles sont couverts par les tests (faux client qui parle
exactement le format SSE d'OpenRouter), et les trois identifiants de modèles ont
été vérifiés sur `https://openrouter.ai/api/v1/models` (présents, et les deux
modèles de rédaction annoncent bien la prise en charge des appels d'outils).

**Constats de la campagne réelle** (clé fournie le 21/10/2026) :

- une génération complète a abouti : flux `ready` → `status` → `canvas_start` →
  `canvas_delta` → `canvas_set` → `done`, document de 6 427 caractères, 22
  espaces réservés, **0 issue de validation**, aucun nom inventé ;
- une modification réelle a abouti (6 edits appliqués), après une reprise de
  l'agent sur une ancre `old_str` introuvable ;
- la **bascule a fonctionné en conditions réelles** : sur un scénario, le
  modèle principal a échoué (ECONNRESET), la relance a échoué aussi, et
  `nvidia/nemotron-3.5-super-vl:free` a pris le relais (scénario au vert).

**Reste à faire** : la campagne `npm run eval` complète (10 scénarios) n'est pas
au vert sur cette machine, à cause du réseau sortant instable vers
OpenRouter (coupures de connexion intermittentes). Voir « Réseau sortant » plus
bas. Le harnais, lui, est validé : 10/10 en mode hors ligne.

### Les modèles de la chaîne sont des modèles à raisonnement
`minimax/minimax-m3.1-flash:free` et `nvidia/nemotron-3.5-super-vl:free` produisent
un champ `reasoning` avant le contenu. Conséquences appliquées :

- `MAX_OUTPUT_TOKENS` passe de 8 000 à **16 000** par défaut : le raisonnement
  et la réponse doivent tenir dans le même budget, sinon le contrat est coupé
  (`truncated`) ;
- le champ `reasoning` n'est **jamais** relayé au client (le frontend ne voit
  que `content`) ;
- le classement de sécurité a besoin de 512 jetons, pas 16 : à 16 jetons, le
  modèle raisonne, n'écrit jamais son verdict, et le filtre ne bloque rien.

### Le verdict du modèle de sécurité a un format propriétaire
Le modèle `nvidia/nemotron-3.5-content-safety:free` ne répond pas `SAFE` /
`UNSAFE` mais `User Safety: safe` / `User Safety: unsafe` (avec parfois une
ligne `Response Safety:`). Le parseur (`parseVerdict` dans `src/safety.ts`) lit
la ligne **User Safety** — c'est le classement de l'entrée utilisateur.

**Piège corrigé en cours de route** : la première version du parseur ne
reconnaissait que `SAFE`/`UNSAFE` en début de réponse. Le filtre renvoyait
donc systématiquement « illisible » et **laisse passer** : il ne bloquait
rien. Le format réel a été relevé en interrogeant le modèle, puis le parseur a
été corrigé et testé.

**Calibrage vérifié sur le modèle réel** (21/10/2026). Deux problèmes ont été
trouvés et corrigés en cours de route.

**1. La consigne de classement dégradait le modèle.** Le modèle
`nvidia/nemotron-3.5-content-safety` attend son **format natif**
(« User Safety: … / Response Safety: … »). Lui demander un mot unique
(`SAFE`/`UNSAFE`) dégradait nettement ses jugements : sur quatre demandes
légitimes, une demande de bail légitime était classée
« Criminal Planning/Confessions ». Avec le format natif, plus aucun faux
positif. La consigne est donc reprise dans le format du modèle
(`SAFETY_SYSTEM_PROMPT`).

**2. Le modèle se trompe sur le droit français.** Même avec le bon format, sur
huit demandes légitimes (bail, résiliation, contrat de travail, location de
voiture, reprise de bail), deux étaient bloquées à tort. D'où l'exemption de
domaine : une demande qui contient un terme du vocabulaire juridique ou
administratif (`bail`, `contrat`, `loyer`, `travail`, `promesse`…) n'est
**jamais** bloquée sur le seul verdict du gardien ; elle est journalisée
(`safety_flagged_request`) pour relecture. Un contenu qui sort du domaine est
bloqué normalement.

**Mesures finales** (14 cas, modèle réel) :

| | Demandes légitimes (10) | Demandes dangereuses (4) |
|---|---|---|
| bloquées à tort | **0** | — |
| laissées passer | — | **0** |

**Ce qui reste fragile** : l'échantillon est court (14 cas) et le modèle est
un modèle gratuit dont le comportement peut changer. Si un faux positif
apparaît en production, `SAFETY_MODE=advisory` désactive le blocage en une
variable d'environnement (le verdict reste journalisé). Le mode par défaut est
`block` ; `SAFETY_CHECK=0` coupe complètement le gardien.

Le filtrage du *document produit* par le gardien est en place (aucun
`canvas_set` n'est publié si le document est rejeté), mais n'a pas été testé
sur un document réellement dangereux : le mécanisme n'a été validé que sur des
documents légitimes.

### Réseau sortant instable vers openrouter.ai
Depuis la machine de développement, les connexions `POST` vers
`openrouter.ai` sont **coupées au-delà d'environ 1 Ko de corps de requête**.
Mesure reproductible (le 21/10/2026, sur la même machine) :

```
corps    215 o  status 200
corps    415 o  status 200
corps    715 o  status 200
corps   1015 o  status 200
corps   1315 o  coupe (ECONNRESET)
corps   2115 o  coupe (UND_ERR_SOCKET)
corps   4115 o  coupe (UND_ERR_SOCKET)
```

Les `GET` passent, et les petits `POST` passent. Le corps envoyé par
l'application fait **environ 8 Ko** (prompt système 6,3 Ko + schémas des outils
1,3 Ko + message) : il est donc systématiquement coupé depuis cette machine.
`curl` échoue exactement de la même façon : ce n'est pas un défaut du client
HTTP, c'est le réseau du poste. Le TLS 1.3 y est par ailleurs bloqué (TLS 1.2
passe).

**Ce que cela a mis en évidence** : le code ne réessayait pas sur une erreur
de socket. Il le fait maintenant (3 tentatives avec backoff 500 ms / 1,5 s /
3 s, puis bascule de modèle) et le journal `llm_socket_retry` permet de le
voir. Sur un hébergeur avec un réseau normal, ces reprises ne se déclencheront
pas.

**Conséquence sur les évaluations** : quand le réseau coupe, le scénario est
relancé automatiquement (2 relances, uniquement pour un échec de transport —
une assertion en échec n'est jamais rejouée, ce qui masquerait un vrai
problème de comportement). Depuis cette machine, la campagne réelle ne peut
pas aboutir : il faut la lancer depuis un poste dont le réseau sortant vers
OpenRouter n'est pas filtré.

**Diagnostic** (à rejouer ailleurs) :

```bash
node -e "const b=JSON.stringify({model:'minimax/minimax-m3.1-flash:free',messages:[{role:'user',content:'x'.repeat(5000)}],max_tokens:8}); fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.OPENROUTER_API_KEY},body:b}).then(r=>console.log('status',r.status)).catch(e=>console.log('coupé',e.cause?.code))"
```

Le contournement local (TLS 1.3 bloqué) est `NODE_OPTIONS=--tls-max-v1.2` :
voir « Dépannage » dans `docs/EXPLOITATION.md`.

**État de la campagne réelle** : la campagne du 21/10/2026 a été interrompue
après 3 scénarios, tous en échec de transport (`ECONNRESET` sur les trois
modèles, après relances) : le réseau sortant de ce poste coupe désormais
systématiquement les requêtes `POST` de taille réelle de l'application. Ce
n'est pas un défaut du code — la même chaîne a fonctionné plusieurs fois dans
la journée (contrat complet généré, modification appliquée, bascule entre
modèles observée), et le test de bout en bout `test/b9-bout-en-bout.test.ts`
valide le chemin complet sur une vraie socket.

**À refaire** : lancer `npm run eval` depuis une machine dont le réseau vers
OpenRouter n'est pas filtré. La commande est prête, les 10 scénarios et les
assertions sont en place.

### Le test de bout en bout ne dépend pas du réseau
`test/b9-bout-en-bout.test.ts` démarre un serveur HTTP local qui parle le
protocole OpenRouter (API compatible OpenAI) et exerce tout le chemin de
production sur une vraie socket : client, parsing du flux SSE, appels d'outils,
événements du Canvas, garde-fou, export Word. C'est le test de référence
quand le réseau sortant est incertain.

### Le filtre de sécurité n'a pas été calibré sur le modèle réel
*Ce point est résolu : le calibrage réalisé et ses résultats sont décrits dans
« Le verdict du modèle de sécurité a un format propriétaire » ci-dessus.*

---

## Évaluations (`npm run eval`)

### La campagne `npm run eval` n'a pas pu être menée à son terme
Le harnais est complet : 10 scénarios (`evals/scenarios/*.json`), 5 familles
d'assertions automatiques (pas d'invention, édition ciblée, pas de contrat dans
le chat, sous-ensemble respecté, export valide).

Le mode **simulé** s'appelle maintenant `npm run eval -- --smoke` (l'ancien
`--dry-run` reste accepté comme alias). Il rejoue un modèle scripté : il
**vérifie le harnais** (décodage SSE, exécution des outils, assertions) et
**ne mesure pas le comportement du modèle**. Sa sortie affiche `SMOKE` et un
bandeau « NON CONCLUANT » : un 10/10 en mode smoke ne doit pas être présenté
comme une évaluation réussie. Le contrôle d'invention déterministe, lui, est
désormais dans le code de production (`src/doc/facts.ts`) et pas seulement
dans les assertions.

Ce que la campagne réelle a déjà démontré le 21/10/2026 (avant que le réseau
ne coupe) :

- le scénario 01 est **passé au vert** après correction du prompt (une seule
  version du document, chat court, aucun nom inventé) ;
- le scénario 08 est **passé au vert** en basculant réellement du modèle
  principal vers le second ;
- le filtre de sécurité a été **validé sur 14 cas réels** (0 faux positif,
  4 vrais positifs).

Une campagne de contrôle après les garde-fous serveur (21/10, 17:25) a été
lancée trois fois : **toutes trois ont été interrompues par l'indisponibilité
du fournisseur** (429 puis `UND_ERR_SOCKET`), et aucune n'a pu être conclue.
Voir « Réseau sortant instable vers openrouter.ai ».

**À refaire** : lancer `npm run eval` depuis une machine dont le réseau vers
OpenRouter n'est pas filtré, **3 fois**. La commande est prête, les 10
scénarios et les assertions sont en place.

### Les assertions ont été durcies, pas assouplies
Trois corrections ont été apportées après la première campagne réelle :

- **« Pas d'invention »** ne cherchait plus les noms propres dans tout le
  document mais **dans la zone d'identité des parties** (avant le premier
  article, plus les lignes portant un titre de civilité) : le vocabulaire
  juridique du modèle (« Préambule », « Réparations », « Contestations ») était
  compté comme une invention. Les montants, durées et dates restent vérifiés
  dans tout le document.
- **« Édition ciblée »** compare désormais les **blocs** séparés par une ligne
  vide, comme le décrit la spécification, au lieu des titres d'articles : le
  modèle renumérote parfois les articles, ce qui faisait échouer la comparaison
  par titre alors que les clauses non concernées étaient bien identiques.
- **« Modes du Canvas »** vérifie que les modes attendus **ouvrent** le flux
  (l'agent peut ensuite peaufiner le document) au lieu d'exiger une liste
  identique. La spécification n'impose pas qu'un `create_canvas` soit le seul
  appel de l'agent.

En revanche, les exigences explicites de la spécification sont restées
strictes : un seul `edit_canvas` pour une modification, un seul `edit_canvas`
à deux edits pour deux modifications demandées ensemble, un `create_canvas` avec
`replace: true` pour « recommence tout », au plus trois questions pour une
demande vague, et pas de contrat dans le chat.

### Le contrôle « pas d'invention » est déterministe en production, heuristique en évaluation
Le contrôle de production est `src/doc/facts.ts` : les montants, durées, dates
et noms propres du document doivent provenir des messages de l'utilisateur, du
modèle de référence, ou d'un calcul vérifiable (le total 400 000 × 3 = 1 200
000 est accepté). Le vocabulaire des noms propres est celui de **tous** les
modèles : un mot capitalisé du vocabulaire (« Bailleur », « Locataire ») n'est
pas une invention.

`evals/assertions.ts` conserve son propre contrôle, plus heuristique : il
cherche les noms propres dans la zone d'identité des parties (avant le premier
article, plus les lignes portant un titre de civilité) pour ne pas signaler
le vocabulaire juridique du modèle. C'est une limite de l'assertion
d'évaluation, **plus** du contrôle de production.

Limites connues :
- un nombre cité dans le document mais présent « par hasard » dans le message de
  l'utilisateur passe le contrôle (faux négatif) ;
- le contrôle de production produit un **avertissement** (`validation.issues`),
  pas un refus : une valeur approximative reste dans le document, signalée à
  l'utilisateur ;
- un nom propre légitime absent du message de l'utilisateur est signalé comme
  une invention (faux positif possible) ;
- la liste de mots courante (`CONTRACT_STOPLIST`) de l'assertion d'évaluation
  est faite main : elle peut être incomplète.

Le contrôle est un garde-fou, pas une preuve : il doit être lu avec le document
produit.

### Les contrôles externes de l'export sont optionnels
`pandoc` et `soffice` (LibreOffice) ne sont pas installés sur la machine de
développement : l'étape de l'export Word ne vérifie alors que l'intégrité de
l'archive OOXML et la présence du titre et des espaces réservés. Les étapes
externes sont signalées comme « ignorées » dans la sortie de `npm run eval`.

---

## Choix techniques assumés

### Le nom du modèle par défaut (`claude-sonnet-5-5`) n'est pas vérifié
*Obsolète : le fournisseur est désormais OpenRouter. Voir « Les trois modèles »
dans `docs/EXPLOITATION.md`.*

### Comparaison du code d'accès
La comparaison utilise `timingSafeEqual` ; lorsque les longueurs diffèrent, une
comparaison de longueur égale est tout de même exécutée pour ne pas distinguer
les cas par le temps de réponse.

### `TRUST_PROXY`
L'adresse IP du client n'est lue dans `X-Forwarded-For` que si `TRUST_PROXY=1`.
En dehors, l'adresse de la connexion est utilisée. Derrière un proxy inverse,
penser à activer `TRUST_PROXY=1`, sinon la limitation de débit s'applique à la
totalité des clients.

### Découpage des paragraphes pour le PDF
L'export PDF se fait côté navigateur (`window.print()`), conformément au
périmètre V1 : aucun endpoint PDF n'existe côté serveur.

---

## Points relevés pendant l'implémentation

### Contradiction apparente entre `SPEC-BACKEND.md` §4 et le contrat d'API
`SPEC-BACKEND.md` §4 décrit `canvas_set` comme émis par l'outil `create_canvas`
au moment de son exécution, alors que `docs/API-CONTRACT.md` §3.3 décrit un
flux où `canvas_set` peut être émis après les `canvas_delta`.

**Traitement appliqué** : le contrat d'API l'emporte (README §4.10). En mode
`create`, le serveur émet `canvas_start`, puis des `canvas_delta` pendant la
réception des arguments de l'outil, puis un `canvas_set` unique et définitif à
la fin de l'appel d'outil. En mode `edit`, le serveur émet `canvas_start` puis
`canvas_set`. `version` vaut `document.version` reçu + nombre de `canvas_set`
déjà émis dans ce flux + 1.

### Placeholders comptés sur le document final
`validation.placeholders` est compté sur le Markdown définitif de `canvas_set`,
et non sur le brouillon.streamed : le client peut donc afficher un compteur
qui bouge pendant la rédaction, puis se stabilise.
