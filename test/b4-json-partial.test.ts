import { describe, expect, it } from 'vitest';
import { extractPartialString, readPartialString, extractPartialBoolean } from '../src/agent/json-partial.js';

describe('extracteur de JSON partiel', () => {
  it('lit une chaîne complète', () => {
    expect(extractPartialString('{"title":"Contrat de bail"}', 'title')).toBe('Contrat de bail');
  });

  it('lit une chaîne inachevée', () => {
    expect(extractPartialString('{"title":"Contrat de bai', 'title')).toBe('Contrat de bai');
  });

  it('indique si la chaîne est complète', () => {
    expect(readPartialString('{"title":"Contrat"}', 'title')?.complete).toBe(true);
    expect(readPartialString('{"title":"Contrat', 'title')?.complete).toBe(false);
  });

  it('décode les échappements', () => {
    expect(extractPartialString('{"t":"ligne 1\\nligne 2"}', 't')).toBe('ligne 1\nligne 2');
    expect(extractPartialString('{"t":"guillemet \\" ici"}', 't')).toBe('guillemet " ici');
    expect(extractPartialString('{"t":"\\u00e9t\\u00e9"}', 't')).toBe('été');
  });

  it('renvoie undefined si la clé est absente', () => {
    expect(extractPartialString('{"title":"x"}', 'markdown')).toBeUndefined();
  });

  it('ignore une valeur non textuelle', () => {
    expect(extractPartialString('{"replace":true}', 'replace')).toBeUndefined();
  });

  it('lit un booléen', () => {
    expect(extractPartialBoolean('{"replace":true}', 'replace')).toBe(true);
    expect(extractPartialBoolean('{"replace":false}', 'replace')).toBe(false);
    expect(extractPartialBoolean('{"replace"', 'replace')).toBeUndefined();
  });

  it('gère une clé présente dans une autre valeur', () => {
    const json = '{"note":"voir \\"markdown\\" ci-dessous","markdown":"# Titre"}';
    expect(extractPartialString(json, 'markdown')).toBe('# Titre');
  });
});
