# alt.redige — Audit du skill « rédaction de contrats »

**Objet** : `skill principal de redaction-contrats/` (22 fichiers, ~110 Ko), skill
créé par l'humain et ajouté au dépôt le 21/10/2026.
**Date** : 2026-10-21.
**Méthode** : inspection intégrale des 22 fichiers ; exécution réelle de
`check_neutrality.py` sur les 11 modèles ; rejouage du parseur de
`build_contract.py` ; vérification mécanique des affirmations de
`references/controle-qualite.md`.

> `python-docx` n'est pas installé sur cette machine et **rien n'a été
> installé** : la génération du `.docx` n'a donc pas pu être exécutée. La
> logique pure du parseur (métadonnées, suppression des commentaires, articles,
> balises) a été vérifiée par ré-exécution.

---

## 1. Verdict

# ✅ Skill de très bonne qualité — 3 défauts mineurs à corriger

C'est le meilleur artefact du dépôt. Sa discipline juridique (neutralité,
procédure de vérification des textes, signalement des déséquilibres) est
**au-dessus** de ce que j'ai trouvé dans le reste du projet, y compris dans
les documents que j'avais moi-même rédigés.

Les trois défauts trouvés sont réels mais mineurs, tous deux dans
`check_neutrality.py` (un crash Windows, des faux positifs), plus un problème
de portabilité de chemin.

**Réserve importante :** le skill et le backend **ne partagent pas le même
format de document** et **ne couvrent pas les mêmes types de contrat**. Le
skill n'est pas un substitut du backend, et l'inverse non plus (§4).

---

## 2. Structure

| Dossier | Contenu | Volumétrie |
|---|---|---|
| `SKILL.md` | Frontmatter (`name`, `description`), principe directeur, workflow en 5 étapes, table des contenus, rappels de style | 7,5 Ko |
| `assets/modeles/` | **11 modèles** de contrats au format « Markdown contrat » | 4,3–12,8 Ko |
| `references/` | 7 documents : guide par type, contrôle qualité, textes de référence, clauses communes, hors corpus, module secteur public, format source | 2,4–8,1 Ko |
| `scripts/` | `build_contract.py` (Markdown → `.docx`), `check_neutrality.py` (détection de résidus) | 12,2 + 2,8 Ko |
| `evals/evals.json` | 4 scénarios d'évaluation | 2,0 Ko |

**11 modèles** : consultance, assistance technique, formation du personnel,
maintenance de matériels, entretien de locaux, sécurité privée, bail de
bureau/professionnel, CDD terme précis, CDD terme imprécis, stage de
qualification, stage-école.

---

## 3. Ce qui est bon — et vérifié

### 3.1 Le principe de neutralité : la bonne idée, et elle tient

> « Un contrat produit par ce skill ne contient que : des rôles génériques, les
> informations que l'utilisateur a données, des champs `[à compléter]` pour tout
> le reste. […] Un champ vide surligné se voit et se corrige ; une fausse
> information passe inaperçue. »

C'est exactement la bonne articulation entre traçabilité et erreur : on rend
le manque visible plutôt que de le combler. Vérifié : **11/11 modèles** ne
contiennent aucun marqueur d'institution (`Ministère`, `République`,
`DGBF`, `COCAN`, `PRIME`, `PDU`, `BP`, `Direction…`) dans le corps rendu.

### 3.2 L'hygiène juridique des références — exemplaire

`references/textes-de-reference.md` est le fichier le plus solide du dépôt :

| Qualité | Extrait |
|---|---|
| Refus de présenter les textes comme une vérité | « ils sont donnés ici comme **points de départ, pas comme vérité à jour** : une loi peut avoir été modifiée ou abrogée » |
| Procédure explicite en 4 étapes | (1) proposer le texte ; (2) vérifier la vigueur si l'outil de recherche est disponible ; (3) **sinon le signaler** dans la synthèse ; (4) si autre pays, un champ à compléter plutôt qu'une invention |
| Signalement des points incertains | « Le modèle imprécis cite l'article 15.6 […] : **vérifier le numéro** » ; « Ces textes ont pu être remplacés par la loi de 2018 : **à vérifier** » ; « pertinence à vérifier pour un local non résidentiel » |
| Interdiction de citer un article incertain | « Ne jamais citer un numéro d'article dont on n'est pas certain » |
| Repli explicite | « …et, à défaut, par le droit commun des contrats applicable en [pays] » |

