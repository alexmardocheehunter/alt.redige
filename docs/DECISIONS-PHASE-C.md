# LexCanvas — Décisions de la phase C

> **Archive V1.0.** Ces décisions décrivent le branchement du front historique.
> Le 23/10/2026, Alex a validé l'ajout de Google Authentication et des
> historiques Firestore (V1.1) : voir `docs/API-CONTRACT.md` §2 et §3.6–3.9,
> et `docs/FIREBASE.md`. Les sections ci-dessous sur l'authentification par
> code partagé ne sont plus la cible de production.

Réponses aux cinq questions laissées ouvertes par `SPEC-FRONTEND.md` §17
(*« Décisions à trancher avant branchement (pour le dev backend) »*), et choix
complémentaires posés par le branchement du frontend livré.

Chaque décision est **réversible** : rien n'est figé dans le code d'une façon
difficile à défaire.

---

## 1. Authentification : code d'accès, pas d'OAuth

**Décision** : `ACCESS_CODE` (en-tête `X-Access-Code`) reste le mécanisme
d'authentification de la V1. Pas d'OAuth, pas de comptes, pas de base de
données.

**Pourquoi** : le serveur est sans état (README §11 : pas de base de données en
V1) et le frontend livré ne connaît aucun compte utilisateur. Un OAuth
supposerait un annuaire d'identités, des jetons, une révocation unitaire — un
chantier qui n'est pas celui du produit.

**Ce qui est déjà prêt** : `src/middleware/auth.ts` expose une interface
`AccessVerifier` (vérification d'un code partagé aujourd'hui, jeton d'identité
d'un fournisseur demain). Le passage à l'identité individuelle ne demandera
qu'un nouvel adaptateur, sans toucher aux routes.

**Ce que ça implique pour le frontend** : le dialogue de saisie du code reste
nécessaire quand `ACCESS_CODE` est défini. À défaut, le front delivered
affiche un écran de connexion simulé : il ne correspond pas au backend, et
c'est à signaler (voir `docs/INTEGRATION-REPORT.md`).

---

## 2. Historique des conversations : local seulement

**Décision** : l'historique et les documents restent dans le navigateur
(`localStorage`). Aucun endpoint `/api/conversations`.

**Pourquoi** : le serveur est sans état par construction ; un historique serveur
suppose une base de données, donc hors périmètre V1 (README §11). Le frontend
v2 (SPEC-FRONTEND §5.1) prévoit déjà la persistance locale.

**Conséquence** : les quotas par identité ne sont pas garantis par
conversation — ils le sont par requête et par IP (ou par identité si un
fournisseur d'identité est branché plus tard).

---

## 3. Réflexion résumée (`thinking_*`) : désactivée par défaut

**Décision** : `THINKING_VISIBLE=0` par défaut. Le réglage existe et peut être
activé côté serveur.

**Pourquoi** : le protocole (AGENT-PROTOCOL §5) interdit la chaîne de pensée
brute et demande un **résumé** destiné à l'utilisateur. Les modèles de la
chaîne (Minimax, Nemotron) sont des modèles à raisonnement : ce qu'ils
produisent n'est pas un résumé, c'est leur raisonnement. L'exposer reviendrait
à afficher la chaîne de pensée, contre la règle du protocole.

**Ce qu'il faut pour l'activer** : un mécanisme de résumé explicite (un
sous-modèle dédié, ou une consigne de résumé vérifiable). Ce n'est pas
aujourd'hui ; le réglage reste en place pour ne pas figer la décision.

---

## 4. `canvas_patch` (modification par bloc) : pas en V2

**Décision** : pas de `canvas_patch`. La version complète du document reste la
source de vérité (`canvas_set`), comme le contrat l'impose.

**Pourquoi** : le contrat d'API décrit `canvas_set` comme le document complet ;
un patch par bloc est une **modification de contrat** (README §4.1, AGENTS.md :
le contrat ne change qu'avec l'accord d'Alex). La spécification d'explication
de clauses (`docs/SPEC-EXPLICATION-CLAUSES.md`) évoque un `canvas_patch` en
v2.1 : c'est un ajout, pas un remplacement.

**Ce qui existe déjà** : `canvas_start` accepte désormais un champ
optionnel `target` (`{block_index}` ou `{article}`) et `reason` (AGENT-PROTOCOL
§11) : le front peut déjà surligner la zone concernée sans patch.

---

## 5. Reprise d'un flux après coupure réseau : rejouer le tour

**Décision** : un tour interrompu est **rejoué** (nouvelle requête, même
`X-Request-Id` si le client le conserve). Pas de reprise à chaud.

**Pourquoi** : le serveur ne conserve rien ; reprendre un flux à mi-parcours
imposerait de mémoriser l'état de la génération côté serveur — c'est-à-dire un
état, ce que la V1 refuse (README §11, SPEC-BACKEND §1).

**Idempotence** : le serveur n'a pas d'effet de bord (pas de base, pas
d'écriture). Le contrat d'API le garantit déjà : la version du document
sortante vaut `document.version` reçu + nombre de `canvas_set` émis dans le flux
+ 1. Deux exécutions de la même requête avec le même document produisent donc
la même version. Le client n'a qu'à ignorer un `canvas_set` portant un
`request_id` déjà traité.

**Code `conflict`** : prévu par le protocole (§16) pour un document périmé. Le
serveur, étant sans état, ne peut pas détecter l'obsolescence d'une version :
c'est le client qui la connaît. Le code est donc documenté et réservé, pas
émis par le serveur en l'état.

---

## 6. Choix complémentaires posés au branchement

### 6.1 Le frontend livré est un prototype : il n'appelle pas l'API
`index (1).html` appelle `window.claude.use('sample')` et se replie sur une
fonction `demo()` locale : il ne contient **aucun** appel à `/api/chat`. La
spécification v2 demande explicitement (§17) de remplacer cet appel par
`fetch('/api/chat')` + SSE.

**Conséquence** : le backend est prêt et conforme au protocole, mais le
frontend livré ne l'exploite pas encore. C'est le principal écart d'intégration,
documenté dans `docs/INTEGRATION-REPORT.md`. La réécriture du front n'est pas
du ressort du backend (AGENTS.md : « Le front est un fichier unique
`public/index.html` que tu ne codes pas »).

### 6.2 CSP : nonce par réponse
Le frontend livré porte un script inline. Une CSP statique l'interdirait. Le
serveur émet donc un **nonce par réponse** et l'injecte dans les balises
`<script>` inline au moment du service (le fichier sur le disque n'est jamais
modifié). C'est la « modification du serveur » que la liste de contrôle
mentionne (`docs/INTEGRATION-CHECKLIST.md` §5).

### 6.3 Le serveur ne pose pas de cookie et ne conserve rien
Rien à nettoyer côté serveur : ni session, ni historique, ni document. Le
`localStorage` du navigateur reste le seul dépôt, comme le prévoit la
spécification frontend.

### 6.4 Les questions de l'agent sont une question par tour
Le protocole limite le flux à **un** `ask_user` par tour (AGENT-PROTOCOL §8) :
les informations manquantes sont regroupées dans une seule question de type
`form` (2 à 6 champs) plutôt que plusieurs questions successives. C'est
appliqué par le serveur, qui refuse une seconde question dans le même tour.

### 6.5 Les explications de clauses ne sont pas implémentées
`docs/SPEC-EXPLICATION-CLAUSES.md` est explicitement marqué « NON implémenté »
et propose deux modifications de contrat (`clause_explained`, `legal_notice`)
qui doivent être validées par Alex. Rien n'est implémenté tant que la
validation n'est pas donnée.
