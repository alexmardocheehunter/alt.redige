# LexCanvas — Note de conception : données personnelles et fournisseurs

**Statut : note de conception. Les décisions de conformité relèvent d'un
conseil juridique spécialisé, pas de cet audit technique.**

**Relecture juridique** : effectuée et attestée par Alex, propriétaire du
projet, le 23/10/2026, sur la base des documents officiels du référentiel
(`reference/TOUTES LES INFOS LEGALES.txt`). Cette attestation porte sur le
contenu des modèles de contrats ; elle ne remplace pas un avis de conformité
sur le traitement des données personnelles décrit ci-dessous.

Cette note décrit ce que l'application transmet à OpenRouter, ce qu'elle
conserve dans Firebase/Firestore, pourquoi, et les mécanismes techniques en
place. Elle ne constitue pas un avis sur la conformité réglementaire.

---

## 1. Ce qui est transmis au fournisseur de modèle

À chaque appel de `POST /api/chat`, le serveur envoie à OpenRouter :

| Élément | Volume | Origine |
|---|---|---|
| Le prompt système | ~4,3 Ko | `prompts/system.fr.md` + catalogue des modèles |
| Le squelette du modèle de contrat | ~3 Ko par type | `data/templates/*.json` |
| Les notes juridiques du modèle | ~1,5 Ko par type | `data/templates/*.json` (référentiel validé) |
| **L'historique de conversation** | jusqu'à `MAX_HISTORY_MESSAGES` (12 par défaut) | le client |
| **Le document courant** | jusqu'à 200 000 octets | le client |
| Le type de contrat | quelques octets | le client |

À chaque `edit_canvas` ou `create_canvas`, le document est **ré-émis** au
modèle (il figure dans le contexte). Sur une boucle à 6 étapes, le document
part donc jusqu'à 6 fois.

## 2. Les données en cause

Un contrat contient des **données à caractère personnel** : nom et prénom des
parties, adresses, numéros de pièce d'identité, montants, banques, lieux de
travail. Ce sont des données que l'utilisateur ne confie pas volontiers à un
tiers.

## 3. Mesures techniques en place pour l'appel au modèle

| Mesure | Où | Effet |
|---|---|---|
| Troncature de l'historique | `MAX_HISTORY_MESSAGES` (défaut 12) + `selectHistory()` dans `src/agent/loop.ts` | Le premier message de l'utilisateur et les derniers sont conservés ; le milieu est retiré. Réduit le volume retransmis. |
| Limite du document | 200 000 octets, `MAX_DOCUMENT_BYTES` | Borne le volume par requête. |
| Limite de corps | 1 Mo, `MAX_BODY_BYTES` | Borne la requête entière. |
| Plafond de jetons | `MAX_OUTPUT_TOKENS` (16 000) | Borne la génération. |
| Plafond d'étapes | `MAX_STEPS` (6) | Borne la boucle. |
| Aucun contenu dans les journaux | `src/logger.ts` (liste de clés interdites) | Les journaux ne contiennent ni message, ni contrat, ni réponse du fournisseur. |
| Part du modèle par type | `data/templates/*.json` | Seuls les modèles du catalogue sont transmis. |
| Aucun jeton dans les journaux | `src/middleware/auth.ts` | Les codes d'erreur Firebase sont journalisés, jamais le jeton ni l'`uid`. |

## 4. Authentification Google et données de compte

Depuis le 23/10/2026, le backend sait vérifier un **ID token Firebase** obtenu
après une connexion Google (`AUTH_MODE=firebase` ou `hybrid`). Le serveur :

- vérifie la signature et l'expiration avec le SDK Admin Firebase ;
- utilise l'`uid` Firebase comme identité (quota, historiques) ;
- **ne reçoit pas et ne stocke pas le mot de passe Google** ;
- ne journalise ni le jeton, ni l'adresse e-mail, ni le nom du compte ;
- ne stocke pas l'adresse e-mail dans Firestore.

Le fournisseur d'identité est Google/Firebase. Les données de connexion
(compte Google, adresse e-mail, journaux de connexion) sont traitées par Google
selon ses propres conditions ; une information utilisateur et, le cas échéant,
un accord de sous-traitance doivent être formalisés.

