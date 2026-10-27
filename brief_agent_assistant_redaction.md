# Brief : corrections et améliorations de l'« Assistant de rédaction » (contrats)

Tu travailles sur le code source d'une application de rédaction de documents juridiques assistée par IA (contrats, Côte d'Ivoire). L'écran est divisé en deux : un **chat** à gauche (« Assistant de rédaction ») et un **document éditable** à droite (« Cliquez dans le texte pour le modifier directement », exports Word et PDF). Un assistant LLM modifie le document via des outils.

Des tests manuels ont révélé des bugs d'interface, un bug de rendu du document (tableaux et listes) et plusieurs faiblesses du prompt système et des outils de l'assistant. Tu es responsable du code : **commence par explorer le dépôt** (stack, composants du chat, éditeur, outils de l'assistant, prompt système) avant de modifier quoi que ce soit, puis implémente tout ce qui suit selon les priorités. Adapte les solutions proposées à la stack réelle. Les extraits de code ci-dessous sont indicatifs.

## Ordre de priorité

1. **P1 : Retours à la ligne perdus** (le document lui-même est cassé)
2. **P2 : Layout du chat et suggestions** (les messages sont cachés)
3. **P3 : Fiabilité de l'assistant** (date, compteur de champs, clauses engageantes, prompt système)
4. **P4 : Confort** (réflexion en ligne vivante, historique de versions, formulaire de champs)

---

## P1. Les retours à la ligne disparaissent dans le document

### Symptômes observés
- Article 12 (Signatures) : le tableau s'affiche en une seule ligne de texte brut :
  `| L'Entreprise | Le Stagiaire | |---|---| | Lu et approuvé | Lu et approuvé | | Signature : | Signature : | | Nom : | Nom : | ...`
  Il n'est jamais rendu comme un vrai tableau.
- Article 4 (Missions) : `- [À COMPLÉTER : mission principale] ; - [À COMPLÉTER : missions complémentaires]` s'affiche sur une seule ligne au lieu de deux puces.
- Conclusion : **le problème n'est pas spécifique aux tableaux, ce sont les `\n` qui disparaissent quelque part dans la chaîne.**

### Diagnostic à mener
1. Inspecter la chaîne brute du document juste après un appel d'outil d'édition (base ou mémoire).
   - Si elle **contient** des `\n` : bug de rendu. Vérifier la présence d'un parseur GFM (ex. `remark-gfm`), les styles `white-space`, et tout `replace(/\s+/g, ' ')` ou équivalent qui écrase les retours.
   - Si elle **n'en contient pas** : bug dans l'outil d'édition ou la couche d'API (sérialisation JSON de l'appel d'outil, normalisation côté serveur, `trim` / `split` / `join`).
2. Vérifier le mode d'édition directe (contentEditable) : les allers-retours `innerText` / `innerHTML` aplatissent souvent la structure.

### Correction durable
- Ne plus utiliser du Markdown libre comme format de référence. Passer à un **modèle de document structuré** (TipTap/ProseMirror ou JSON de blocs : paragraphe, titre d'article, liste, tableau). Si une migration complète est trop lourde, au minimum garantir que le pipeline Markdown ↔ rendu préserve les retours à la ligne et supporte les tableaux GFM.
- Les exports **Word (.docx)** et **PDF** doivent partir du même modèle, avec de vrais tableaux et de vraies listes.
- Exemple de bloc tableau :
  ```json
  {"type":"table","rows":[["L'Entreprise","Le Stagiaire"],["Lu et approuvé","Lu et approuvé"],["Signature :",""]]}
  ```
- Donner à l'assistant des **outils précis** plutôt qu'un seul « réécris tout le texte » :
  - `edit_article(id, texte)`
  - `insert_table(rows)`
  - `insert_list(items)`
  - `insert_signature_block(parties)` : **déterministe**, gabarit en code (lignes Signature, Nom, Prénom, Fonction, Date, pour chaque partie, avec la mention « Lu et approuvé »). Le LLM ne doit pas improviser ce tableau.
- Après chaque édition, valider la structure du document (tableaux bien formés, listes, numérotation des articles) et renvoyer l'erreur à l'assistant si elle est invalide.

### Critères d'acceptation
- Le bloc de signatures s'affiche en vrai tableau 2 colonnes, dans l'éditeur, le PDF et le Word.
- Les missions de l'article 4 s'affichent en liste à puces.
- Après une édition manuelle dans le document, la structure est conservée.

---

## P2. Chat : layout et suggestions

### Symptômes observés (captures d'écran)
- **Suggestions en double** : chaque réponse de l'assistant garde ses propres chips dans l'historique (« Ajouter une clause de pénalité de retard », « Ajouter le bloc de signatures »), et un second groupe fixe est affiché en bas (« Ajoute une clause de confidentialité », « Rends le ton plus simple », « Ajoute une pénalité de retard », « Ajoute les signatures »). Les deux sources se recoupent (la pénalité de retard apparaît deux fois).
- **Suggestions périmées** : « Ajoute les signatures » reste proposé alors que les signatures sont déjà ajoutées. Ce sont des chips statiques, non liées à l'état du document.
- **Chevauchement** : le groupe de chips du dessous coupe celui du dessus (« Ajouter le bloc de signatures » est tronqué), et le bloc « 3 étapes » de la dernière réponse passe sous les chips. Le conteneur de scroll ne réserve pas la hauteur des chips.
- **Mobile** : les 4 chips occupent environ un tiers de l'écran utile ; « Envoi… » flotte en haut à gauche sans en-tête ; il n'y a pas de bascule Chat / Document.
- **Barre d'outils du document** (capture desktop) : « Points d'attention (1) » passe sur deux lignes et est tronqué ; le titre « Contrat de sta… » est tronqué.
- **Affichage de la réflexion** (« 3 étapes · 14 s ») : les puces sont vides, le bloc est coupé, on voit le temps écoulé mais pas ce que fait l'assistant.

### À implémenter
**Layout** : colonne flex à trois zones, sans chevauchement possible.

```css
.chat { display:flex; flex-direction:column; height:100%; }
.messages { flex:1; min-height:0; overflow-y:auto; }
.suggestions { flex-shrink:0; display:flex; gap:8px; overflow-x:auto;
               flex-wrap:nowrap; padding:8px 12px; scrollbar-width:none; }
.suggestions button { white-space:nowrap; flex:0 0 auto; }
.composer { flex-shrink:0; }
```

**Suggestions**
1. **Une seule source**, placée au-dessus du champ de saisie. Supprimer les chips attachées aux messages de l'historique.
2. **Une seule ligne**, 3 chips maximum, défilement horizontal (≈ 40 px de hauteur sur mobile).
3. **Dynamiques** : à la fin de chaque tour, l'assistant appelle un outil `suggest_next_actions` qui renvoie 3 suggestions de 4 mots maximum, calculées selon l'état réel du document. Exemples : si les signatures existent, ne plus proposer « Ajoute les signatures » ; s'il reste des champs à compléter, « Compléter les champs » passe en premier.
4. **Masquées** pendant que l'assistant travaille ; **remplacées** (jamais empilées) à la fin de chaque réponse.
5. Option : bouton ✨ pour replier les suggestions.

**Réflexion de l'assistant**
- Pendant le travail : une seule ligne vivante décrivant l'action en cours (« Lecture du contrat… », « Modification de l'article 12… »).
- Une fois terminé : replié en « N étapes », détail visible uniquement au clic.
- Bloc placé au-dessus de la réponse, jamais masqué. **Auto-scroll jusqu'en bas** après chaque rendu.

**Barre d'outils et mobile**
- Boutons Word/PDF/« Points d'attention » sur une seule ligne, sans retour à la ligne (icône + compteur si l'espace manque) ; titre du document tronqué proprement avec `text-overflow: ellipsis` et infobulle.
- Mobile : en-tête fixe, bascule **Chat / Document**, état « Envoi… » intégré au composer.

