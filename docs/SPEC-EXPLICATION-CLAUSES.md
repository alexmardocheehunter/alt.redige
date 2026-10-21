# LexCanvas — Spécification de la relecture pédagogique des clauses

**Statut : spécifié, NON implémenté.**

Ce document répond au constat **P1-6** de la vérification d'audit : il n'existe
aujourd'hui aucun mécanisme d'explication de clause. Ni dans `src/`, ni dans
`prompts/`, ni dans `docs/SPEC-BACKEND.md`, ni dans `docs/SPEC-FRONTEND.md`.

La seule chose qui existe est une règle du prompt système qui demande un
résumé de chat de 300 caractères maximum après chaque appel d'outil
(`prompts/system.fr.md`). Ce n'est ni une explication de clause, ni un
mécanisme validé, ni lié à un texte particulier.

**L'implémentation est volontairement différée** : elle suppose un choix
d'interface (le frontend n'est pas livré) et une validation humaine sur le
contenu juridique des explications. Voici donc le contrat proposé, à faire
valider avant tout développement.

---

## 1. Objectif

Permettre à l'utilisateur de comprendre une clause du contrat qu'il a
obtenu, **sans que l'application ne se présente comme une source de droit**.

## 2. Principes non négociables

1. **Ancrage.** L'explication porte sur le texte **effectivement présent** dans
   le document. Elle est produite à partir d'un extrait, jamais à partir de
   ce que l'application croit qu'il y a.
2. **Pas d'effet juridique non présent.** L'explication ne peut pas affirmer
   qu'une clause « est valide », « est nulle », « est obligatoire » ou
   «_prime sur tel texte » si le texte de la clause ne le dit pas.
3. **Pas de citation inventée.** L'explication ne cite un texte de loi que si
   ce texte figure dans les `legal_notes` du modèle. Aucune exception.
4. **Incertitude explicite.** Quand l'interprétation dépend d'un élément
   absent du contrat (montant non renseigné, partie non identifiée), l'explication
   le dit et signale ce qui manque.
5. **Limites explicites.** Toute explication se termine par une mention
   indiquant qu'elle ne remplace pas l'avis d'un professionnel du droit.

## 3. Interface proposée

### 3.1 Outil

```json
{
  "name": "explain_clause",
  "description": "Explique une clause du contrat à l'utilisateur, à partir du texte présent dans le document.",
  "parameters": {
    "type": "object",
    "properties": {
      "article": { "type": "string", "description": "Intitulé ou numéro de l'article à expliquer." },
      "focus": { "type": "string", "description": "Question du lecteur (facultatif)." }
    },
    "required": ["article"]
  }
}
```

### 3.2 Résultat renvoyé au modèle

```json
{
  "ok": true,
  "article": "Article 4 – Résiliation",
  "quote": "extrait littéral du document",
  "explanation": "…",
  "obligations": [ { "party": "Bailleur", "duty": "…" } ],
  "risks": [ "…" ],
  "depends_on": [ "élément du contrat dont la valeur change la portée" ],
  "limits": "…"
}
```

### 3.3 Événement SSE

Un nouvel événement `clause_explained` :

```json
{
  "article": "Article 4 – Résiliation",
  "quote": "…",
  "explanation": "…",
  "obligations": [],
  "risks": [],
  "depends_on": [],
  "limits": "…",
  "document_version": 4
}
```

> **Modification de contrat proposée** : l'ajout d'un événement SSE est une
> modification de `docs/API-CONTRACT.md` §3.3. Elle doit être validée par
> Alex avant développement (cf. `docs/VERIFICATION-AUDIT.md`, section
> « Modifications de contrat proposées »).

## 4. Règles de versionnement

- L'explication porte le `document_version` du document qu'elle explique.
- **Toute modification** d'une clause (via `edit_canvas`) **invalide** l'explication
  correspondante : le client doit la marquer « à revoir » ou la redemander.
- Les explications portant une version antérieure ne sont plus affichées comme
  valides.
- La version d'un contrat est celle de `canvas_set` (règle du contrat §3.3).

## 5. Garde-fous côté serveur

| Garde-fou | Règle |
|---|---|
| Extrait littéral | L'explication doit contenir un extrait **présent** dans le document, caractère pour caractère. Sinon elle est rejetée. |
| Citations | Toute mention normative absente des `legal_notes` du modèle est rejetée (mécanisme `src/doc/references.ts`). |
| Articles absents | Si l'article demandé n'existe pas dans le document, l'outil renvoie une erreur — il n'invente pas de clause. |
| Anglicismes | L'explication passe par le garde-fou lexical (`src/doc/lexical.ts`). |

## 6. Avertissement structuré

L'audit a relevé que la phrase de prudence
« le document doit être relu et validé par un professionnel du droit » n'est
qu'une phrase libre dans une bulle de chat : elle n'est ni garantie, ni
structurée, ni liée au document.

**Proposition** : ajouter au `canvas_set` un champ structuré

```json
"legal_notice": {
  "required": true,
  "text": "Ce document doit être relu et validé par un professionnel du droit avant signature."
}
```

> **Modification de contrat proposée** : ajout d'une clé dans `canvas_set`
> (`docs/API-CONTRACT.md` §3.3). À valider par Alex.

## 7. Ce qui n'est pas fait, et pourquoi

- **Pas d'implémentation** : le frontend n'est pas livré, l'interface
  (`clause_explained`) ne peut pas être validée, et le contenu juridique des
  explications doit être relu par un juriste.
- **Pas de promesse de conformité** : l'application ne doit jamais indiquer
  qu'un contrat est conforme au droit ivoirien ou OHADA. Elle aide à
  rédiger ; elle ne certifie rien.
- **Pas de base de données** : les explications sont Derivatives du document
  et vivent côté client, comme le document.

## 8. Questions ouvertes pour la validation humaine

1. Le public visé a-t-il besoin d'une explication, ou un renvoi à un
   professionnel suffit-il ?
2. L'explication doit-elle être produite par le modèle de rédaction (coût) ou
   par un modèle dédié ?
3. Les explications doivent-elles être conservées (historique) ou recalculées
   à chaque affichage ?
4. Qui valide le contenu juridique des explications ?
