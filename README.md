# LexCanvas — README pour l'agent backend

Tu es l'agent de code qui construit le **backend** de LexCanvas et qui, à la fin, **relie le frontend** au backend. Lis ce fichier en entier avant d'écrire du code. Il t'explique le projet, les fichiers fournis et comment t'en servir, dans l'ordre où tu en auras besoin.

## 1. Mission en cinq lignes

LexCanvas est un SaaS de rédaction de contrats (droit ivoirien et OHADA) par conversation. À gauche un chat, à droite un document vivant (« Canvas ») qui s'écrit en streaming. L'utilisateur modifie le contrat en discutant, puis exporte en Word et en PDF. Ton travail : un serveur Node qui pilote l'agent IA (outils, streaming), applique les modifications au document, valide, exporte en `.docx`, et sert le frontend. Délai global du projet : **une semaine**, donc vitesse et fiabilité avant sophistication.

## 2. Le déroulé en trois phases

| Phase | Qui | Quoi |
|---|---|---|
| **A. Maintenant** | Toi (backend) en parallèle d'une autre IA (frontend) | Tu construis le backend contre `docs/API-CONTRACT.md`. L'autre IA construit un `index.html` unique contre le même contrat, avec un mode simulé. Vous ne vous parlez pas : **le contrat est votre seul lien**. |
| **B. Livraison du front** | Alex (le propriétaire du projet) | Alex te remet le fichier `index.html` finalisé. |
| **C. Intégration** | Toi | Tu le places dans `public/index.html`, tu retires le mode simulé, tu fais passer la checklist du §9. |

