# Format source des contrats (« Markdown contrat »)

Les modèles de `assets/modeles/` et les contrats que tu rédiges s'écrivent dans ce format simple ; `scripts/build_contract.py` le convertit en .docx. Écrire dans ce format (plutôt que de produire du Word à la main) garantit une mise en forme identique d'un contrat à l'autre et la numérotation automatique des articles.

## En-tête (optionnel)
```
---
titre: Contrat de consultance
sous-titre: (facultatif, affiché sous le titre en italique)
sommaire: oui        # ou non
format: A4           # ou Letter
---
```

## Balises
| Syntaxe | Rendu |
|---|---|
| `# Titre` | Titre du contrat (centré, majuscules). Un seul par contrat |
| `~Entre`, `~D'une part`, `~Et`… | Étiquette en gras (bloc « parties » et formule « IL A ÉTÉ CONVENU… ») |
| `## Objet` | `ARTICLE n : OBJET` — **n est calculé automatiquement** ; ne jamais numéroter à la main |
| `### a) Obligations du Prestataire` | Sous-titre en gras |
| `- élément` | Puce |
| ligne simple | Paragraphe justifié |
| `**texte**` | Gras |
| `[à compléter]` ou `……` | Champ à compléter, **surligné en jaune** dans le .docx |
| `\| a \| b \|` | Tableau (1re ligne = en-tête ; la ligne `\|---\|` est facultative) |
| `@annexe Annexe n°1 : Titre` | Saut de page + titre d'annexe souligné |
| `@fait Fait à [lieu], le [date]` | Formule de clôture |
| `@signatures Pour le Client \| Pour le Prestataire` | Bloc de signatures (2 à 3 colonnes) |
| `@paraphe` | « Ce contrat comporte N pages paraphées par les parties » (N calculé par Word) |
| `@saut` | Saut de page |
| `<!-- commentaire -->` | Ignoré au rendu — sert aux notes et variantes (`ALT-…`) |

## Règles pratiques
- Les annexes se placent **après** `@paraphe`, chacune introduite par `@annexe`.
- Ne pas imbriquer de commentaires `<!-- ... -->` (le premier `-->` ferme le commentaire).
- Un champ entre crochets doit être auto-suffisant à la lecture (« [montant en lettres et en chiffres] »), pas un renvoi interne (« voir references/... »), car il apparaîtra tel quel dans le contrat.
- Le sommaire est statique (titres sans numéros de page) : il est toujours cohérent avec les articles réellement présents.

## Commande
```
python scripts/build_contract.py contrat.md /mnt/user-data/outputs/Contrat_XXX.docx
python scripts/check_neutrality.py /mnt/user-data/outputs/Contrat_XXX.docx
```
