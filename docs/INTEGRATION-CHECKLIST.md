# LexCanvas — Liste de contrôle pour l'intégration du frontend

Ce document décrit ce que le serveur attend du frontend, et ce qu'il faut
vérifier avant de fusionner un `public/index.html`.

**État au 21/10/2026 :** le fichier `public/index.html` est une **maquette**
livrée par l'humain (35 Ko, « alt.redige »). Elle **n'appelle pas le
backend** : aucun `fetch`, aucun `/api/`, aucun événement SSE ; elle appelle
`window.claude.use(...)` (un fournisseur d'IA dans le navigateur) et produit
ses PDF/Word en local avec jsPDF et JSZip.

Elle est donc **inexploitable en l'état** : tout le backend (boucle
agentique, outils, modèles, validateurs, garde-fou de sécurité, export Word
serveur) est hors circuit. La liste ci-dessous est le contrat à respecter
pour la prochaine version du front.

---

## 0. Écarts constatés entre le front livré et le serveur

| # | Constat | Effet |
|---|---|---|
| 0.1 | Aucun appel à `/api/chat` | Le backend n'est jamais sollicité. |
| 0.2 | `window.claude.use('sample')` avec un prompt propre | Le contrat sort d'une autre IA, sans les garde-fous du serveur. |
| 0.3 | Repli `demo(text)` codé en dur | Un contrat factice peut être affiché comme s'il était produit. |
| 0.4 | Export Word et PDF faits en local (JSZip / jsPDF) | Le document affiché n'est pas celui que le serveur valide ; il n'est pas conforme au sous-ensemble Markdown. |
| 0.5 | `https://cdnjs.cloudflare.com/...` pour jszip et jspdf | **Bloqué par la CSP** (`script-src 'self' 'nonce-…'`) : `JSZip` et `jspdf` sont indéfinis, les boutons d'export lèvent une exception. Il faut héberger ces deux fichiers localement (`public/`) ou les retirer. |
| 0.6 | Authentification factice (nom + e-mail dans `localStorage`) | Aucune authentification réelle. Le serveur attend `X-Access-Code` (ou `Authorization: Bearer …`). |
| 0.7 | Aucun événement d'`AGENT-PROTOCOL.md` | `ask_user`, `phase`, `plan`, `step`, `sources`, `suggestions` ne sont ni produits ni consommés. |
| 0.8 | PDF généré par jsPDF au lieu de `window.print()` | Le contrat d'API §3.4 impose l'impression navigateur ; à défaut, la décision est à documenter. |

---

## 1. Routes à consommer

| Route | Méthode | Réponse | Remarque |
|---|---|---|---|
| `/` | GET | HTML | Le serveur sert `public/index.html` tel quel, sans modification. |
| `/api/health` | GET | `{"ok":true,"contract_version":"1.0","model":"…"}` | Jamais bloqué par `X-Access-Code`. |
| `/api/templates` | GET | `{"templates":[…]}` | Ne garder que les entrées `status: "ready"`. |
| `/api/chat` | POST | SSE | Voir §2. |
| `/api/export/docx` | POST | `.docx` | Voir §3. |
| `/api/export/pdf` | — | **404** | **Il n'existe pas.** L'export PDF passe par `window.print()`. |

## 2. `POST /api/chat` (SSE)

Requête :

```json
{
  "messages": [ { "role": "user", "content": "…" } ],
  "document": { "markdown": "# …", "version": 3 },
  "contract_type": "bail-habitation",
  "answers": [ { "question_id": "q_duree", "values": { "choice": "12" } } ]
}
```

- `messages` : 1 à 30 messages, alternance `user` / `assistant`, le dernier
  est `user`, chaque `content` ≤ 8 000 caractères.
- `document` : `null` ou le document courant (≤ 200 000 octets). C'est le
  client qui détient l'état de la conversation ; le serveur n'en garde pas de
  copie pour le chat. Les snapshots d'historiques (V1.1) sont optionnels et
  réservés aux comptes Google.
- `contract_type` : identifiant de `/api/templates`, ou `null`.
- `answers` : réponses structurées aux questions du tour précédent
  (`AGENT-PROTOCOL.md` §8). **Facultatif** : le texte de `messages` reste
  toujours porteur de l'information.

