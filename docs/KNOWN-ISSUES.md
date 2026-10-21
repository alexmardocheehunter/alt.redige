# LexCanvas — Points connus

Liste honnête de ce qui ne marche pas encore, de ce qui est en attente, et des
choix techniques assumés. Mis à jour à chaque jalon.

---

## État de la phase A (backend)

Les jalons B1 à B7 sont terminés : tests au vert (120 tests), un commit par
jalon, l'API conforme à `docs/API-CONTRACT.md` v1.0.

Ce qui n'est **pas** fait, et pourquoi :

| Point | Statut |
|---|---|
| Campagne d'évaluation contre le vrai modèle | non exécutée : pas de `ANTHROPIC_API_KEY` sur cette machine (harnais validé hors ligne, 10/10) |
| Phase C — intégration du frontend | non commencée : le fichier `index.html` définitif n'a pas été livré par Alex. `public/index.html` est encore la page provisoire. `docs/INTEGRATION-REPORT.md` sera écrit à ce moment-là. |
| Relecture juridique du modèle | en attente d'Alex (voir ci-dessous) |
| Vérification visuelle de l'export Word dans Word/LibreOffice | non faite : ni Word ni LibreOffice ne sont installés sur cette machine. L'archive OOXML est vérifiée par test (structure, surlignage, numérotation, pied de page) |

---

## En attente de décision ou de contenu (Alex)

### Relecture juridique du modèle « bail-habitation » — EN ATTENTE
`data/templates/bail-habitation.json` est passé en `"status": "ready"` pour le
développement et l'affichage dans le frontend (un modèle `draft` n'est pas
affiché par le front, cf. `docs/API-CONTRACT.md` §3.2).

Ce modèle **n'a pas été relu par un juriste** :
- `legal_notes` est vide ;
- `validators` est vide ;
- `legal_review.status` vaut toujours `"pending"`.

Tant que la relecture n'est pas faite, aucun texte juridique n'est inventé par
le code ni par l'agent : le modèle ne cite que des éléments neutres et laisse
les informations variables en `[À COMPLÉTER : …]`.

**Action attendue d'Alex** : faire valider par un juriste les clauses, plafonds
et notes du modèle, puis fournir le contenu de `legal_notes` et `validators`.

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

**Reste à faire** : une campagne réelle avec une clé valide (`npm run eval`),
pour valider le comportement de `minimax/minimax-m3.1-flash:free` sur la
rédaction longue et sur les appels d'outils en flux. Tant que ce n'est pas fait,
le provider OpenRouter reste « vérifié statiquement, pas en production ».

### Le filtre de sécurité n'a pas été calibré sur le modèle réel
Le gardien `nvidia/nemotron-3.5-content-safety:free` est appelé avec une
instruction qui impose une réponse `SAFE` ou `UNSAFE`. Le verdict est lu de
façon prudente : seul un `UNSAFE` explicite en début de réponse bloque ; une
réponse illisible ou une erreur du gardien laisse passer (fail-open).

**À faire** : vérifier le comportement réel du modèle sur des cas d'école
(document de bail légitime, demande hors sujet) avant de considérer le filtre
comme fiable. Un faux positif bloquerait des demandes légitimes ; un faux
négatif laisserait passer un contenu undesirable. Le réglage s'ajuste avec
`SAFETY_CHECK=0` et le prompt `SAFETY_SYSTEM_PROMPT` (`src/safety.ts`).

---

## Évaluations (`npm run eval`)

### Les scénarios n'ont pas pu être exécutés contre le vrai modèle
Le harnais est complet : 10 scénarios (`evals/scenarios/*.json`), 5 familles
d'assertions automatiques (pas d'invention, édition ciblée, pas de contrat dans
le chat, sous-ensemble respecté, export valide). Le mode hors ligne
(`npm run eval -- --dry-run`) rejoue un modèle scripté : **10/10 au vert**, ce qui
valide le harnais lui-même (décodage SSE, exécution des outils, assertions).

La campagne réelle (`npm run eval`) **n'a pas été exécutée** : la machine de
développement n'a pas de clé `ANTHROPIC_API_KEY`. La campagne réelle est à
lancer avec une clé valide, puis ses éventuels échecs sont à consigner ici.

### Le contrôle « pas d'invention » est heuristique
`evals/assertions.ts` extrait les montants, durées, dates et noms propres du
contrat, puis vérifie qu'ils proviennent des messages de l'utilisateur, des
espaces réservés `[À COMPLÉTER …]` ou du vocabulaire du modèle (squelette et
notes juridiques). Le vocabulaire du modèle est accepté parce que le modèle est
*censé* le réutiliser.

Limites connues :
- un nombre cité dans le document mais présent « par hasard » dans le message de
  l'utilisateur passe le contrôle (faux négatif) ;
- un nom propre légitime du modèle (ville, patronyme) absent du squelette est
  signalé comme une invention (faux positif possible) ;
- la liste de mots courante (`CONTRACT_STOPLIST`) est faite main : elle peut
  être incomplète.

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