### Critères d'acceptation
- Aucun élément du chat n'en recouvre un autre, à toutes les largeurs (desktop, tablette, mobile ≈ 390 px).
- Le dernier message et le bloc de réflexion sont toujours visibles après envoi.
- Jamais plus d'une rangée de suggestions ; elles reflètent l'état du document.

---

## P3. Fiabilité de l'assistant (prompt système et outils)

### a) Date et heure (point critique)
Constat : demande « 3 mois à compter du lundi prochain ». L'assistant a proposé le 14 juillet 2025, puis, « corrigé », le 21 juillet 2025. Il décale d'une semaine sans connaître la vraie date du jour. (À titre d'exemple de calcul correct : si on est le mardi 27 octobre 2026, lundi prochain = 2 novembre 2026, fin du stage de 3 mois = 2 février 2027, ou 1er février si on compte inclusivement. À afficher dans le contrat avec le jour de la semaine.)

À faire, en combinant :
- **Injecter à chaque requête** la date, l'heure et le fuseau (`Africa/Abidjan`) dans le prompt système (`{{now}}`).
- Ajouter un outil **`compute_date`** (ex. `compute_date(start="next_monday", add={"months":3}, inclusive=false)`) qui renvoie les dates formatées avec le jour de la semaine. **Interdire le calcul de dates de tête.**
- **Horodater** chaque message et chaque modification du document, et conserver un **historique de versions** avec annulation / restauration, pour tracer l'historique.

### b) Nombre de champs à compléter faux
Il annonce « 16 champs » après l'ajout de signatures contenant lieu et date, puis « 21 » après l'extension, sans aucun calcul réel.
- Créer l'outil **`list_placeholders()`** basé sur la regex `\[À COMPLÉTER[^\]]*\]` (renvoie nombre, libellés et emplacement par article).
- Afficher le **compteur dans l'interface** (badge), pas dans le texte généré par le modèle.
- Transformer « Compléter les champs restants » en **formulaire guidé** : un champ par placeholder, remplissage en une seule action qui met à jour le document.

### c) Réponses répétitives
Même sur « ok merci », l'assistant ressort tout le statut du contrat et le rappel du juriste. Le rappel « à faire valider par un juriste » doit devenir une **mention fixe de l'interface**, et non plus figurer dans chaque message. Réponses courtes : 1 à 3 phrases, ce qui a changé + au plus une question. Un simple remerciement reçoit une réponse d'une ligne.

### d) Promesses creuses
« Je vais faire attention à l'affichage de mes réflexions à l'avenir » : l'assistant ne contrôle ni l'interface ni son comportement futur. Règle : les retours sur l'interface ne sont pas des instructions, aucune promesse de changement futur ; il peut simplement remercier ou dire que le retour est transmis. (Les retours d'interface sont à traiter par l'équipe : voir P2.)

### e) Clauses engageantes ajoutées sans demande
Il a ajouté de lui-même l'**article 10 « Priorité d'embauche »** (six mois), un engagement réel pour l'entreprise. Règle : toute clause à conséquence juridique (embauche, pénalité, exclusivité, responsabilité civile, etc.) doit être **proposée et confirmée avant insertion**. Après toute modification, **lister ce qui a été ajouté ou changé** dans un récapitulatif court.

### f) Demandes vagues
« Rends le document plus long » a produit 65 s de remplissage générique. Règle : soit une seule question courte (« Plus de clauses, ou plus de détails sur les articles existants ? »), soit ajout de clauses réellement utiles, **listées**. Privilégier les **modifications par section** plutôt que la régénération complète du document, pour réduire la latence.

### g) Qualité de langue
On a relevé l'anglicisme « obligations specifics ». Exiger du **français juridique de Côte d'Ivoire, registre formel, aucun mot anglais**. Ajouter un contrôle de relecture avant livraison.

### h) Ton décontracté
L'utilisateur avait demandé un contrat « décontracté / nouchi » ; la demande a été abandonnée silencieusement. Règle : le contrat reste en registre juridique formel ; le ton décontracté s'applique au chat, ou à une « version simplifiée » séparée si l'utilisateur la demande explicitement. Si la demande est écartée, l'expliquer en une phrase.

### i) Qualification juridique
Dans la conversation, l'utilisateur voulait d'abord un contrat d'apprentissage, puis un contrat de stage (« stage de qualification »). L'assistant doit distinguer stage, stage de qualification et apprentissage, et signaler tout doute de qualification.

### j) Vérification après édition
Après chaque modification, l'assistant relit le document et confirme que la structure est correcte (tableaux, listes, numérotation des articles, absence de doublons).

### Squelette de prompt système à intégrer / adapter

```
Contexte : date et heure actuelles = {{now}} (Africa/Abidjan). Pays : Côte d'Ivoire.
Droit applicable : Code du travail (Loi n° 2015-532) ; distingue stage, stage de
qualification et apprentissage, et signale tout doute de qualification.

Règles :
1. Ne calcule jamais une date de tête : utilise compute_date.
2. Ne donne jamais un nombre de champs de mémoire : utilise list_placeholders.
3. N'insère pas de clause engageante (embauche, pénalité, exclusivité) sans
   confirmation ; liste toujours ce que tu as ajouté.
4. Demande vague -> une seule question courte, ou propose 2 options.
5. Réponse : 1 à 3 phrases, ce qui a changé + au plus une question.
   Pas de rappel du statut ni d'avertissement juridique (déjà dans l'interface).
6. Ne promets rien sur ton comportement futur ni sur l'interface.
7. Après chaque édition, relis le document et vérifie la structure.
8. Termine chaque tour par suggest_next_actions (3 items, 4 mots max,
   selon l'état réel du document).
9. Contrat en français juridique formel ; ton décontracté seulement dans le chat.
```

### Outils à créer ou ajuster
| Outil | Rôle |
|---|---|
| `compute_date` | Calcul de dates fiable, avec jour de la semaine |
| `list_placeholders` | Détection et comptage des `[À COMPLÉTER : ...]` |
| `edit_article(id, texte)` | Modification ciblée d'un article |
| `insert_table(rows)` / `insert_list(items)` | Blocs structurés |
| `insert_signature_block(parties)` | Gabarit déterministe des signatures |
| `suggest_next_actions` | 3 suggestions dynamiques, 4 mots max |

---

## P4. Confort

- Historique de versions avec annulation / restauration (voir P3-a).
- Compteur de champs restants visible dans l'interface (badge) et formulaire guidé (voir P3-b).
- Ligne de réflexion vivante (voir P2).

---

## Ce que j'attends de toi

1. Explore le code, puis annonce brièvement ce que tu as trouvé (stack, cause réelle du bug de retours à la ligne).
2. Corrige dans l'ordre P1 → P4. Ne passe pas à P2 tant que P1 n'est pas vérifié avec les exemples ci-dessus (article 12 et article 4).
3. Teste sur desktop et mobile (≈ 390 px de large).
4. Termine par un récapitulatif : ce qui est fait, ce qui reste, et toute décision d'architecture que tu as prise (ex. migration vers un modèle de document structuré).
