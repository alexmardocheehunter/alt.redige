# alt.redige — Protocole agent (extension de `API-CONTRACT.md`)

Public : le dev backend. Ce document **ajoute** des événements SSE à `POST /api/chat`. Il ne change aucun événement existant (`ready`, `text_delta`, `status`, `canvas_start`, `canvas_delta`, `canvas_set`, `error`, `done`). Tout est **additif** : le front ignore les événements et champs inconnus, donc vous pouvez livrer par étapes. Ordre de priorité d'implémentation : §8 (questions) → §3-4 (phases, étapes) → §9 → §6 → §5.

## 1. Principes

1. Un tour = une requête = un flux qui se termine **toujours** par `done` ou `error`.
2. Le front n'invente aucun état : tout ce que l'utilisateur voit vient d'un événement.
3. **Jamais de chaîne de pensée brute.** Les libellés sont rédigés par vous, en français, au présent, ≤ 80 caractères, sans jargon technique : « Je vérifie le préavis légal ». `thinking_*` ne transporte qu'un **résumé** destiné à l'utilisateur.
4. Tous les textes affichables sont **prêts à l'emploi** (pas de clés de traduction).
5. Le front échappe tout. N'envoyez jamais de HTML.

## 2. Enveloppe commune

Chaque `data:` JSON contient `seq` (entier croissant par tour, à partir de 1) et `t` (ms depuis `ready`). Exemple :
```
event: phase
data: {"seq":2,"t":180,"phase":"researching","label":"Je consulte le modèle de bail"}
```