Si `ACCESS_CODE` est défini et que `AUTH_MODE` vaut `code` ou `hybrid`, l'en-tête
`X-Access-Code` est accepté sur les routes `/api/*` sauf `/api/health`. En mode
`firebase` (ou en `hybrid` avec Google), le front envoie
`Authorization: Bearer <idToken>`.

En-têtes de réponse à respecter :

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

Événements (ordre normatif, `docs/API-CONTRACT.md` §3.3) :

| Événement | Charge utile | Ce que le client doit faire |
|---|---|---|
| `ready` | `{"request_id":"…"}` | Premier événement, toujours. |
| `status` | `{"phase":"template\|drafting\|editing","label":"…"}` | Libellé court, en français. |
| `text_delta` | `{"text":"…"}` | **Ajouter** à la bulle de chat. |
| `canvas_start` | `{"mode":"create\|edit","title":"…","contract_type":"…"}` | Ouvrir la zone de brouillon. |
| `canvas_delta` | `{"text":"…"}` | **Ajouter** au brouillon. Non exportable. |
| `canvas_set` | voir ci-dessous | Remplacer et **enregistrer** le document. |
| `error` | `{"code":"…","message":"…","retryable":true\|false}` | Afficher `message` (français). |
| `done` | `{"stop_reason":"end_turn\|max_steps","usage":{…}}` | Dernier événement d'un flux réussi. |

`canvas_set` :

```json
{
  "mode": "create",
  "markdown": "# …",
  "version": 4,
  "title": "…",
  "contract_type": "bail-habitation",
  "edits_applied": 2,
  "validation": {
    "placeholders": 8,
    "issues": [ { "code": "…", "severity": "info|warning|error", "message": "…" } ]
  }
}
```

`version` suit la règle du contrat : `document.version` reçu + nombre de
`canvas_set` déjà émis dans ce flux + 1. Elle sert d'indicateur de version à
l'utilisateur ; elle n'est pas un identifiant de version unique.

### Codes d'issue Signaling par `validation.issues`

| Code | Origine | Signification |
|---|---|---|
| `missing_title` / `multiple_titles` | `src/doc/validate.ts` | Un seul titre `#` attendu en tête. |
| `forbidden_construct` | idem | Construction hors du sous-ensemble Markdown (image, lien, bloc de code, titre de niveau 4+). **Bloque l'export Word.** |
| `missing_article` | idem | Article obligatoire du modèle absent du document. |
| `required_field` | `src/doc/required-fields.ts` | Champ obligatoire laissé vide. |
| `anglicism` | `src/doc/lexical.ts` | Terme anglais dans l'acte. |
| `fact_unverified` | `src/doc/facts.ts` | Montant, durée, date ou nom propre présent dans le document mais absent de la demande. |
| `placeholder_format` | `src/doc/validate.ts` | Espace réservé non fermé. |
| `validator:<id>` | `src/doc/validate.ts` | Règle juridique du modèle violée. |

### Règles client obligatoires (contrat §3.3)

1. Mémoriser le document courant (`previousDoc`) **avant** de traiter un flux.
2. Pendant `canvas_delta`, afficher un **brouillon** : ni enregistré, ni exportable.
3. N'enregistrer et ne remplacer le document qu'à la réception de `canvas_set`.
4. Si le flux se termine par `error`, ou se coupe après un `canvas_start` sans
   `canvas_set` : **restaurer `previousDoc`** et afficher l'erreur. Jamais de
   demi-contrat.
5. Bloquer l'édition manuelle du Canvas pendant qu'un flux est actif.
6. `AbortController.abort()` pour annuler : le serveur interrompt l'appel au
   modèle.

## 2bis. Enveloppe et événements `AGENT-PROTOCOL.md`

Chaque `data:` porte un `seq` (entier croissant à partir de 1) et un `t`
(millisecondes depuis `ready`). Le serveur les ajoute : **le front n'a rien à
faire**.

| Événement | Quand | Ce que le front doit faire |
|---|---|---|
| `phase` | à chaque changement d'étape | Afficher `label` (≤ 80 caractères, français). |
| `plan` | en début de tour | Afficher la liste des étapes. |
| `step` | progression d'une étape | Marquer `running` / `done` / `failed` / `skipped`. |
| `ask_user` | l'agent pose une question | **Toujours suivi de `done` avec `stop_reason:"awaiting_input"`.** Afficher la question, les options ou les champs, puis attendre la réponse. |
| `tool_start` / `tool_end` | visibility des outils | `label` en français ; ne jamais afficher les arguments bruts. |
| `sources` | références juridiques | Afficher `title` et `ref`. |
| `suggestions` | 2 à 4 pistes | Boutons ; le front renvoie `message` tel quel. |
| `warning` | problème non bloquant | Afficher discrètement. |
| `retry` | relance interne | Afficher `label`. |

