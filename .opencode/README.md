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

Les compétences sont copiées dans `.opencode/skills/` (pas de lien symbolique).
Pour les actualiser depuis le dépôt officiel :

```powershell
$tmp = Join-Path $env:TEMP 'firebase-agent-skills'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
git clone --depth 1 https://github.com/firebase/agent-skills.git $tmp
Remove-Item -Recurse -Force .opencode\skills
New-Item -ItemType Directory -Force -Path .opencode\skills | Out-Null
Copy-Item -Path (Join-Path $tmp 'skills\*') -Destination .opencode\skills -Recurse
```

Vérifier ensuite `git diff` avant de committer, et mettre à jour le commit
source ci-dessus. La commande `npx skills add ...` installe dans
`.agents/skills/` sur cette version de l'outil ; on garde `.opencode/skills/`
pour rester explicite.

## Ajouter le serveur MCP Firebase (facultatif, recommandé)

Les compétences expliquent *comment* faire ; le serveur MCP Firebase permet à
l'agent d'*agir* sur le projet (Firestore, règles, déploiements). Il utilise la
connexion `firebase login` déjà en place. Voir
<https://firebase.google.com/docs/ai-assistance/mcp-server>.