Pendant la phase A, `public/index.html` contient une page provisoire (« Interface en cours d'intégration ») pour que `GET /` réponde déjà.

## 3. Inventaire : quel fichier, pour quoi, quand

| Fichier | Rôle | Quand l'utiliser |
|---|---|---|
| `AGENTS.md` | Règles permanentes courtes. Se charge automatiquement dans beaucoup d'agents de code. | Déjà actif ; ne le contredis pas. |
| `README.md` (ce fichier) | Point d'entrée. | Maintenant. |
| `docs/API-CONTRACT.md` | **Contrat normatif** : endpoints, événements SSE, formats JSON, codes d'erreur, sous-ensemble Markdown, règles côté client. | Tout le temps. En cas de doute, il gagne sur toute autre doc. |
| `docs/SPEC-BACKEND.md` | Comment implémenter : stack figée, arborescence, boucle agentique, outils, validation, évaluations, sécurité. | Pour chaque jalon du §6. |
| `docs/SPEC-FRONTEND.md` | Spec donnée à l'IA du front. | **Phase C seulement**, pour vérifier que le front livré respecte ce qui était demandé. Tu ne codes pas le front. |
| `reference/export-docx.mjs` | Convertisseur Markdown → Word **déjà écrit et testé**. | Jalon B5 (§7). |
| `reference/sample-bail.md` | Contrat d'exemple dans le sous-ensemble Markdown autorisé (8 espaces réservés, listes, tableau). | Entrée de test de l'export et de la validation. |
| `reference/bail.docx` | Le Word attendu pour `sample-bail.md`. | **Référence visuelle** : ouvre-le pour voir le résultat visé. |
| `reference/bail.pdf` | Le même contrat converti en PDF. | Référence visuelle de la mise en page. |
| `reference/system-prompt.fr.md` | Prompt système de l'agent, avec le marqueur `{{CATALOGUE}}`. | Copie-le dans `prompts/system.fr.md` ; jalon B3. |
| `reference/template.bail-habitation.example.json` | Schéma d'un modèle de contrat + squelette du bail. | Copie-le dans `data/templates/` ; jalon B3. |

Les fichiers de `reference/` sont des **originaux** : copie-les, n'édite pas l'original.

## 4. Règles non négociables

1. **Le contrat d'API ne se modifie qu'avec l'accord d'Alex.** Si un changement s'impose, modifie d'abord `docs/API-CONTRACT.md`, signale-le à Alex en une phrase, puis le code. Le front est écrit contre la version actuelle.
2. **Serveur sans état pour le chat.** Aucune session de conversation côté serveur : le client renvoie historique et document. Depuis la V1.1 (validée par Alex le 23/10/2026), des **snapshots d'historiques optionnels** peuvent être conservés dans Firestore pour les utilisateurs connectés avec Google ; ils restent supprimables et ne sont jamais utilisés pour reconstruire une conversation.
3. **Jamais de contenu de contrat ou de message dans les logs.** Ce sont des données personnelles.
4. **Aucune règle juridique inventée.** `legal_notes` et `validators` des modèles proviennent exclusivement du référentiel officiel fourni par Alex. La relecture juridique a été effectuée et attestée par Alex le 23/10/2026 ; les limites signalées par le référentiel restent documentées dans les modèles.
5. **Tout ou rien sur le document.** Un flux interrompu ne laisse jamais un demi-document (voir contrat, règles côté client).
6. **Annulation propagée** : fermeture de la connexion client ⇒ interruption de l'appel au LLM.
7. **Ne réécris pas `export-docx.mjs`.** Étends-le.
8. **Pas de dépendance lourde sans l'accord d'Alex.** Firestore/Firebase Admin est le stockage validé pour les historiques (V1.1) ; toute autre base ou tout navigateur headless reste hors périmètre.
9. **Réponses d'erreur et libellés utilisateur en français**, sans détail technique.
10. Si une instruction de ces documents te semble contradictoire, applique le contrat d'API, note le point dans `docs/KNOWN-ISSUES.md` et continue.

## 5. Démarrage rapide

Vérifié dans un dossier vierge (Node 22, `docx` 9.13.0).

```bash
mkdir lexcanvas && cd lexcanvas
# copie ici le contenu du dossier de passation (README.md, AGENTS.md, docs/, reference/)
npm init -y && npm pkg set type=module
npm install hono @hono/node-server zod docx \
  mdast-util-from-markdown mdast-util-gfm-table micromark-extension-gfm-table
npm install -D typescript tsx vitest @types/node

# test immédiat du convertisseur fourni
node reference/export-docx.mjs reference/sample-bail.md /tmp/test.docx
unzip -t /tmp/test.docx                                   # doit afficher "No errors detected"
unzip -p /tmp/test.docx word/document.xml | grep -o 'À COMPLÉTER' | wc -l   # doit afficher 8
```

Si ces trois commandes réussissent, la chaîne d'export fonctionne et tu peux construire autour.

## 6. Jalons et critères d'acceptation (phase A)

Travaille dans cet ordre. À la fin de chaque jalon : tests au vert, commit, résumé de cinq lignes.

| # | Jalon | Fini quand |
|---|---|---|
| **B1** | Squelette : Hono, `config.ts` (zod), `GET /api/health`, `GET /` servant `public/index.html` provisoire, middlewares (requestId, auth `ACCESS_CODE`, limite de corps, rate limit). | `curl /api/health` répond ; sans bon code d'accès `/api/chat` répond 401 si `ACCESS_CODE` est défini. |
| **B2** | `doc/edit.ts` et `doc/validate.ts` avec tests unitaires. | Edits atomiques (cas `not_found`, `not_unique`, tout-ou-rien) ; `validate(sample-bail.md)` ⇒ 8 placeholders, 0 issue. |
| **B3** | Modèles et prompt : `templates.ts`, `data/templates/bail-habitation.json` (depuis l'exemple), `prompts/system.fr.md`, `GET /api/templates`. | `/api/templates` liste le bail ; le prompt se génère avec le catalogue. Le fichier exemple est en `"status": "draft"` : passe-le à `"ready"` pour le développement (sinon le front ne l'affiche pas). La relecture juridique a été terminée et attestée par Alex le 23/10/2026 (`docs/KNOWN-ISSUES.md`). |
| **B4** | `/api/chat` : boucle agentique, 3 outils, SSE conforme au contrat, annulation, erreurs. | Un `curl -N` reproduit le flux de l'exemple (contrat §6) ; coupure de connexion ⇒ appel LLM interrompu (test). |
| **B5** | `/api/export/docx` autour de `export-docx.mjs`, pied de page optionnel, nom de fichier. | Le `.docx` du contrat généré à B4 s'ouvre dans Word sans avertissement. |
| **B6** | Évaluations (`npm run eval`, 10 scénarios de `SPEC-BACKEND.md` §8). | Scénarios verts ou échecs documentés dans `docs/KNOWN-ISSUES.md`. |
| **B7** | Durcissement : logs sans contenu, arrêt propre, README d'exploitation (variables, lancement, déploiement). | Checklist sécurité de `SPEC-BACKEND.md` §9 cochée. |

## 7. Utiliser `reference/export-docx.mjs`

**Ce qu'il fait.** Convertit du Markdown restreint en `.docx` (A4, marges de 2,54 cm, Times New Roman 11 pt, pied de page « Page X / Y »). Il parse avec `mdast-util-from-markdown` et construit le document avec `docx` (docx-js).

**API.**
```js
import { markdownToDocx } from './export-docx.mjs';
const buffer = await markdownToDocx(markdownString);   // Promise<Buffer>
```
En ligne de commande : `node export-docx.mjs entree.md sortie.docx`.

**Ce qu'il rend.** `#` titre centré en capitales ; `##` articles ; `###` ; paragraphes justifiés ; gras et italique ; listes numérotées (numérotation **redémarrée à 1 à chaque liste**) et à puces sur deux niveaux ; tableaux avec bordures fines (largeurs en DXA, ligne vide = ligne de signature de hauteur minimale) ; `---` filet ; `<!-- pagebreak -->` saut de page ; `[À COMPLÉTER : …]` surligné en jaune et en gras.

**Ce qu'il ignore silencieusement.** Tout nœud hors sous-ensemble (images, HTML autre que le saut de page, blocs de code, liens : le texte du lien reste, pas l'URL). C'est pourquoi `doc/validate.ts` signale ces constructions **avant** l'export.

