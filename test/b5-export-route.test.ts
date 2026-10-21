import { describe, expect, it } from 'vitest';
import { testApp, readJson } from './helpers.js';
import { countOccurrences, openDocx } from '../evals/docx-utils.js';
import { SAMPLE_BAIL } from './fixtures.js';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function postExport(app: ReturnType<typeof testApp>, body: unknown) {
  return app.request('/api/export/docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('B5 — endpoint /api/export/docx', () => {
  it('renvoie un fichier Word valide', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: SAMPLE_BAIL, title: 'Contrat de bail' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(DOCX_TYPE);
    expect(res.headers.get('content-disposition')).toContain('filename="contrat-de-bail.docx"');

    const buffer = Buffer.from(await res.arrayBuffer());
    const archive = await openDocx(buffer);
    expect(countOccurrences(archive.documentXml, 'À COMPLÉTER')).toBe(8);
  });

  it('déduit le nom de fichier du titre du document', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: SAMPLE_BAIL });
    expect(res.headers.get('content-disposition')).toContain('contrat-de-bail-a-usage-d-habitation.docx');
  });

  it('retombe sur « contrat » quand il n’y a pas de titre', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: 'Un simple paragraphe.' });
    expect(res.headers.get('content-disposition')).toContain('filename="contrat.docx"');
  });

  it('ajoute le pied de page demandé', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: SAMPLE_BAIL, footer: 'À valider par un juriste.' });
    const buffer = Buffer.from(await res.arrayBuffer());
    const archive = await openDocx(buffer);
    expect(archive.footerXml).toContain('À valider par un juriste.');
  });

  it('utilise le pied de page par défaut du serveur', async () => {
    const app = testApp({ exportFooter: 'Pied de page du serveur.' });
    const res = await postExport(app, { markdown: SAMPLE_BAIL });
    const buffer = Buffer.from(await res.arrayBuffer());
    const archive = await openDocx(buffer);
    expect(archive.footerXml).toContain('Pied de page du serveur.');
  });

  it('refuse un document vide', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: '   ' });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad_request');
  });

  it('refuse un document absent', async () => {
    const app = testApp();
    const res = await postExport(app, { title: 'Sans document' });
    expect(res.status).toBe(400);
  });

  it('refuse un document trop long', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: 'x'.repeat(200_001) });
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('refuse un pied de page trop long', async () => {
    const app = testApp();
    const res = await postExport(app, { markdown: SAMPLE_BAIL, footer: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('refuse un corps JSON invalide', async () => {
    const app = testApp();
    const res = await app.request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'pas du json',
    });
    expect(res.status).toBe(400);
  });

  it('exige le code d’accès quand il est configuré', async () => {
    const app = testApp({ accessCode: 'secret' });
    const res = await postExport(app, { markdown: SAMPLE_BAIL });
    expect(res.status).toBe(401);
  });
});
