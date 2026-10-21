# LexCanvas — Liste de contrôle pour l'intégration du frontend

Ce document décrit ce que le serveur attend du frontend, et ce qu'il faut
vérifier avant de fusionner un `public/index.html`.

**Le backend ne fournit pas d'interface** : `public/index.html` est
actuellement une page provisoire. Tant que ce fichier n'est pas remplacé,
le service n'est utilisable que par appel direct à l'API.

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
  "contract_type": "bail-habitation"
}
```

- `messages` : 1 à 30 messages, alternance `user` / `assistant`, le dernier
  est `user`, chaque `content` ≤ 8 000 caractères.
- `document` : `null` ou le document courant (≤ 200 000 octets). C'est le
  client qui détient l'état : le serveur est sans état.
- `contract_type` : identifiant de `/api/templates`, ou `null`.

Si `ACCESS_CODE` est défini, l'en-tête `X-Access-Code` est obligatoire sur
toutes les routes `/api/*` sauf `/api/health`.

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

Le serveur pose maintenant une CSP :

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none';
frame-ancestors 'none'; base-src 'self'; form-action 'self'
```

Conséquences pour le frontend :

- **aucun script inline** n'est exécuté : le fichier `index.html` doit
  référencer ses scripts par `<script src="…">` ;
- les styles inline sont autorisés (`style-src 'unsafe-inline'`) ;
- si un script inline est indispensable, il faut un **nonce** par réponse —
  ce qui suppose une modification du serveur, à demander.

## 6. Points de contrôle avant fusion

- [ ] `index.html` unique, servi tel quel par `GET /`.
- [ ] Aucune requête en JavaScript inline (CSP).
- [ ] Décodage SSE avec `TextDecoder({stream:true})`, gestion de `\r\n`.
- [ ] Les commentaires `: ping` sont ignorés.
- [ ] `previousDoc` restauré en cas d'erreur ou de coupure.
- [ ] Édition manuelle bloquée pendant un flux actif.
- [ ] Annulation : `AbortController.abort()`.
- [ ] Export Word : le `400` est traité, pas ignoré.
- [ ] Impression PDF : feuille `@media print` conforme au §4.
- [ ] Message d'erreur affiché tel quel (français, sans détail technique).
- [ ] Compteur « N champs à compléter » alimenté par `validation.placeholders`.
- [ ] Liste des `validation.issues` affichée (avertissements et erreurs).
