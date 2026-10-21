# Module « secteur public » (optionnel — désactivé par défaut)

Les modèles sources ont été conçus pour une administration. Les modèles de `assets/modeles/` en ont été **neutralisés** : ni institution, ni nom propre, ni vocabulaire administratif. Ce module regroupe les clauses propres au secteur public. **Ne l'utiliser que si l'utilisateur dit expressément que le contrat est conclu par une entité publique** (administration, établissement public, projet financé sur budget public…). Même dans ce cas, ne jamais insérer le nom d'une institution réelle, une adresse ou un signataire : laisser des champs à compléter.

Dans cette variante, la partie publique peut s'appeler « l'Autorité contractante » à la place de « le Client » (renommer partout, de façon cohérente) et lancer le contrôle avec `check_neutrality.py --public`.

## Clauses à insérer

**Imputation budgétaire** (dans Rémunération, ou article distinct pour le bail) :
« La rémunération des prestations est imputée au budget de [l'État / la collectivité / l'établissement] de l'année [année], sur la destination [code], ligne budgétaire [numéro], dénommée « [libellé] ». »
Les modèles sources renseignaient des lignes précises (services extérieurs de gardiennage, bâtiments administratifs à usage de bureau, rémunération du personnel contractuel). Ces numéros dépendent de la nomenclature budgétaire en vigueur : **toujours les laisser à compléter**.

**Intérêt général** (Résiliation) : ajouter « ou pour motif d'intérêt général invoqué par [l'Autorité contractante] » aux cas de résiliation immédiate.

**Bail — usage des lieux** : « …servira à l'exécution de la mission de service public du Preneur et à tout autre usage lié à ladite activité. »

**Bail — clauses résolutoires (variante publique)** :
- faute du Bailleur, y compris celle affectant l'exécution du service public : résiliation par le Preneur après mise en demeure infructueuse (par tout moyen laissant trace écrite), frais à la charge du Bailleur ;
- résiliation sans faute du Bailleur : délai raisonnable suivant l'intérêt du service public, fixé d'accord parties ;
- faute du Preneur : résiliation par le Bailleur six (6) mois après une mise en demeure infructueuse par lettre recommandée avec accusé de réception ;
- résiliation sans faute du Preneur, dans l'intérêt du service public : douze (12) mois après mise en demeure du Bailleur.

**Bail — enregistrement** : « Le Preneur requiert expressément de l'autorité chargée de l'enregistrement la dispense de timbre et l'enregistrement gratis du présent bail, conformément aux articles [références] du code des impôts. » (vérifier les articles).

**Horaires** (travail, stage) : « conformément aux horaires de la fonction publique » (exemple : 07 h 30 – 12 h 30 et 13 h 30 – 16 h 30, du lundi au vendredi).

**Indemnités de stage** : « Les paiements sont imputés au budget [de l'État] [année], sur la destination [code], ligne [numéro], dénommée « [libellé] ». »

**Entrée en vigueur** : « …dès sa signature par les parties sur notification faite par [l'Autorité contractante] au Prestataire » (notification = condition d'entrée en vigueur).

**Annexes publiques courantes** : cahier des charges techniques et particulières ; termes de référence ; CV et diplômes.

**Textes** : voir `textes-de-reference.md` (lignes « secteur public »).