**Point décisif :** dans les 11 modèles, l'article « Textes de référence » ne
contient **que des champs à compléter** (`[acte uniforme / loi applicable aux
baux à usage professionnel]`, `[loi et décret relatifs aux rapports
bailleurs / locataires, dans leurs dispositions applicables]`…). Le skill ne
affirme donc **jamais** une référence qu'il ne peut pas vérifier : il transmet
au rédacteur un catalogue, pas une assertion. C'est la bonne pratique, et
elle est plus exigeante que celle du backend (où les `legal_notes` portent
des `[S02, art. 169 bis]` vérifiables — autre approche, également
défendable, mais le skill est plus prudent).

### 3.3 Les anomalies annoncées comme corrigées le sont — vérification mécanique

`references/controle-qualite.md` liste 8 anomalies des modèles sources et
affirme qu'elles sont « déjà corrigées ». **Vérifié une par une** :

| Anomalie annoncée | Vérification | Verdict |
|---|---|---|
| Sécurité privée : numérotation sautant de 7 à 9 | Numérotation générée : ordre des `##`, 15 articles | ✅ corrigé |
| Stage de qualification : deux articles n°10 | 16 articles, aucun doublon | ✅ corrigé |
| CDD à terme imprécis : « Annexe n°2 » répétée | Annexes 1, 2, 3 sans doublon | ✅ corrigé |
| Maintenance : annexe citée mais absente de l'article « Annexes » | Article « Annexes » présent, liste cohérente | ✅ corrigé |
| Bail professionnel : clause résolutoire mêlant les deux recours | Deux paragraphes symétriques : « Inexécution par le Bailleur » / « Inexécution par le Preneur » | ✅ corrigé |
| Entretien : « Fournisseur » au lieu de « Prestataire » | 16 « Prestataire », 0 « Fournisseur » | ✅ corrigé |
| Formation : liste des textes de référence vide | Article « Textes de référence » non vide | ✅ corrigé |
| Incohérences de forme (« franc cfa », « Etat ») | Non rejoué (contrôle lexical) — **non vérifié** | ⚠️ |

**C'est un point fort rare** : un document qui declare ses corrections et qui
les tient. J'ai vérifié 7 anomalies sur 8, et je n'ai trouvé **aucune**
correction incomplète.

### 3.4 Les déséquilibres à signaler

`controle-qualite.md` liste 5 déséquilibres présents dans les sources
(frais d'enregistrement à la charge du Prestataire, confidentialité sans
limitation de durée, prix ferme et non révisable…) et demande de les
présenter comme « points de négociation possibles, sans moraliser ». C'est un
apport réellement métier : un modèle qui sait *ce qui est déséquilibré* vaut
beaucoup plus qu'un modèle qui ne le voit pas.

### 3.5 Les 4 scénarios d'évaluation sont bien choisis

`evals/evals.json` couvre exactement les cas difficiles :

1. **cas de figure** — gardiennage, avec des parties réelles à reprendre ;
2. **autre pays** — « Entreprise privée au Sénégal » → vérifier que les
   références ivoiriennes **ne sont pas transposées** ;
3. **hors corpus** — vente d'ordinateurs → squelette universel + articles
   extrapolation, **annoncé comme tel** ;
4. **reprise d'un document existant** → neutraliser un bail d'administration.

Le scénario 2 est particulièrement bien choisi : c'est exactement le piège
classique (transposer le droit ivoirien à un autre pays).

### 3.6 Le workflow ne demande pas plus d'une question

« Si la demande est ambiguë entre deux types (ex. contrat de travail vs
prestation), poser **une** question de clarification. » et « poser les
questions du type concerné **en un seul message**, avec des propositions par
défaut ». C'est aligné avec le protocole agent (`ask_user`, une question par
tour).

---

## 4. Défauts trouvés

### 🟠 D1 — `check_neutrality.py` plante sur Windows (P2)

**Emplacement** : `scripts/check_neutrality.py:66`.

**Reproduction** :

```
py check_neutrality.py assets/modeles/bail-bureau-professionnel.md
2 résidu(s) non neutre(s) …
Traceback (most recent call last):
  File "check_neutrality.py", line 66, in main
    print(f"  - « {term} » …{ctx}…")
UnicodeEncodeError: 'charmap' codec can't encode character '\u2192' in position 95
```

**Cause** : la sortie standard est encodée en `cp1252` sous Windows, et le
contexte affiché contient `→` (U+2192), présent dans les commentaires `ALT-…`
des modèles.

**Impact** : au lieu de la liste des résidus à corriger, l'agent reçoit une
trace Python. Sur Linux (stdout UTF-8) le bug ne se manifeste pas — d'où son
caractère non détecté jusqu'ici.

