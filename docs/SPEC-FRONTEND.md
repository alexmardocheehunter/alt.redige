# LexCanvas — Spécification frontend

Public : l'IA qui construit l'interface. Tu reçois ce document et `API-CONTRACT.md` (normatif, à lire en entier). Tu **ne vois pas** le backend : tu développes contre le contrat, avec un mode simulé (section 8). Un autre agent branchera ensuite ton fichier au vrai serveur : tout ce qui doit changer à ce moment-là doit se résumer à retirer le mode simulé.

## 1. Livrable

- **Un seul fichier** : `index.html`, HTML + CSS + JavaScript inline. Pas de build, pas de framework, pas de bibliothèque externe, aucune requête vers un autre domaine (polices système uniquement).
- JavaScript moderne (ES2020), sans `eval`. Aucun gestionnaire `onclick=` inline : `addEventListener`.
- Taille visée : moins de 150 Ko.
- Toutes les URL d'API sont **relatives** (`/api/...`).
- Tout ce qui s'affiche vient d'un texte échappé. Jamais d'`innerHTML` avec une chaîne non maîtrisée.
- `localStorage` toujours dans un `try/catch` (il peut être indisponible) ; en cas d'échec, l'application fonctionne sans persistance.

## 2. Produit

LexCanvas aide à rédiger des contrats (droit ivoirien et OHADA) par conversation : le chat à gauche, le contrat qui s'écrit à droite sur une page de type document, avec export Word et PDF. Langue de l'interface : français uniquement. Ton : sobre, professionnel, rassurant.

## 3. Mise en page

**Bureau (≥ 900 px)** : deux colonnes, chat 40 % / Canvas 60 %, séparateur fixe.
**Mobile (< 900 px)** : une colonne avec deux onglets en bas, « Conversation » et « Document ». Quand un contrat commence à s'écrire, un point de notification apparaît sur l'onglet « Document » sans changer d'onglet de force.

