/**
 * Capture du contexte envoyé au fournisseur de modèle.
 *
 * Quand `LLM_DEBUG_DIR` est définie, chaque requête sortante vers
 * `/chat/completions` est écrite dans ce dossier : c'est le contexte exact
 * (prompt système, historique, document, outils) que reçoit le modèle.
 *
 * Ces fichiers contiennent des données de l'utilisateur : le dossier est
 * ignoré par git, et rien n'est jamais écrit dans les journaux.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

export function dumpOutgoingRequest(body: unknown, meta: { model?: string; kind?: string } = {}): void {
  const dir = process.env.LLM_DEBUG_DIR;
  if (!dir) return;

  try {
    mkdirSync(dir, { recursive: true });
    counter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${String(counter).padStart(3, '0')}-${meta.kind ?? 'chat'}-${meta.model ?? 'model'}-${stamp}.json`;
    writeFileSync(
      join(dir, name),
      JSON.stringify({ meta: { ...meta, at: new Date().toISOString() }, request: body }, null, 2),
      'utf8',
    );
  } catch {
    // La capture ne doit jamais faire échouer une requête.
  }
}
