# Compétences agentives Firebase (OpenCode)

Les compétences du dépôt officiel Firebase sont installées dans
`.opencode/skills/`. OpenCode les découvre automatiquement et les charge à la
demande (divulgation progressive) : seules leurs descriptions apparaissent
dans la liste des outils, le contenu complet n'est lu que lorsqu'une tâche le
justifie.

- Source : <https://github.com/firebase/agent-skills>
- Commit installé : `92eed24` (2026-10-20)
- Installation : 22/10/2026, copie locale (pas de lien symbolique)
- Documentation : <https://firebase.google.com/docs/ai-assistance/agent-skills>

## Compétences installées

| ID | Usage |
|---|---|
| `firebase-basics` | CLI Firebase, connexion, création/sélection de projet |
| `firebase-firestore` | Firestore : base, modèle, index, SDK |
| `firestore-rules-creation` | écriture et durcissement des règles Firestore |
| `firebase-security-rules-auditor` | audit des règles (fuites, contournements) |
| `firebase-auth-basics` | Firebase Authentication et accès protégés |
| `firebase-ai-logic-basics` | Firebase AI Logic / Gemini côté application |
| `firebase-hosting-basics` | Firebase Hosting classique |
| `firebase-app-hosting-basics` | App Hosting (Next.js, Angular, SSR) |
| `firebase-data-connect-basics` | SQL Connect / Data Connect |
| `firebase-remote-config-basics` | Remote Config et feature flags |
| `firebase-crashlytics` | Crashlytics (iOS/Android) |
| `xcode-project-setup` | dépendances Swift et projets Xcode |
| `extension-to-functions-codebase` | conversion d'extension Firebase en Functions |

> Les compétences Crashlytics, Xcode, App Hosting, Data Connect, Remote Config
> et AI Logic ne concernent pas le backend LexCanvas actuel ; elles sont
> installées pour être disponibles si le périmètre s'élargit, sans coût tant
> qu'elles ne sont pas chargées.

## Mettre à jour

Depuis la racine du dépôt :

```bash
npx skills add firebase/agent-skills --agent=opencode --skill "*" --copy -y
```

La commande réinstalle les compétences à jour dans `.opencode/skills/`.
Vérifier ensuite `git diff` avant de committer : les mises à jour sont des
fichiers tiers, jamais des secrets.

## Ajouter le serveur MCP Firebase (facultatif, recommandé)

Les compétences expliquent *comment* faire ; le serveur MCP Firebase permet à
l'agent d'*agir* sur le projet (Firestore, règles, déploiements). Il utilise la
connexion `firebase login` déjà en place. Voir
<https://firebase.google.com/docs/ai-assistance/mcp-server>.
