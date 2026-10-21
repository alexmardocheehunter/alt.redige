# Contrôle qualité avant livraison

## Checklist (à passer avant de présenter le contrat)
1. **Neutralité** — aucun nom d'institution, d'entreprise, de personne, adresse, téléphone ou ligne budgétaire réelle hérités des sources ; `check_neutrality.py` renvoie « OK ». Les seules identités présentes sont celles **données par l'utilisateur** dans la conversation.
2. **Parties** — rôles définis identiques partout (« le Client / le Prestataire »…), genre et accord corrects, aucune partie oubliée (ex. « l'Autorité contractante » résiduel).
3. **Cohérence des renvois** — numéros d'articles cités dans le texte (ex. « article Renouvellement ») correspondent aux titres ; liste des annexes de l'article « Annexes » = annexes réellement jointes.
4. **Chiffres** — montants en lettres = en chiffres ; devise, HT/TTC précisés ; dates de début < fin ; durée annoncée = durée calculée ; délais (préavis, mise en demeure) cohérents entre articles.
5. **Champs vides** — chaque `[champ]` restant est volontaire (information manquante) ; en dresser la liste pour l'utilisateur.
6. **Droit applicable** — textes de référence cohérents avec le pays ; références non vérifiées signalées.
7. **Complétude** — présence de : objet, durée, prix, obligations des deux parties, résiliation, différends, entrée en vigueur, annexes, clôture, signatures.
8. **Équilibre** — signaler toute clause très déséquilibrée (voir ci-dessous) plutôt que la réécrire en silence.

## Anomalies des modèles sources (déjà corrigées dans `assets/modeles/`)
Ne pas les reproduire si tu adaptes un autre modèle :
- Sécurité privée : numérotation sautant de 7 à 9 ; pas d'article « Entrée en vigueur » ; clause de vol syntaxiquement confuse (conditions mélangées aux cas).
- Stage de qualification : deux articles n°10.
- CDD à terme imprécis : « Annexe n°2 » répétée deux fois.
- Maintenance : une annexe (liste des matériels) citée dans le texte mais pas dans un article « Annexes ».
- Bail professionnel : clause résolutoire mêlant recours du Preneur et du Bailleur dans un même paragraphe.
- Entretien : désignation « Fournisseur » au lieu de « Prestataire » ; tableau d'annexe sans total prévu.
- Formation : liste des textes de référence laissée vide.
- Incohérences de forme : « franc cfa » / « francs CFA », « Etat » / « État », parties tantôt « Employé » tantôt « salarié ».

## Déséquilibres à signaler (présents dans les sources, souvent voulus par la partie qui commande)
- Frais d'enregistrement systématiquement à la charge du Prestataire.
- Résiliation « pour motif d'intérêt général » réservée à la partie publique (variante publique seulement).
- Client non responsable des risques du Consultant ; Consultant seul responsable des réclamations de tiers.
- Confidentialité sans limitation de durée.
- Prix « ferme et non révisable » même pour de longues durées (risque d'érosion pour le prestataire).
Les présenter comme des « points de négociation possibles », sans moraliser.

## Avertissement
Les contrats produits sont des **projets de rédaction** : ils ne remplacent pas la relecture d'un juriste, surtout pour les baux, les contrats de travail et tout contrat à fort enjeu financier. Le dire en une phrase dans la synthèse finale, sans en faire un sermon.
