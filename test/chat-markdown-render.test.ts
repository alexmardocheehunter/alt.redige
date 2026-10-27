import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type FakeNode = {
  tagName: string;
  nodeType: number;
  children: FakeNode[];
  attributes: Record<string, string>;
  className: string;
  text: string;
  appendChild(node: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
  lastElementChild: FakeNode | null;
  innerHTML: string;
  textContent: string;
};

function makeNode(tagName: string, nodeType = 1, text = ''): FakeNode {
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType,
    children: [] as FakeNode[],
    attributes: {} as Record<string, string>,
    className: '',
    text,
    appendChild(child: FakeNode) { this.children.push(child); return child; },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    get childNodes() { return this.children; },
    get lastElementChild() { return this.children[this.children.length - 1] ?? null; },
    set innerHTML(_value: string) { this.children = []; this.text = ''; },
    get innerHTML() { return ''; },
    set textContent(value: string) { this.children = []; this.text = String(value); },
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); },
  };
  return node;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function serialize(node: FakeNode): string {
  if (node.nodeType === 3) return escapeHtml(node.text);
  const attributes = { ...(node.className ? { class: node.className } : {}), ...node.attributes };
  const attrs = Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('');
  const content = escapeHtml(node.text) + node.children.map(serialize).join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${content}</${node.tagName.toLowerCase()}>`;
}

function loadChatRenderer() {
  const source = readFileSync(new URL('../public/app-api.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function renderInline(node, text) {');
  const end = source.indexOf('  function escapeTableCell', start);
  if (start < 0 || end < 0) throw new Error('Renderer introuvable dans public/app-api.js');
  const document = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeNode('#text', 3, text),
  };
  const el = (tag: string, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  return runInNewContext(`(function () { ${source.slice(start, end)}; return { chatMarkdownText, renderChatMarkdown }; })()`, {
    document,
    el,
  }) as {
    chatMarkdownText(value: string): string;
    renderChatMarkdown(host: FakeNode, value: string): void;
  };
}

describe('rendu Markdown des réponses de chat', () => {
  it('préserve les retours à la ligne du modèle au composant et rend les listes en gras', () => {
    const renderer = loadChatRenderer();
    const modelOutput = 'Intro\n\n- **A** : x\n- **B** : y';
    const modelSseData = JSON.stringify({ choices: [{ delta: { content: modelOutput } }] });
    const decodedModelOutput = JSON.parse(modelSseData).choices[0].delta.content as string;
    const serverSseLine = `data: ${JSON.stringify({ seq: 1, t: 0, text: decodedModelOutput })}`;
    const componentReceived = JSON.parse(serverSseLine.slice(5).trim()).text as string;
    const host = makeNode('div');

    // This is a synthetic fixture trace, not application logging of user content.
    console.info('Markdown trace model:', JSON.stringify(decodedModelOutput));
    console.info('Markdown trace server:', JSON.stringify(serverSseLine));
    console.info('Markdown trace component:', JSON.stringify(componentReceived));

    renderer.renderChatMarkdown(host, componentReceived);
    const html = host.children.map(serialize).join('');
    expect(componentReceived).toBe(modelOutput);
    expect(html).toContain('<ul class="chat-list"><li><strong>A</strong> : x</li><li><strong>B</strong> : y</li></ul>');
    expect(html).not.toContain('**');
  });

  it('récupère le gras et les puces des anciens messages aplatis sur une ligne', () => {
    const renderer = loadChatRenderer();
    const flattened = 'Intro - **A** : x - **B** : y';
    expect(renderer.chatMarkdownText(flattened)).toBe('Intro\n\n- **A** : x\n- **B** : y');
    const host = makeNode('div');
    renderer.renderChatMarkdown(host, flattened);
    const html = host.children.map(serialize).join('');
    expect(html).toContain('<ul class="chat-list"><li><strong>A</strong> : x</li><li><strong>B</strong> : y</li></ul>');
    expect(html).not.toContain('**');
  });
});
