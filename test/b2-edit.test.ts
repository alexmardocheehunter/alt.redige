import { describe, expect, it } from 'vitest';
import { applyEdits, closestLine } from '../src/doc/edit.js';
import { SAMPLE_BAIL } from './fixtures.js';

describe('applyEdits — cas nominaux', () => {
  it('remplace une chaîne présente une seule fois', () => {
    const result = applyEdits(SAMPLE_BAIL, [
      { old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'trois (3) mois' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editsApplied).toBe(1);
    expect(result.markdown).toContain('préavis de trois (3) mois');
    expect(result.markdown).not.toContain('[À COMPLÉTER : durée du préavis]');
  });

  it('applique plusieurs edits dans l’ordre', () => {
    const result = applyEdits(SAMPLE_BAIL, [
      { old_str: '**70 000 FCFA**', new_str: '**80 000 FCFA**' },
      { old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'un (1) mois' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editsApplied).toBe(2);
    expect(result.markdown).toContain('**80 000 FCFA**');
    expect(result.markdown).toContain('préavis de un (1) mois');
  });

  it('supporte une insertion (old_str vide est refusé)', () => {
    const result = applyEdits(SAMPLE_BAIL, [
      { old_str: 'il a été convenu et arrêté ce qui suit :', new_str: 'il a été convenu et arrêté ce qui suit :\n\nPréambule ajouté.' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain('Préambule ajouté.');
  });

  it('ne modifie pas le document d’origine', () => {
    const before = SAMPLE_BAIL;
    applyEdits(before, [{ old_str: '**70 000 FCFA**', new_str: '**80 000 FCFA**' }]);
    expect(before).toContain('**70 000 FCFA**');
  });
});

describe('applyEdits — tout ou rien', () => {
  it('échoue quand le document est absent', () => {
    const result = applyEdits(null, [{ old_str: 'x', new_str: 'y' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_document');
  });

  it('échoue avec not_found et ne rien appliquer', () => {
    const result = applyEdits(SAMPLE_BAIL, [
      { old_str: '**70 000 FCFA**', new_str: '**80 000 FCFA**' },
      { old_str: 'texte qui n’existe pas', new_str: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
    expect(result.index).toBe(1);
    expect(result.message).toContain('introuvable');
  });

  it('échoue avec not_unique et indique le nombre d’occurrences', () => {
    const document = 'Le Bailleur.\n\nLe Bailleur.\n';
    const result = applyEdits(document, [{ old_str: 'Le Bailleur.', new_str: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_unique');
    expect(result.message).toContain('2 fois');
  });

  it('refuse un old_str vide', () => {
    const result = applyEdits(SAMPLE_BAIL, [{ old_str: '', new_str: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
  });

  it('refuse une liste d’edits vide', () => {
    const result = applyEdits(SAMPLE_BAIL, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid');
  });

  it('compare exactement : les guillemets typographiques doivent correspondre', () => {
    const document = 'ci-après désigné « le **Bailleur** »,';
    const wrong = applyEdits(document, [{ old_str: '« le Bailleur »', new_str: 'x' }]);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.code).toBe('not_found');

    const good = applyEdits(document, [{ old_str: '« le **Bailleur** »', new_str: '« le bailleur »' }]);
    expect(good.ok).toBe(true);
  });

  it('donne un indice de ligne proche sur not_found', () => {
    const result = applyEdits(SAMPLE_BAIL, [
      { old_str: 'Article 4 – Résiliaton', new_str: 'Article 4 – Résiliation' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toContain('Article 4');
  });
});

describe('closestLine', () => {
  it('trouve la ligne la plus proche', () => {
    expect(closestLine(SAMPLE_BAIL, 'duree du preavis')).toContain('préavis');
  });

  it('renvoie undefined quand rien ne ressemble', () => {
    expect(closestLine(SAMPLE_BAIL, 'zzz qqq xxx')).toBeUndefined();
  });
});