**Correction** : encoder explicitement la sortie, ou remplacer `→` par `->`
dans l'affichage. Le plus robuste : `sys.stdout.reconfigure(encoding="utf-8")`
en tête de module (Python ≥ 3.7).

### 🟠 D2 — Le contrôle de neutralité signale 10 faux positifs sur ses propres modèles (P2)

**Emplacement** : `scripts/check_neutrality.py`, fonction `read_text()`.

**Constat** : sur un fichier `.md`, le script lit le fichier **tel quel**, sans
retirer les commentaires HTML. Or les 11 modèles portent leurs variantes
dans des commentaires :

```html
<!-- ALT-secteur public : « Imputation budgétaire » → module secteur public -->
```

Or `build_contract.py:190` **retire** ces commentaires avant le rendu :

```python
text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
```

**Mesure** :

| Fichier | Résidus sur le `.md` source | Résidus sur le texte généré |
|---|---|---|
| 10 modèles sur 11 | 1 à 2 | **0** |

**Nuance importante** : le flux **documenté** est correct — le contrôle est
passé sur le `.docx` **généré**, dont les commentaires sont déjà supprimés :

```
python scripts/build_contract.py contrat.md sortie.docx
python scripts/check_neutrality.py sortie.docx      # ← le .docx, pas le .md
```

Le bug ne se manifeste donc pas dans le flux nominal. Il se manifeste si un
agent contrôle le `.md` source — ce que la docstring du script autorise
explicitement (« dans un contrat (**.md** ou .docx) »), et ce qu'un agent
pressé fera.

**Impact** : 10 alertes sur des fichiers parfaitement corrects. Un agent qui
«corrige » pour faire passer le contrôle **supprimerait des directives
légitimes** (variantes secteur public) et dégraderait les modèles.

**Correction** : retirer les commentaires dans `read_text()` pour le cas
`.md`, exactement comme le builder le fait — une seule ligne :

```python
if path.lower().endswith(".docx"):
    ...
else:
    text = open(path, encoding="utf-8").read()
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)   # <- à ajouter
```

### 🟡 D3 — Chemin de sortie codé en dur, inexistant ici (P3)

`SKILL.md` référence `/mnt/user-data/outputs/` (3 occurrences). Ce chemin est
une convention de l'environnement Claude ; il **n'existe pas** sur cette
machine (`Test-Path` → faux) ni sous sa forme Windows.

**Correction** : utiliser un chemin relatif (`./output/`) ou une variable
d'environnement.

### 🟡 D4 — Le contrôle «_extrait_» ne couvre que les modèles, pas les contrats produits (P3)

Le script ne connaît que les résidus **issus des sources** (liste `ALWAYS`).
Un contrat rédigé qui contiendrait, par exemple, le nom d'une administration
citée par l'utilisateur — ou une coordinates d'une autre administration — ne
serait pas signalé, sauf ajout manuel via `--extra`.

C'est assumé dans la docstring (« utiliser `--extra` pour ajouter des termes à
bannir ») et la consigne skill dit de ne pas traiter comme un résidu une
société citée par l'utilisateur. **Défaut assumé, pas un bug** — mais la
couverture « institution réelle citée par l'utilisateur » mérite une note
dans la synthèse finale.

---

## 5. Le point structurant : le skill et le backend sont deux mondes

C'est le résultat le plus important de cet audit.

### 5.1 Formats de document incompatibles

| | Skill (« Markdown contrat ») | Backend (`API-CONTRACT.md` §5) |
|---|---|---|
| Article | `## Objet` (numérotation **automatique** par le générateur) | `## Article 1 – Objet` (numérotation **dans le texte**) |
| Champ à compléter | `[Dénomination ou nom et prénoms du Bailleur]`, `[adresse]`, `[montant en lettres]` | `[À COMPLÉTER : description]` |
| Balises | `@annexe`, `@fait`, `@signatures`, `@paraphe`, `@saut`, `@centre`, `~Entre` | aucune |
| Ancres | `<!-- ALT-… -->` | interdit (`forbidden_construct`) |

**Mesure** : `validate()` du backend sur les 11 modèles → `placeholders = 0`
pour tous, et 1 à 5 `forbidden_construct` par modèle (les commentaires
`ALT`). Les balises `@annexe` / `@signatures` seraient rendues comme des
paragraphes ordinaires.

**Conséquence** : les 11 modèles du skill **ne peuvent pas être chargés
comme modèles du backend** sans convertisseur. Le squelette du backend
(`data/templates/*.json`) est un autre format, issu d'un autre référentiel.