## 5. Historiques côté serveur (optionnels)

Ils ne sont actifs que si **`HISTORY_ENABLED=1`** et si l'utilisateur est
authentifié individuellement. Sans compte Google, aucun historique n'est écrit :
le document reste dans le navigateur (`localStorage`).

| Élément stocké | Détail |
|---|---|
| Clé | `uid` Firebase (identifiant pseudonyme) |
| Contenu | titre, type de contrat, Markdown du contrat, messages de la conversation, version |
| Horodatages | `created_at`, `updated_at`, `expires_at` |
| Emplacement | Firestore `users/{uid}/histories/{historyId}`, base `(default)` en `eur3` (multi-région européenne) |
| Accès | SDK Admin uniquement ; règles Firestore `allow read, write: if false` pour le navigateur |
| Conservation | 90 jours après la dernière écriture (`HISTORY_RETENTION_DAYS`) |
| Purge | Filtrage et suppression à la lecture ; `npm run purge-history` planifié (quotidien) ; TTL Firestore si l'offre Blaze est active ; suppression immédiate via `DELETE /api/history/:id` |
| Plafond | 100 documents par utilisateur (`HISTORY_MAX_PER_USER`) ; le plus ancien est supprimé à la création du 101e |
| Suppression du compte | suppression récursive de `users/{uid}` à prévoir lors de la suppression du compte Firebase |

Les routes d'historique sont décrites dans `API-CONTRACT.md` §3.6 à §3.9.
Elles refusent le code partagé : un historique est toujours rattaché à un
compte.

## 6. Points ouverts — décision humaine

1. **Base légale et information de l'utilisateur.** Le transfert vers un
   fournisseur situé hors de l'UEMOA/CEDEAO doit être justifié et porté à la
   connaissance de l'utilisateur. Le frontend n'est pas encore livré ; l'écran
   d'information et la politique de confidentialité restent à rédiger et à
   valider.
2. **Conservation chez le fournisseur.** Durée de conservation des requêtes,
   usage à des fins d'amélioration du modèle, sous-traitance en cascade :
   à vérifier avec OpenRouter, et à reporter dans l'information utilisateur.
3. **Minimisation.** Faut-il anonymiser les parties avant l'envoi (remplacer
   les noms par des jetons) ? C'est techniquement faisable côté serveur
   (réécriture du contexte) mais cela dégrade la qualité de la rédaction, et
   cela n'a pas été fait.
4. **Authentification par compte.** L'infrastructure est prête (`AUTH_MODE`,
   `FirebaseTokenVerifier`, `uid`). Tant que le frontend utilise seulement le
   code partagé, il n'existe ni quota par utilisateur, ni historique nominatif,
   ni révocation unitaire. Le passage du front à Google est la prochaine étape.
5. **Durée de conservation côté serveur.** Elle est fixée à 90 jours pour les
   historiques. Cette durée doit être justifiée, affichée à l'utilisateur, et
   alignée sur la politique de confidentialité. La suppression à la demande et
   la suppression du compte doivent être testées de bout en bout. La purge
   physique dépend soit de la politique TTL Firestore (offre Blaze), soit d'un
   script `npm run purge-history` planifié ; sur l'offre Spark actuelle, c'est
   ce script qui doit être planifié, car le TTL est refusé faute de facturation.
6. **Droits des personnes.** Accès, rectification, effacement, portabilité :
   les routes actuelles couvrent la consultation et l'effacement des
   historiques, pas l'export structuré ni la suppression du compte Firebase.
7. **Localisation et sous-traitants.** Firestore est en `eur3`, mais Google
   peut traiter certaines métadonnées hors de l'UE selon ses conditions. Une
   analyse des transferts et des garanties appropriées reste nécessaire.

## 7. Ce qui n'a pas été fait

- Aucun chiffrement supplémentaire avant envoi (le transport est en TLS).
- Aucune journalisation du contenu — c'est délibéré.
- Aucune analyse d'impact : hors périmètre d'un audit technique.
- Aucune procédure automatisée de suppression du compte Firebase ni d'export
  des données personnelles.
