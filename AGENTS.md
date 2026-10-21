# AGENTS.md — LexCanvas

Lis `README.md` avant toute action, puis `docs/API-CONTRACT.md`. Ces deux fichiers font foi.

## Règles permanentes
- Le contrat d'API (`docs/API-CONTRACT.md`) est normatif. Tu ne le changes qu'avec l'accord d'Alex, et tu le mets à jour avant le code.
- Stack figée : Node ≥ 20, TypeScript strict, ESM, Hono, fournisseur de modèle **OpenRouter** en `fetch` natif (aucun SDK), serveur sans état. Voir `docs/SPEC-BACKEND.md` §1.
- Le front est un fichier unique `public/index.html` que tu ne codes pas ; tu le branches (README §9).
- `reference/` contient des originaux : copie, n'édite pas. N'écris pas à nouveau `export-docx.mjs`, étends-le.
- Jamais de contenu de contrat ni de message utilisateur dans les logs.
- Jamais de règle juridique inventée : `legal_notes` et `validators` ne contiennent que le référentiel validé fourni par l'humain (`reference/TOUTES LES INFOS LEGALES.txt`). Le code compare, il n'écrit pas de droit.
- Textes visibles par l'utilisateur et messages d'erreur : en français. Code, identifiants et commentaires techniques : en anglais.
- Travaille par jalons (README §6). À la fin de chacun : tests au vert, commit, résumé de cinq lignes.
- Décide seul pour le technique réversible. Ne demande à Alex que ce que liste README §10.
- Hors périmètre V1 : README §11. Ne le construis pas.
