# LexCanvas — Note de conception : données transmises au fournisseur de modèle

**Statut : note de conception. Les décisions de conformité relèvent d'un
conseil juridique spécialisé, pas de cet audit technique.**

Cette note décrit ce que l'application transmet à OpenRouter, pourquoi, et
les mécanismes techniques déjà en place. Elle ne constitue pas un avis sur la
conformité réglementaire.

---

## 1. Ce qui est transmis

À chaque appel de `POST /api/chat`, le serveur envoie au fournisseur :

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
parties, adresses, numéros de pièce d'identité, montants,banques, lieux de
travail. Ce sont des données que l'utilisateur ne confie pas volontiers à un
tiers.

## 3. Mesures techniques déjà en place

| Mesure | Où | Effet |
|---|---|---|
| Troncature de l'historique | `MAX_HISTORY_MESSAGES` (défaut 12) + `selectHistory()` dans `src/agent/loop.ts` | Le premier message de l'utilisateur et les derniers sont conservés ; le milieu est retiré. Réduit le volume retransmis. |
| Limite du document | 200 000 octets, `MAX_DOCUMENT_BYTES` | Borne le volume par requête. |
| Limite de corps | 1 Mo, `MAX_BODY_BYTES` | Borne la requête entière. |
| Plafond de jetons | `MAX_OUTPUT_TOKENS` (16 000) | Borne la génération. |
| Plafond d'étapes | `MAX_STEPS` (6) | Borne la boucle. |
| Aucun contenu dans les journaux | `src/logger.ts` (liste de clés interdites) | Les journaux ne contiennent ni message, ni contrat, ni réponse du fournisseur. |
| Part du modèle par type | `data/templates/*.json` | Seuls les modèles du catalogue sont transmis. |

## 4. Points ouverts — décision humaine

1. **Base légale et information de l'utilisateur.** Le transfert vers un
   fournisseur situé hors de l'UEMOA/CEDEAO doit être justifié et porté à la
   connaissance de l'utilisateur. Aucun écran d'information n'existe
   aujourd'hui (le frontend n'est pas livré).
2. **Conservation chez le fournisseur.** Durée de conservation des requêtes,
   usage à des fins d'amélioration du modèle, sous-traitance en cascade :
   à vérifier avec OpenRouter, et à|report dans l'information utilisateur.
3. **Minimisation.** Faut-il anonymiser les parties avant l'envoi (remplacer
   les noms par des jetons) ? C'est techniquement faisable côté serveur
   (réécriture du contexte) mais cela dégrade la qualité de la rédaction, et
   cela n'a pas été fait.
4. **Authentification par compte.** Tant qu'il n'y a pas d'identité
   individuelle (`ACCESS_CODE` est un secret partagé), il n'existe ni quota
   par utilisateur, ni journal nominatif, ni révocation unitaire. Le
   passage à un jeton d'identité (Firebase ou équivalent) est la voie
   retenue ; l'interface `AccessVerifier` de `src/middleware/auth.ts` existe
   pour ça.
5. **Durée de conservation côté serveur.** Le serveur ne conserve rien
   (stateless) : l'historique et le document restent dans le navigateur
   (`localStorage` selon la spécification frontend). C'est un point positif
   pour la confidentialité, mais cela déplace la responsabilité de la
   conservation vers le client — à formaliser.

## 5. Ce qui n'a pas été fait

- Aucun chiffrement supplémentaire avant envoi (le transport est en TLS).
- Aucune journalisation du contenu — c'est délibéré.
- Aucune analyse d'impact : hors périmètre d'un audit technique.