**Barre supérieure** : nom « LexCanvas », bouton « Nouveau contrat » (demande confirmation s'il existe un document), indicateur de connexion discret.

**Panneau chat**
- Fil de messages : bulles utilisateur et assistant ; l'assistant s'affiche avec un curseur clignotant pendant la réception. Zone en `aria-live="polite"`.
- État vide : message d'accueil de l'assistant (« Bonjour, quel type de contrat souhaitez-vous rédiger aujourd'hui ? ») et des **boutons de démarrage** issus de `GET /api/templates` (`status = "ready"`), avec une liste de secours codée en dur : « Bail d'habitation ». Cliquer un bouton envoie un message prérempli et fixe `contract_type`.
- Ligne d'état sous le fil quand un événement `status` arrive (texte du `label`).
- Saisie : zone de texte qui grandit (1 à 6 lignes). `Entrée` envoie, `Maj+Entrée` saute une ligne. Bouton « Envoyer » ; pendant un flux il devient « Arrêter » (annule la requête).
- Après une erreur : message d'erreur dans le fil avec bouton « Réessayer » (renvoie le même dernier message utilisateur).

**Panneau Canvas**
- Barre d'outils : titre du document (modifiable), indicateur de version (« v3 »), **Annuler / Rétablir** (historique des versions de la session), bascule **Aperçu / Markdown**, compteur **« N champs à compléter »** (cliquable : fait défiler jusqu'au prochain espace réservé), bouton **Copier**, bouton **Exporter en Word**, bouton **Exporter en PDF**.
- Corps : en mode Aperçu, une « feuille » blanche au format papier (largeur max 794 px, marges internes généreuses, police à empattement type Times New Roman, 11 pt équivalent, texte justifié) qui évoque le rendu Word. En mode Markdown, une zone de texte monospace éditable.
- État vide : texte d'attente « Votre contrat apparaîtra ici. » avec une silhouette de page.
- Sous la feuille : bandeau permanent « Document généré avec assistance IA. À faire valider par un professionnel du droit avant signature. »
- Liste repliable « Points d'attention » alimentée par `validation.issues` (`warning` et `error`).

## 4. Direction visuelle

Sobre et épurée : fond neutre clair, une seule couleur d'accent, beaucoup d'espace, icônes SVG inline simples (pas d'emojis, pas d'images). Thème clair par défaut, thème sombre automatique via `prefers-color-scheme` (variables CSS sur `:root`). Contraste AA minimum. Les espaces réservés `[À COMPLÉTER : …]` sont visuellement distincts (surlignage jaune doux en clair, ambre sombre en sombre). Cibles tactiles ≥ 44 px sur mobile. Adapté dès 360 px de large.

## 5. Comportement

### 5.1 État
Un objet unique :
```js
state = {
  messages: [{role, content}],        // texte seul, sert aussi à l'affichage
  doc: { markdown: '', version: 0, title: '', contractType: null } | null,
  history: [],                        // versions précédentes pour Annuler/Rétablir
  streaming: false,
  draft: null,                        // texte accumulé pendant canvas_delta
  previousDoc: null                   // sauvegarde pendant un flux
}
```
Persistance : à chaque changement stable, écrire `state` (sans `draft` ni `streaming`) dans `localStorage` sous la clé `lexcanvas:v1`. Au chargement, restaurer.

### 5.2 Envoi d'un message
1. Ajouter le message utilisateur ; `previousDoc = doc` ; `streaming = true` ; bloquer l'édition du Canvas.
2. `fetch('/api/chat', {method:'POST', headers, body, signal})` avec les **30 derniers** messages, `document` (ou `null`), `contract_type`. Ajouter `X-Access-Code` si un code est stocké.
3. Si la réponse n'est pas `200` : lire le JSON d'erreur (`error.code`), afficher le message de la table 5.5.
4. Sinon lire `response.body.getReader()` et décoder le flux SSE **à la main** (voir 5.3).

### 5.3 Décodage du flux SSE
Accumule le texte décodé (`TextDecoder` avec `{stream:true}`) dans un tampon ; découpe sur la séquence `\n\n` ; pour chaque bloc, lis `event:` et `data:` ; parse `data` en JSON ; ignore les lignes qui commencent par `:` (pings). Un bloc incomplet reste dans le tampon. Gère `\r\n`. La fonction de décodage doit être **la même** en mode simulé et en mode réel.

### 5.4 Traitement des événements
- `ready` : rien (garder `request_id` pour l'afficher dans les erreurs).
- `text_delta` : ajouter à la bulle de l'assistant en cours.
- `status` : afficher le `label` sous le fil ; l'effacer à la fin du flux.
- `canvas_start` : en `create`, vider `draft`, basculer l'affichage vers le brouillon, activer le défilement automatique, signaler sur l'onglet Document (mobile). En `edit`, ne rien afficher de plus qu'un indicateur « Modification en cours… ».
- `canvas_delta` : `draft += text` ; rendre le brouillon avec limitation de fréquence (`requestAnimationFrame`) ; garder le bas de la feuille visible. Le brouillon n'est pas exportable ni enregistré.
- `canvas_set` : **remplacer** le document par `markdown` ; empiler l'ancienne version dans `history` ; mettre à jour titre, version, type, compteur de champs à compléter, liste des points d'attention ; mettre en évidence les blocs qui ont changé (comparer les blocs séparés par une ligne vide entre l'ancienne et la nouvelle version, fond doux qui s'estompe en 2 s) ; enregistrer dans `localStorage`.
- `error` : restaurer `previousDoc` (si un `canvas_start` a eu lieu sans `canvas_set`), afficher l'erreur, proposer « Réessayer » si `retryable`.
- `done` : `streaming = false`, réactiver l'édition, effacer le statut.
- **Flux coupé sans `done` ni `error`** : traiter comme une erreur `timeout` retryable.

### 5.5 Messages d'erreur (affichés tels quels)
| Code | Texte |
|---|---|
| `bad_request` | « La demande n'a pas pu être traitée. Reformulez ou rechargez la page. » |
| `unauthorized` | « Code d'accès invalide. » (rouvrir la saisie du code) |
| `payload_too_large` | « Le document ou le message est trop long. » |
| `rate_limited` | « Trop de demandes. Réessayez dans quelques instants. » |
| `llm_unavailable` / `llm_error` | « Le service de rédaction est momentanément indisponible. Réessayez. » |
| `truncated` | « Le contrat est trop long pour être généré d'un seul coup. Réessayez ou demandez-le en plusieurs parties. » |
| `timeout` | « La génération a pris trop de temps. Réessayez. » |
| `internal` | « Une erreur est survenue. Réessayez. » |
| réseau (échec de `fetch`) | « Connexion impossible. Vérifiez votre réseau. » |

### 5.6 Édition manuelle
En mode Markdown, la zone de texte est éditable (sauf pendant un flux). La validation se fait à la perte de focus ou après 800 ms d'inactivité : `doc.markdown` est mis à jour, `version += 1`, une entrée est ajoutée à `history`. Le compteur de champs à compléter est recalculé **localement** avec `/\[À COMPLÉTER[^\]]*\]/g`.

### 5.7 Annuler / Rétablir
`history` contient les documents précédents ; Annuler restaure le précédent, Rétablir le suivant. Une nouvelle modification efface la pile de rétablissement. Ces actions sont locales (aucun appel serveur).

### 5.8 Rendu Markdown (à écrire soi-même, ~150 lignes)
Rendu du sous-ensemble de la section 5 du contrat, rien d'autre. **Échappe tout le HTML d'abord**, puis applique les règles. Sont rendus : titre `#` (centré, capitales), `##` (article, gras, `break-after: avoid`), `###`, paragraphes justifiés, `**gras**`, `*italique*`, listes numérotées (numérotation redémarrée à 1 pour chaque liste), listes à puces (un niveau d'imbrication), tableaux GFM, `---` (filet), `<!-- pagebreak -->` (saut de page visible en aperçu par un filet pointillé, réel à l'impression), et les espaces réservés dans un `<mark class="ph" data-ph>` cliquable. Tout le reste s'affiche en texte brut. Le rendu doit supporter un document partiel (brouillon en cours d'écriture : liste ou tableau non terminés).

### 5.9 Export Word
Bouton « Exporter en Word » : si des champs restent à compléter, demander confirmation (« N champs restent à compléter. Exporter quand même ? »). Puis `POST /api/export/docx` avec `{markdown, title}` ; pendant l'attente, bouton désactivé avec indicateur ; à la réponse, télécharger le blob (nom depuis `Content-Disposition`, repli : slug du titre + `.docx`). En cas d'erreur, afficher le texte de la table 5.5.

### 5.10 Export PDF
Bouton « Exporter en PDF » : même confirmation que le Word, puis `window.print()`. Fournir une feuille `@media print` : seule la feuille du contrat est imprimée, sans barre d'outils ni chat ni bandeau ; `@page { size: A4; margin: 2.5cm }` ; police à empattement ; fond blanc ; surlignage des champs retiré ; `h2 { break-after: avoid }` ; `tr { break-inside: avoid }` ; `<!-- pagebreak -->` devient `break-after: page`. Si le mode Markdown est actif au moment du clic, basculer en Aperçu avant d'imprimer.

### 5.11 Code d'accès
Si une réponse `401` survient, afficher un petit dialogue demandant le code, le stocker (`localStorage`, avec `try/catch`) et rejouer la requête une fois.

## 6. Accessibilité et robustesse

- Navigation clavier complète ; focus visible ; rôles et libellés ARIA sur boutons-icônes et onglets ; `Échap` annule un flux en cours.
- Respecter `prefers-reduced-motion` (pas d'animation de fond d'évidence).
- Ne jamais perdre le texte tapé par l'utilisateur en cas d'erreur (le remettre dans la zone de saisie).
- Aucune erreur non gérée dans la console pendant un parcours normal.

## 7. Configuration en tête de script

```js
const CONFIG = {
  API_BASE: '',                                       // relatif, ne pas changer
  MOCK: new URLSearchParams(location.search).has('mock'),
  STORAGE_KEY: 'lexcanvas:v1',
  MAX_MESSAGES: 30
};
```
Aucun autre réglage ne doit être codé en dur ailleurs.

## 8. Mode simulé (`?mock=1`) — obligatoire

Le mode simulé remplace uniquement la fonction qui obtient la `Response`. Il fabrique une `Response` dont le corps est un `ReadableStream` qui émet du **vrai texte SSE** par petits morceaux (50 à 150 ms, parfois coupés au milieu d'un événement) : le décodeur, les événements et le rendu réels sont donc exercés. Un bandeau « MODE SIMULÉ » reste visible.

Scénario simulé, dans l'ordre :
1. **Premier message de l'utilisateur** : `ready`, `text_delta` qui pose deux questions (durée du bail, nom du bailleur), `done`. Aucun canvas.
2. **Deuxième message** : `ready`, `status` « Chargement du modèle de bail… », `canvas_start` (create), une dizaine de `canvas_delta` reconstituant un bail court (utilise la structure de l'exemple : titre, parties avec 3 espaces réservés, 3 articles dont une liste numérotée, tableau de signatures), `canvas_set` (version 1, `placeholders` exact, une issue `warning` d'exemple), `text_delta` de confirmation, `done`.
3. **Message contenant « préavis »** : `canvas_start` (edit), `canvas_set` (edit, version suivante, une clause modifiée), `text_delta`, `done`.
4. **Message contenant « erreur »** : `ready`, `canvas_start` (create), quelques `canvas_delta`, puis `error` `{"code":"truncated",...}` — pour vérifier la restauration de `previousDoc`.
5. **Message contenant « limite »** : réponse HTTP `429` JSON avec `Retry-After`.
6. `GET /api/templates` simulé avec un modèle `ready`. `POST /api/export/docx` simulé : télécharge un petit fichier texte nommé `contrat-simule.docx`.

## 9. Critères d'acceptation

- [ ] `index.html` seul, ouvert avec `?mock=1`, déroule les 5 scénarios sans erreur console.
- [ ] Le décodeur SSE gère les événements coupés entre deux morceaux, les pings `: ping` et `\r\n`.
- [ ] Un flux coupé après `canvas_start` restaure le document précédent.
- [ ] Les espaces réservés sont surlignés, comptés, cliquables ; le compteur se met à jour après édition manuelle.
- [ ] Annuler / Rétablir fonctionnent sur modification IA et sur modification manuelle.
- [ ] L'impression (aperçu d'impression du navigateur) donne une page A4 propre : seule la feuille, pas de barres, titres non orphelins, signatures non coupées.
- [ ] Le rendu supporte un brouillon partiel sans exception.
- [ ] Aucun contenu injecté n'exécute de script (test : un message ou un document contenant `<img src=x onerror=alert(1)>` s'affiche en texte).
- [ ] Mobile 360 px : onglets fonctionnels, rien ne déborde horizontalement.
- [ ] Rechargement de la page : conversation et document restaurés ; `Nouveau contrat` remet à zéro.
- [ ] Retirer `?mock=1` suffit à viser le vrai backend (aucune autre modification).