**À faire dessus (jalon B5).**
1. Copie-le en `src/export/export-docx.mjs`, écris `src/export/docx.ts` (types, appel, gestion d'erreur).
2. Ajoute l'option `footer` : `markdownToDocx(markdown, { footer })` ; ajoute le texte au pied de page existant (même police, taille 9 pt, centré, sur une ligne distincte ou à côté de la pagination).
3. N'importe pas de nouveau paquet si `docx` suffit.

**Pièges déjà rencontrés (ne les réintroduis pas).**
- N'utilise **pas** l'option `highlight` de docx-js : elle produit un XML que Word peut refuser (`highlightCs`). Le surlignage passe par `shading` (`ShadingType.CLEAR`, jamais `SOLID`).
- Un tableau a besoin de `columnWidths` **et** d'une largeur sur chaque cellule, en DXA.
- Pas de `\n` dans un texte : un paragraphe par ligne.
- Pour la numérotation, une `instance` distincte par liste, sinon l'article 4 continue la liste de l'article 2.
- Les nombres du pied de page peuvent s'afficher un peu plus gros dans LibreOffice ; cosmétique, vérifier dans Word.

**Contrôler un export.** À défaut du validateur XSD utilisé pendant la conception (non fourni), vérifie dans l'ordre : `unzip -t fichier.docx` ; `pandoc -t plain fichier.docx` (le titre et les placeholders sont présents) ; si LibreOffice est installé, `soffice --headless --convert-to pdf fichier.docx` puis rends une page en image (`pdftoppm -jpeg -r 70`) et compare à `reference/bail.pdf`.

## 8. Utiliser les fichiers d'exemple comme tests de référence

- **`sample-bail.md` → test d'or de l'export.** Test vitest : `markdownToDocx(sample)` ⇒ archive valide, 8 occurrences de `À COMPLÉTER`, présence d'un tableau (`<w:tbl>`), titre en tête.
- **`sample-bail.md` → test d'or de la validation.** `validate(sample)` ⇒ `placeholders === 8`, aucune issue. Ajoute des variantes cassées (un titre de niveau 4, une image, un `[À COMPLÉTER` sans `]`) et vérifie les issues.
- **`sample-bail.md` → scénarios d'évaluation.** C'est un document de départ réaliste pour les scénarios d'édition (changer le préavis, ajouter une clause).
- **`bail.docx` et `bail.pdf`** : tu ne les compares pas octet par octet (la date de création et la version de la bibliothèque varient). Ouvre-les pour **voir** le rendu visé ; en cas de régression visuelle, rends ton export en image et compare à l'œil.
- **`template.bail-habitation.example.json`** : son `skeleton_markdown` est le squelette du bail avec des espaces réservés partout. Il passe `validate()` sans issue ; ajoute ce test.

## 9. Phase C — intégration du front (checklist)

Quand Alex te remet `index.html` :

1. Copie-le dans `public/index.html` (sans le modifier). Lance le serveur, ouvre `/?mock=1` : le mode simulé doit encore fonctionner, c'est ta preuve que le front respecte le contrat.
2. Ouvre `/` (sans `?mock=1`) et parcours le scénario réel : demande vague → questions ; réponse → contrat en streaming ; « préavis 3 mois » → modification ciblée ; export Word ; impression PDF.
   > Le mode simulé n'est actif que si l'URL contient exactement `?mock=1`. Le bandeau orange « MODE SIMULÉ » propose **Passer en mode réel** (ou ouvre simplement `/`). Sans ce paramètre, les messages partent vers `/api/chat` et le LLM.
3. Compare le front aux critères d'acceptation de `docs/SPEC-FRONTEND.md` §9, point par point.
4. **Écarts probables et leur traitement** :
   - Le front attend un événement ou un champ que le serveur n'émet pas : **corrige le serveur** pour qu'il suive le contrat, pas l'inverse.
   - Le front fait quelque chose que le contrat ne prévoit pas : corrige le **front** minimalement, ou signale-le à Alex.
   - Flux SSE saccadé ou bloqué : en-têtes `Cache-Control: no-cache, no-transform` et `X-Accel-Buffering: no`, pas de compression, vérifier le proxy.
   - Accents ou « » cassés : vérifier `charset=utf-8` partout.
5. Teste : coupure réseau en cours de génération (le front doit restaurer le document précédent) ; double clic rapide sur « Envoyer » ; rechargement en plein flux ; document de 20 000 caractères ; 401 avec `ACCESS_CODE` et 401 avec un jeton Google expiré (le front doit rafraîchir une fois puis déconnecter).
6. Rédige `docs/INTEGRATION-REPORT.md` : ce qui passe, ce qui échoue, ce qui a été corrigé et où.
7. **Avant la mise en production** : lance `npm run verif-prod` (voir `docs/EXPLOITATION.md` §5.1). Le script vérifie la configuration, applique la politique « modèles gratuits uniquement » et sonde réellement chaque modèle de la chaîne ; il échoue si le modèle principal ne répond pas. Avec `AUTH_MODE=firebase`, `ACCESS_CODE` n'est pas exigé ; ajoute `--token <idToken>` pour les sondes authentifiées (catalogue, export Word).

## 10. Quand demander à Alex

Décide seul pour tout ce qui est technique et réversible. Pose une question, courte et en français, uniquement pour :
- le **contenu juridique** des modèles (clauses, plafonds légaux, notes) : c'est lui qui le fournit, validé par un juriste ;
- le **choix de l'hébergeur** et du domaine ;
- toute **modification du contrat d'API** ou ajout de dépendance lourde ;
- l'ajout de **fonctionnalités hors périmètre** (voir ci-dessous).

## 11. Hors périmètre de la version 1.0

Ne le construis pas, même si c'est tentant : audit d'un contrat importé (upload `.docx`, commentaires et modifications suivies), paiement, PDF généré côté serveur, multi-langue, tests de charge. Ces points sont notés pour une version 2.

**Ajouts validés par Alex le 23/10/2026 (V1.1)** : comptes utilisateurs Google (Firebase Authentication) et historiques de contrats côté serveur (Firestore), réservés aux comptes authentifiés. Voir `docs/API-CONTRACT.md` §2 et §3.6–3.9, `docs/FIREBASE.md`.

## 12. Définition de « terminé » (version 1.0)

- Les critères d'acceptation globaux de `docs/SPEC-BACKEND.md` §10 sont remplis.
- La checklist du §9 est cochée, `docs/INTEGRATION-REPORT.md` écrit.
- Un nouveau venu peut lancer l'application avec `npm install`, un `.env` copié de `.env.example`, et `npm start`.
- `docs/KNOWN-ISSUES.md` liste honnêtement ce qui ne marche pas encore.

## 13. Guide d'exploitation

Le backend construit (phase A, jalons B1 à B7) est documenté dans
`docs/EXPLOITATION.md` : variables d'environnement, lancement, déploiement,
journalisation, arrêt propre, tests et évaluations.

```bash
npm install
cp .env.example .env      # renseigner OPENROUTER_API_KEY
npm start                 # compile puis lance le serveur
```

Points d'entrée : `GET /`, `GET /api/health`, `GET /api/templates`,
`POST /api/chat` (SSE), `POST /api/export/docx`.

Neuf types de contrats sont disponibles (bail d'habitation, CDD terme précis et
imprécis, CDI, stage-école, stage de qualification, apprentissage,
télétravail, prestation de services). Ils sont construits à partir du
référentiel juridique joint dans `reference/` : chaque modèle porte ses champs
obligatoires, ses notes juridiques sourcées et ses règles chiffrées, que le
serveur vérifie sur le document produit. Voir `docs/EXPLOITATION.md` §3.