## 3. `phase` : où en est l'agent
`phase` ∈ `understanding | researching | planning | drafting | reviewing | finalizing`, plus `label`. Émettre à chaque changement (≥ 1 phase par tour dès qu'un traitement dépasse 1 s). Coexiste avec `status` (le front traite les deux de la même façon).

## 4. `plan` et `step` : progression visible
```
event: plan
data: {"seq":3,"steps":[{"id":"s1","label":"Identifier les parties"},{"id":"s2","label":"Choisir les clauses"},{"id":"s3","label":"Rédiger"},{"id":"s4","label":"Vérifier"}]}

event: step
data: {"seq":4,"id":"s1","state":"running"}
event: step
data: {"seq":5,"id":"s1","state":"done","detail":"Bailleur et locataire identifiés"}
```
`state` ∈ `running | done | failed | skipped`. 8 étapes maximum. `plan` peut être renvoyé pour remplacer la liste. `label` possible dans `step` pour renommer.

## 5. `thinking_*` : réflexion résumée (optionnel, désactivable)
```
event: thinking_start  data: {"seq":6,"id":"th1"}
event: thinking_delta  data: {"seq":7,"id":"th1","text":"Le bail est meublé, donc la durée minimale… "}
event: thinking_end    data: {"seq":9,"id":"th1","duration_ms":6400}
```
Texte en français destiné à l'utilisateur. À ne pas remplir avec le raisonnement interne du modèle. Contrôlable par un réglage serveur (`THINKING_VISIBLE`).

## 6. `tool_start` / `tool_end` : outils visibles
```
event: tool_start  data: {"seq":10,"id":"t1","name":"load_template","label":"Chargement du modèle de bail"}
event: tool_end    data: {"seq":11,"id":"t1","ok":true,"duration_ms":1180,"result_summary":"Modèle « Bail d'habitation » v4"}
```
`label` obligatoire ; ne jamais exposer les arguments bruts ni les identifiants internes. En échec : `ok:false` + `result_summary` lisible (le tour peut continuer).

## 7. `sources` : références juridiques
```
event: sources
data: {"seq":20,"items":[{"id":"src1","title":"Acte uniforme OHADA – Droit commercial général","ref":"art. 101","kind":"law","url":null}]}
```
`kind` ∈ `law | template | user`. Émettre avant `done`.

## 8. `ask_user` : l'agent pose une question (priorité 1)

Le serveur étant sans état, **la question termine le tour** : `ask_user`, puis `done` avec `stop_reason:"awaiting_input"`. La réponse arrive comme **nouveau** `POST /api/chat`.

Champs : `question_id` (unique), `kind` ∈ `single | multi | text | confirm | form`, `question`, `why` (facultatif), `blocking` (`true` par défaut ; `false` = l'utilisateur peut « Passer », vous laissez alors `[À COMPLÉTER : …]`), `allow_other` (bool), `default`, et selon le `kind` :
- `single` / `multi` : `options:[{id,label,hint?}]`
- `confirm` : `options:[{id:"yes",label:"Remplacer"},{id:"no",label:"Garder"}]`
- `text` : `placeholder`, `max_length`
- `form` : `fields:[{id,label,type,required,placeholder?,unit?,options?}]`, 2 à 6 champs, `type` ∈ `text | number | amount | date | select`

Exemple :
```
event: ask_user
data: {"seq":8,"question_id":"q_duree","kind":"single","question":"Quelle durée pour le bail ?","why":"Elle détermine le préavis et le renouvellement.","options":[{"id":"6","label":"6 mois"},{"id":"12","label":"12 mois"},{"id":"24","label":"24 mois"}],"allow_other":true,"blocking":true}

event: done
data: {"seq":9,"stop_reason":"awaiting_input","request_id":"…","duration_ms":2100}
```
**Règles** : au plus **un** `ask_user` par tour (regroupez via `form`) ; ne posez pas de question dont la réponse est déjà dans l'historique ou le document ; une question simple peut aussi rester du simple `text_delta`.

**Réponse du client** (corps de `/api/chat`, en plus des champs existants) :
```json
{ "messages": [ …, {"role":"user","content":"Durée : 12 mois"} ],
  "answers": [ {"question_id":"q_duree","values":{"choice":"12"},"skipped":false} ] }
```
Le `content` est **toujours** un texte lisible, équivalent des `answers` : votre historique LLM reste du texte simple. `values` : `single` → `{choice}`, `multi` → `{choices:[…]}`, `text` → `{text}`, `confirm` → `{choice:"yes"|"no"}`, `form` → `{<field_id>: valeur}`, « Autre… » → `{other:"…"}`. Si l'utilisateur répond en texte libre, `answers` est absent.

## 9. `suggestions`
`{"seq":30,"items":[{"label":"Ajouter une clause de pénalité","message":"Ajoute une clause de pénalité de retard"}]}` : 2 à 4 éléments, avant `done`. Le front renvoie `message` tel quel.

## 10. `retry`, `warning`
- `retry` `{attempt, max, label, delay_ms}` : le serveur relance le LLM sans fermer le flux.
- `warning` `{code, label}` : problème non bloquant (ex. `template_fallback`). Affiché discrètement, n'arrête rien.

## 11. `canvas_start` enrichi
Champs ajoutés (facultatifs) : `target` (`{"block_index":14}` ou `{"article":5}`) pour que le front fasse défiler et surligne la zone avant la modification ; `reason` (libellé, ex. « Je modifie l'article 5 »). `canvas_set` reste **toujours** la source de vérité du document.

## 12. `done` enrichi
`{seq, stop_reason, request_id, duration_ms, usage?}` avec `stop_reason` ∈ `end_turn | awaiting_input | cancelled | max_tokens`.

## 13. Annulation et idempotence
- Le client envoie `X-Request-Id: <uuid>`. Une même requête rejouée avec le même id ne doit pas dupliquer d'effets.
- Si le client coupe la connexion : arrêtez l'appel LLM en **≤ 2 s** et **n'émettez aucun** `canvas_set`.
- `canvas_set` n'est émis qu'une fois le document **complet et validé**. Pas de document partiel dans `canvas_set`.

## 14. Cadence et réseau
- `ready` ≤ 300 ms ; première `phase` ≤ 1 s ; jamais plus de **15 s** sans octet (ligne `: ping`).
- `canvas_delta` : morceaux de 20 à 80 caractères, vidage ≤ 100 ms.
- En-têtes : `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Désactiver toute compression/mise en tampon intermédiaire sur ce chemin.
- Fin de ligne `\n` ou `\r\n`, blocs séparés par une ligne vide.

## 15. Ordre garanti
`ready` → { `phase` | `plan` | `step` | `thinking_*` | `tool_*` | `warning` | `retry` } (mêlés) → { `text_delta` | `canvas_start` → `canvas_delta`* → `canvas_set` } → `sources`? → `suggestions`? → `done`.
`ask_user` est toujours immédiatement suivi de `done(awaiting_input)`. `error` clôt le flux (pas de `done` après).

## 16. Codes d'erreur ajoutés
`cancelled` (non retryable), `conflict` (version du document périmée, retryable après resynchronisation), `content_filtered` (non retryable). Les codes existants sont inchangés.

## 17. Flux d'exemple complet (création, avec question puis rédaction)
```
event: ready
data: {"seq":1,"t":0,"request_id":"r1"}

event: phase
data: {"seq":2,"t":150,"phase":"understanding","label":"Je lis votre demande"}

event: ask_user
data: {"seq":3,"t":900,"question_id":"q_duree","kind":"single","question":"Quelle durée pour le bail ?","options":[{"id":"12","label":"12 mois"},{"id":"24","label":"24 mois"}],"allow_other":true}

event: done
data: {"seq":4,"t":910,"stop_reason":"awaiting_input","request_id":"r1","duration_ms":910}
```
Tour suivant (avec `answers`) :
```
event: ready …
event: plan …  event: step …  event: tool_start … event: tool_end …
event: canvas_start  data: {"seq":9,"mode":"create","reason":"Je rédige le bail"}
event: canvas_delta  data: {"seq":10,"text":"# BAIL D'HABITATION\n\n"}  (×N)
event: canvas_set    data: {… markdown, version:1, placeholders, validation …}
event: text_delta    data: {"seq":40,"text":"Le bail est prêt. Il reste 3 champs à compléter."}
event: sources …  event: suggestions …
event: done          data: {"seq":43,"stop_reason":"end_turn", …}
```
Le front en mode `?mock=1` rejoue ces mêmes flux : le dev backend peut s'en servir comme jeu de tests de non-régression (les scénarios sont décrits en §8 et §15 de `SPEC-FRONTEND.md`).
