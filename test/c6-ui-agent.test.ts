import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX = resolve(process.cwd(), 'public', 'index.html');
const SOURCE = resolve(process.cwd(), 'public', 'app-api.js');
const INJECT = resolve(process.cwd(), 'scripts', 'inject-app-api.mjs');

const html = readFileSync(INDEX, 'utf8');
const source = readFileSync(SOURCE, 'utf8');

describe('C6 — interface agent v2', () => {
  it('traite tous les événements du protocole', () => {
    for (const event of [
      'ready', 'status', 'phase', 'plan', 'step', 'tool_start', 'tool_end',
      'thinking_start', 'thinking_delta', 'thinking_end', 'retry', 'warning',
      'text_delta', 'canvas_start', 'canvas_delta', 'canvas_set',
      'ask_user', 'sources', 'suggestions', 'error', 'done',
    ]) {
      expect(source).toContain(`case '${event}'`);
    }
  });

  it('affiche la ligne d’état et l’état de l’orbe', () => {
    expect(html).toContain('id="agentStatus"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-state="idle"');
    expect(source).toContain("orb.setAttribute('data-state'");
  });

  it('affiche le compteur de champs et les points d’attention', () => {
    expect(html).toContain('id="docMeta"');
    expect(html).toContain('id="issuesList"');
    expect(source).toContain('validation.placeholders');
    expect(source).toContain('Points d');
  });

  it('construit la carte de question pour les cinq kinds', () => {
    for (const kind of ['single', 'multi', 'confirm', 'text', 'form']) {
      expect(source).toContain(`question.kind === '${kind}'`);
    }
    // Les boutons imposés par la spécification.
    expect(source).toContain("'Valider'");
    expect(source).toContain("'Passer'");
    expect(source).toContain('allow_other');
    expect(source).toContain('QUESTION_MAX_FIELDS');
  });

  it('rend le Markdown des messages du chat sans HTML injecté', () => {
    expect(source).toContain('function renderChatMarkdown');
    expect(source).toContain('window.msg = function');
    expect(source).toContain("el(ordered ? 'ol' : 'ul', 'chat-list')");
    expect(source).toContain("el('strong')");
    // Les anciens messages aplatis sont reconnectés en puces.
    expect(source).toContain('chatMarkdownText');
    expect(source).toContain('.msg-text{white-space:pre-wrap');
  });

  it('échappe le contenu : aucun HTML injecté', () => {
    // `innerHTML` ne sert qu'à vider un conteneur : jamais à insérer du contenu.
    const assignments = [...source.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(assignments.length).toBeGreaterThan(0);
    for (const value of assignments) {
      expect(value).toBe("''");
    }
    expect(source).not.toContain('insertAdjacentHTML');
    // Tout le texte passe par textContent.
    expect(source).toContain('textContent =');
  });

  it('sait répondre à une question (texte + answers)', () => {
    expect(source).toContain('answerQuestion');
    expect(source).toContain('body.answers = pendingAnswers');
    expect(source).toContain('question_id');
  });

  it('gère le mode simulé avec ses scénarios', () => {
    expect(source).toContain('mockStream');
    expect(source).toContain('mockBanner');
    expect(source).toContain('MODE SIMULÉ');
    expect(source).toContain('exitMock');
    expect(source).toContain('Passer en mode réel');
    for (const scenario of ['question', 'formulaire', 'reflexion', 'retry', 'confirmer', 'préavis', 'erreur', 'limite', 'lent']) {
      expect(source).toContain(scenario);
    }
  });

  it('n’active le mode simulé que sur demande explicite', () => {
    expect(source).toContain("MOCK: new URLSearchParams(location.search).get('mock') === '1'");
    expect(source).not.toContain("new URLSearchParams(location.search).has('mock')");
  });

  it('l’injection est idempotente et le bloc est à jour', () => {
    const before = readFileSync(INDEX, 'utf8');
    execFileSync(process.execPath, [INJECT], { cwd: process.cwd() });
    expect(readFileSync(INDEX, 'utf8')).toBe(before);

    const start = html.indexOf('<!-- app-api:debut -->');
    const end = html.indexOf('<!-- app-api:fin -->');
    expect(html.slice(start, end)).toContain(source.trim().slice(0, 2000));
  });
});