### 5.2 Couverture des types : complémentaire, pas redondante

| | Types |
|---|---|
| **Skill seul** (7) | assistance-technique, bail-bureau-professionnel, consultance, entretien-locaux, formation-personnel, maintenance-materiels, securite-privee |
| **Backend seul** (5) | apprentissage, bail-habitation, cdi, prestation-service, teletravail |
| **Communs** (4) | cdd-terme-imprecis, cdd-terme-precis, stage-ecole, stage-qualification |

Le skill couvre le **segment des contrats de services et de patrimoine
administratifs** (consultance, assistance technique, maintenance, entretien,
gardiennage, bail de bureau) que le backend n'a pas ; le backend couvre le
**droit du travail** (CDI, CDD, apprentissage, stage, télétravail) et le bail
d'habitation, que le skill n'a pas.

**Lecture stratégique** : le corpus `reference/` contient 12 contrats réels
d'administrations ivoiriennes (fournitures, assistance technique, consultance,
bail de bureau, bail professionnel, entretien, formation, maintenance,
sécurité privée, CDD, stages) — **exactement les 12 que le skill analyse**,
alors que le backend les avait reconstruits sous une autre forme à partir du
seul référentiel juridique. **Les deux efforts sont complémentaires et
pourraient être fusionnés**, ce qui porterait la couverture du produit de 9
à ~16 types.

### 5.3 Ce que le skill apporte que le backend n'a pas

| Apport du skill | Valeur |
|---|---|
| Corpus de 11 contrats réels **analysés** (structure, clauses, style) | La méthode d'un modèle réel, pas d'un squelette abstrait |
| Procédure de vérification des textes en 4 étapes | Absente du backend |
| Liste des **déséquilibres** à signaler | Absente du backend |
| **Variantes** (`ALT-…`) pour le secteur public | Le backend n'a qu'un type de bail, pas de variante |
| Contrôle automatique de neutralité en post-traitement | Le backend n'a pas d'équivalent |
| Principe « champ vide > fausse information » | Le backend a le même principe, mais appliquée au placeholder `[À COMPLÉTER]` |

---

## 6. Ce que ce skill m'a appris — et qui a fait corriger le backend

En rédigeant l'audit du skill, un **désaccord de conception** est apparu entre
le skill et ma correction du constat **P0-3** du backend.

**Mon implémentation** (vague 0) : le modèle reçoit l'outil `ask_user` et le
prompt lui disait « pose une question à l'utilisateur quand une information
indispensable manque ».

**Résultat mesuré** (campagne réelle) : sur « bail d'habitation pour un studio
à Yopougon, 12 mois, loyer 70 000 FCFA » — où le type, l'objet, le loyer et la
durée sont connus — le modèle a **posé une question** au lieu de rédiger, et
les scénarios 03, 04, 05 et 06 de l'évaluation ont échoué (« aucun canvas_set
reçu »). Le modèle sur-demandait, y compris sur des champs **facultatifs**
(`depot_garantie`, `charges`).

**La règle du skill** (§2, « Recueillir les faits — sans interroger
inutilement ») dit l'inverse :

> « Extraire de la demande tout ce qui s'y trouve déjà […] Pour le manquant,
> poser les questions […] **en un seul message**, avec des propositions par
> défaut. **Si l'utilisateur veut un premier jet sans répondre, produire le
> contrat avec champs à compléter et lister ce qui manque.** »

Et le scénario 03 de l'évaluation du backend porte exactement ce nom :
« Parties inconnues → **espaces réservés**, aucun nom inventé ».

**Conclusion** : j'avais sur-contraint le modèle. Le seuil correct n'est pas
« un champ obligatoire manque » mais « **rien** n'est exploitable : ni le type
de contrat, ni son objet ». Le garde-fou **serveur** que j'avais écrit
(« aucun champ obligatoire renseigné → refus ») reste le plancher dur
correct ; c'est le **prompt** qui doit fixer le critère d'usage de
`ask_user`.

**Correction appliquée** (`prompts/system.fr.md`) :

> `ask_user(...)` : pose une question **uniquement si la demande ne permet
> pas d'identifier le type de contrat ou son objet** […] **Toutes les autres
> informations manquantes deviennent des espaces réservés `[À COMPLÉTER : …]`.**

Le skill a fourni la règle normative de mon propre garde-fou. C'est
l'argument le plus fort en faveur de son intégration.

---

## 7. Plan d'action

### Pour le skill (immédiat, faible risque)

