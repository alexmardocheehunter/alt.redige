---
name: redaction-contrats
description: Rédige des contrats neutres, structurés et prêts à signer en français, à partir de 11 modèles éprouvés (consultance, assistance technique, formation du personnel, maintenance de matériels, entretien de locaux, sécurité privée / gardiennage, bail de bureau ou professionnel, CDD à terme précis ou imprécis, stage de qualification, stage-école) et d'une bibliothèque de clauses pour tout autre type (vente, fourniture, CDI, NDA, partenariat…). Produit un fichier Word (.docx) mis en forme, sans nom d'institution, d'entreprise ni de personne réels. À utiliser dès que l'utilisateur demande de rédiger, adapter, compléter, relire ou « mettre en forme » un contrat, une convention, un bail, un contrat de travail ou de stage, un contrat de prestation ou de services, ou parle de clauses, d'avenant, d'annexes, de modèle de contrat, même sans prononcer le mot « skill » ni préciser le type exact.
---

# Rédaction de contrats

Ce skill transforme une demande (« fais-moi un contrat de gardiennage pour mon entreprise ») en un contrat complet, cohérent et neutre, au format Word. Il s'appuie sur 12 contrats réels analysés : leur structure, leurs clauses et leur style ont été conservés, mais **toute identité (institution, ministère, société, personne, adresse, ligne budgétaire) en a été retirée**.

## Principe directeur : neutralité
Un contrat produit par ce skill ne contient que :
- des **rôles génériques** pour les parties (« le Client », « le Prestataire », « l'Employeur », « le Bailleur »…) ;
- les **informations que l'utilisateur a données** dans la conversation ;
- des **champs `[à compléter]`** pour tout le reste.

Pourquoi : les modèles d'origine étaient écrits pour un organisme précis. Réutiliser tel quel un nom, une adresse, un signataire ou une rubrique budgétaire dans un nouveau contrat serait une erreur grave (mauvais engagé, faux en écriture). Un champ vide surligné se voit et se corrige ; une fausse information passe inaperçue. **Ne jamais inventer** un montant, une date, un numéro de registre ou un nom pour « faire plus complet ».

## Workflow

### 1. Identifier le type de contrat
Ouvrir `references/guide-par-type.md` (tableau « Choisir le modèle »). Si le type est dans le corpus, utiliser le modèle de `assets/modeles/`. Sinon, suivre `references/contrats-hors-corpus.md`. Si la demande est ambiguë entre deux types (ex. contrat de travail vs prestation), poser **une** question de clarification.

### 2. Recueillir les faits — sans interroger inutilement
Extraire de la demande tout ce qui s'y trouve déjà (parties, objet, dates, prix, lieu). Pour le manquant, poser les questions du type concerné (`guide-par-type.md`, §2) **en un seul message**, avec des propositions par défaut. Si l'utilisateur veut un premier jet sans répondre, produire le contrat avec champs à compléter et lister ce qui manque. Trois informations conditionnent le fond et valent la peine d'être demandées si elles manquent :
- **Droit applicable / pays** (les modèles visent la Côte d'Ivoire et l'espace OHADA ; ne pas transposer les références à un autre pays) ;
- **Secteur public ou privé** (le public déclenche `references/module-secteur-public.md`, jamais par défaut) ;
- **Rôle de l'utilisateur** (Client ou Prestataire, Bailleur ou Preneur…) : ajuster le ton des clauses déséquilibrées en conséquence, voir `controle-qualite.md`.

### 3. Rédiger à partir du modèle
1. Lire le modèle correspondant dans `assets/modeles/` (format décrit dans `references/format-source.md`).
2. Le copier dans un fichier de travail, remplir les champs connus, **adapter** : supprimer les articles inutiles, choisir les variantes signalées par les commentaires `<!-- ALT-… -->`, ajouter des articles depuis `references/clauses-communes.md` si besoin.
3. Remplacer les « [trois (3)] » ou autres valeurs par défaut seulement si l'utilisateur donne une autre valeur.
4. Ne pas numéroter les articles à la main : le générateur le fait.
5. Textes de référence : `references/textes-de-reference.md`. Ne jamais citer un numéro d'article incertain.

### 4. Générer le Word
```bash
python scripts/build_contract.py contrat.md /mnt/user-data/outputs/<Nom_du_contrat>.docx
python scripts/check_neutrality.py /mnt/user-data/outputs/<Nom_du_contrat>.docx
```
(Chemins relatifs au dossier du skill.) Le générateur produit : titre, sommaire, parties, articles numérotés, annexes et tableaux, bloc de signatures, pied de page « Page X sur Y », champs à compléter surlignés en jaune. Si `check_neutrality.py` signale un résidu, le corriger et régénérer. Si l'utilisateur a cité une société ou une institution dans sa demande, c'est légitime : ne pas la traiter comme un résidu (le script ne détecte que les noms issus des sources ; utiliser `--extra` pour ajouter des termes à bannir).

Si l'environnement ne permet pas d'exécuter les scripts, rédiger le contrat directement dans la réponse avec la même structure.

### 5. Contrôler, puis présenter
Passer la checklist de `references/controle-qualite.md` (cohérence des renvois, montants lettres/chiffres, annexes, dates). Pour un contrat important, convertir en PDF et regarder le rendu. Présenter le fichier avec `present_files`, puis une **synthèse courte** :
- type de contrat et modèle utilisé ;
- hypothèses retenues (une ligne chacune) ;
- **champs restant à compléter** (liste) ;
- 2-3 points d'attention ou de négociation (clauses déséquilibrées, délais légaux à vérifier, références non vérifiées) ;
- une phrase rappelant que c'est un projet à faire relire par un juriste.

Ne pas recopier le contrat dans la réponse : le fichier suffit.

## Adapter un document existant
Si l'utilisateur fournit son propre contrat à améliorer ou à neutraliser : lire le fichier, repérer les identités à retirer, comparer sa structure au modèle le plus proche, proposer les clauses manquantes (`clauses-communes.md`, section C pour les compléments) et signaler les anomalies listées dans `controle-qualite.md`. Pour modifier un .docx existant en conservant sa mise en forme, suivre le skill `docx` ; pour en créer un nouveau, ce skill.

## Contenu du skill
| Fichier | Quand le lire |
|---|---|
| `references/guide-par-type.md` | Toujours, étape 1 et 2 |
| `assets/modeles/*.md` | Étape 3 : le modèle du type choisi (un seul, sauf hybride) |
| `references/clauses-communes.md` | Adapter une variante, ajouter une clause, construire hors corpus |
| `references/textes-de-reference.md` | Remplir l'article « Textes de référence » |
| `references/module-secteur-public.md` | Seulement si l'utilisateur est une entité publique |
| `references/contrats-hors-corpus.md` | Type absent du corpus |
| `references/controle-qualite.md` | Étape 5 |
| `references/format-source.md` | Syntaxe du fichier source, si besoin |
| `scripts/build_contract.py`, `scripts/check_neutrality.py` | Étape 4 |

## Rappels de style
Français juridique sobre, présent de l'indicatif, rôles définis constants, énumérations à tirets terminés par « ; », délais en lettres puis chiffres (« trente (30) jours »), montants en lettres et en chiffres avec devise et HT/TTC. Répondre dans la langue de l'utilisateur ; si le contrat doit être rédigé dans une autre langue que le français, conserver la structure des modèles et traduire les clauses en adaptant les références juridiques.
