import { describe, expect, it } from 'vitest';
import { renderDocx, slugify, titleFromMarkdown, contentDisposition } from '../src/export/docx.js';
import { countOccurrences, openDocx } from '../evals/docx-utils.js';
import { SAMPLE_BAIL } from './fixtures.js';

describe('B5 — export Word', () => {
  it('produit une archive valide', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    expect(result.bytes).toBeGreaterThan(1000);
    const archive = await openDocx(result.buffer);
    expect(archive.entries).toContain('word/document.xml');
    expect(archive.entries).toContain('[Content_Types].xml');
  });

  it('contient 8 espaces réservés', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    const archive = await openDocx(result.buffer);
    expect(countOccurrences(archive.documentXml, 'À COMPLÉTER')).toBe(8);
  });

  it('contient le tableau de signatures', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    const archive = await openDocx(result.buffer);
    expect(archive.documentXml).toContain('<w:tbl>');
  });

  it('place le titre en tête', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    const archive = await openDocx(result.buffer);
    expect(archive.documentXml).toContain('Contrat de bail à usage d&apos;habitation');
    expect(archive.documentXml.indexOf('Article 1')).toBeGreaterThan(0);
  });

  it('surligne les espaces réservés', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    const archive = await openDocx(result.buffer);
    expect(archive.documentXml).toContain('w:shd');
    expect(archive.documentXml).not.toContain('highlightCs');
  });

  it('ajoute le pied de page quand il est fourni', async () => {
    const result = await renderDocx(SAMPLE_BAIL, { footer: 'Document généré avec assistance IA.' });
    const archive = await openDocx(result.buffer);
    expect(archive.footerXml).toContain('Document généré avec assistance IA.');
    expect(archive.footerXml).toContain('Page');
  });

  it('n’ajoute pas de pied de page par défaut', async () => {
    const result = await renderDocx(SAMPLE_BAIL);
    const archive = await openDocx(result.buffer);
    expect(archive.footerXml ?? '').not.toContain('assistance IA');
  });

  it('refuse un document vide', async () => {
    await expect(renderDocx('   ')).rejects.toThrow();
  });
});

describe('B5 — nom de fichier', () => {
  it('retire les accents et la ponctuation', () => {
    expect(slugify('Contrat de bail à usage d\'habitation')).toBe('contrat-de-bail-a-usage-d-habitation');
    expect(slugify('Résiliation — préavis')).toBe('resiliation-preavis');
  });

  it('retombe sur une valeur par défaut', () => {
    expect(slugify('')).toBe('contrat');
    expect(slugify(null)).toBe('contrat');
    expect(slugify('!!!')).toBe('contrat');
  });

  it('lit le titre du document', () => {
    expect(titleFromMarkdown(SAMPLE_BAIL)).toBe("Contrat de bail à usage d'habitation");
    expect(titleFromMarkdown('Pas de titre')).toBeNull();
  });

  it('construit un en-tête Content-Disposition', () => {
    const header = contentDisposition('contrat-de-bail.docx');
    expect(header).toContain('attachment;');
    expect(header).toContain('filename="contrat-de-bail.docx"');
  });
});