`done.stop_reason` ∈ `end_turn` | `awaiting_input` | `max_steps`
(le protocole nomme `max_tokens` là où le contrat v1.0 dit `max_steps` : la
valeur du contrat est conservée pour ne pas casser le front).

> Le garde-fou serveur des champs obligatoires (P0-3) produit un `ask_user`
> de type `form` : le front doit rendre les champs et renvoyer la réponse au
> tour suivant, dans `messages` (texte lisible) et, si possible, dans
> `answers`.

## 3. `POST /api/export/docx`

Requête : `{"markdown":"…","title":"…","footer":"…"}` (`footer` ≤ 200 caractères).

Réponse `200` : corps binaire,
`Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`Content-Disposition: attachment; filename="<slug>.docx"`.

**Le document est validé avant l'export.** Si le Markdown contient une
construction interdite (image, lien, bloc de code, titre de niveau 4+), la
réponse est `400` avec le code `bad_request` et un message listant les
constructions fautives. Le client doit alors corriger le document ou
proposer une version conforme, **jamais** livrer un `.docx` tronqué.

## 4. Export PDF

Il n'y a **pas** d'endpoint PDF. Le PDF est produit par le navigateur :

1. bouton « Exporter en PDF » → `window.print()` ;
2. feuille `@media print` : seule la zone du contrat est imprimée, sans
   chat ni barre d'outils ;
3. `@page { size: A4; margin: 2.5cm }`, fond blanc, surlignage des champs
   retiré ;
4. `h2 { break-after: avoid }`, `tr { break-inside: avoid }` ;
5. `<!-- pagebreak -->` → `break-after: page` ;
6. si le mode Markdown est actif, basculer en « Aperçu » avant d'imprimer.

## 5. Content-Security-Policy

Le serveur pose une CSP **avec un nonce par réponse** :

```
default-src 'self'; script-src 'self' 'nonce-<nonce>';
style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'self'; object-src 'none'; frame-ancestors 'none';
base-src 'self'; form-action 'self'
```

Le nonce est **injecté à la volée** dans les balises `<script>` sans
attribut `src` de la page servie. Le fichier `public/index.html` sur disque
n'est **jamais** modifié.

Conséquences pour le frontend :

- le script inline de la page est autorisé **grâce au nonce** : il ne faut pas
  retirer l'attribut `nonce` ;
- **aucun autre script inline** n'est exécuté : les scripts doivent être
  référencés par `<script src="…">` ;
- **`https://cdnjs.cloudflare.com` n'est pas autorisé** : les bibliothèques
  chargées depuis un CDN sont bloquées. Il faut les héberger localement dans
  `public/` (et les référencer par un chemin relatif), ou les retirer ;
- `connect-src 'self'` : le front ne peut appeler que son propre serveur.
  C'est ce qui empêche de contourner le backend pour appeler un fournisseur
  d'IA depuis le navigateur.

## 6. Points de contrôle avant fusion

- [ ] `index.html` unique, servi tel quel par `GET /` (le nonce CSP est ajouté
      par le serveur, pas dans le fichier).
- [ ] Le front appelle `POST /api/chat` — **pas** un fournisseur d'IA
      navigateur.
- [ ] Aucun script externe (CDN) : tout est servi depuis `public/`.
- [ ] Décodage SSE avec `TextDecoder({stream:true})`, gestion de `\r\n`.
- [ ] Les commentaires `: ping` sont ignorés.
- [ ] `previousDoc` restauré en cas d'erreur ou de coupure.
- [ ] Édition manuelle bloquée pendant un flux actif.
- [ ] Annulation : `AbortController.abort()`.
- [ ] `ask_user` : question affichée, réponse renvoyée au tour suivant.
- [ ] Export Word : `POST /api/export/docx`, et le `400` traité, pas ignoré.
- [ ] Impression PDF : feuille `@media print` conforme au §4.
- [ ] Message d'erreur affiché tel quel (français, sans détail technique).
- [ ] Compteur « N champs à compléter » alimenté par `validation.placeholders`.
- [ ] Liste des `validation.issues` affichée (avertissements et erreurs).