| # | Action | Priorité |
|---|---|---|
| S1 | `check_neutrality.py` : retirer les commentaires HTML pour le cas `.md` (1 ligne) | P2 |
| S2 | `check_neutrality.py` : sortie UTF-8 explicite (`sys.stdout.reconfigure`) | P2 |
| S3 | Remplacer `/mnt/user-data/outputs/` par un chemin relatif ou une variable | P3 |
| S4 | Exécuter `check_neutrality.py` sur les 11 modèles **après S1** : attendu 0 résidu | critère d'acceptation de S1 |

### Pour l'intégration skill ↔ backend (décision humaine)

| # | Question | Pourquoi c'est une décision humaine |
|---|---|---|
| I1 | Le backend doit-il **adopter** les 11 modèles du skill ? | Il faut un convertisseur (« Markdown contrat » → format backend) et une relecture juridique des 7 types nouveaux. |
| I2 | Le skill doit-il **adopter** le format du backend ? | Le skill est un produit de rédaction autonome (avec `.docx` et contrôle de neutralité) ; le backend est un produit conversationnel. Les deux ont des publieurs différents. |
| I3 | Faut-il une **source unique de vérité** pour les clauses communes et les textes de référence ? | Aujourd'hui : `references/clauses-communes.md` (skill) vs `data/templates/*.json` + `data/legal-sources.json` (backend). Deux référentiels à garder synchronisés. |
| I4 | Le backend doit-il adopter le **contrôle de neutralité** comme garde-fou de production ? | Le backend a déjà un contrôle d'invention (`src/doc/facts.ts`) ; la neutralité (rôles génériques, pas d'institution) est une garantie complémentaire et:type analogue. |

**Le pont technique le plus simple, si I1 est retenu** : un convertisseur
`assets/modeles/*.md` → `data/templates/<id>.json` qui produit le
`skeleton_markdown` attendu par le backend, en transposant :
`## Titre` → `## Article N – Titre`, `[champ]` → `[À COMPLÉTER : champ]`, et
en supprimant les balises `@…` (qui n'ont pas d'équivalent côté backend).

---

## 8. Limites de cet audit

1. **`build_contract.py` n'a pas pu être exécuté** (`python-docx` absent,
   aucune installation autorisée). La **sortie Word n'a donc pas été
   vérifiée** : ni l'ouverture dans Word, ni le rendu des champs surlignés, ni
   le pied de page « Page X sur Y », ni la numérotation automatique. Seule la
   logique pure du parseur a été vérifiée.
2. **Le rendu Word n'a pas été comparé** à `reference/bail.pdf` ni à
   `reference/bail.docx` (ce sont d'autres documents).
3. **Les 4 scénarios de `evals/evals.json` n'ont pas été joués** : ils
   supposent un agent capable de produire un `.docx`, donc
   `python-docx`.
4. **Aucune vérification juridique** des 11 modèles eux-mêmes : le présent
   audit porte sur la **cohérence interne** du skill, sa **traçabilité** et
   son **hygiène de traitement des références**. La conformité au droit
   ivoirien des clauses de fond reste à valider par un juriste.
5. **L'étape 2 du workflow** (« poser les questions […] en un seul message »)
   n'est pas outillée : le skill n'a pas de mécanisme de question
   structurée comparable à `ask_user`. C'est cohérent avec son usage
   conversationnel, mais c'est un écart avec le protocole agent.
6. Les **modèles sources** (`reference/*.docx`) n'ont pas été ré-analysés
   ligne à ligne : j'ai vérifié que les anomalies déclarées sont corrigées
   dans les modèles dérivés, pas que la dérivation est exhaustive.

---

## 9. Conclusion

Le skill est **solide, prudent et cohérent**. Sa valeur ne tient pas à ses
11 fichiers, mais à trois décisions :

1. **ne jamais combler un vide par une invention** (neutralité, placeholders) ;
2. **ne jamais présenter un texte non vérifié comme une vérité** (procédure
   en 4 étapes, signalement explicite des incertitudes) ;
3. **savoir ce qui est déséquilibré** dans un contrat et le dire.

Ces trois décisions sont exactement celles que l'audit du backend réclamait.
Le skill peut donc servir de **référence normative** pour le produit — et il
vient de le faire, en tranchant le débat que j'avais mal arbitré sur P0-3.

Les défauts trouvés sont mineurs et se corrigent en quelques lignes. Le
travail de fond à décider est **l'intégration** : aujourd'hui le skill et le
backend sont deux corpus complémentaires qui s'ignorent, alors que leurs
couverture s'additionnent.
