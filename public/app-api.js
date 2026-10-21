/*
 * Branchement de l'IA : le prototype livré appelait `window.claude.use('sample')`,
 * qui n'existe pas hors de l'environnement de démonstration. Ce fichier reprend
 * les mêmes points d'accroche et appelle le backend :
 *
 *   - `send()`      → POST /api/chat (SSE)
 *   - export Word   → POST /api/export/docx
 *   - export PDF    → window.print()
 *   - boutons d'accueil → GET /api/templates
 *
 * Le reste de l'interface (mise en page, accessibilité, historique) n'est pas
 * touché. La source de vérité du document est le Markdown du backend ; les
 * blocs affichés sont une vue.
 *
 * Ce fichier est intégré dans `public/index.html` par `scripts/inject-app-api.mjs`.
 */
(function () {
  'use strict';

  var MOCK = new URLSearchParams(location.search).has('mock');
  var CODE_KEY = 'altredige.accesscode';
  var accessCode = (function () { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } })();
  var pendingType = null;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- */
  /* Markdown <-> blocs (vue affichée)                                 */
  /* ---------------------------------------------------------------- */

  function markdownToDoc(markdown) {
    var title = 'Contrat';
    var blocks = [];
    var parts = String(markdown || '').split(/\r?\n\s*\r?\n/);

    for (var i = 0; i < parts.length; i++) {
      var lines = parts[i].split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (!lines.length) continue;
      var first = lines[0].trim();

      if (/^#\s+/.test(first)) { title = first.replace(/^#\s+/, '').trim(); continue; }
      if (/^##+\s+/.test(first)) { blocks.push({ t: 'h', x: first.replace(/^##+\s+/, '').trim() }); continue; }
      if (/^\|/.test(first)) { blocks.push({ t: 'p', x: lines.join('\n') }); continue; }
      blocks.push({ t: 'p', x: lines.map(function (l) { return l.trim(); }).join(' ') });
    }

    return { title: title, blocks: blocks };
  }

  function docToMarkdown(doc) {
    if (!doc) return '';
    var out = ['# ' + (doc.title || 'Contrat')];
    (doc.blocks || []).forEach(function (b) {
      if (!b || !b.x) return;
      if (b.t === 'h') out.push('## ' + b.x);
      else out.push(b.x);
    });
    return out.join('\n\n');
  }

  /* ---------------------------------------------------------------- */
  /* Accès                                                              */
  /* ---------------------------------------------------------------- */

  function headers(extra) {
    var head = { 'Content-Type': 'application/json' };
    if (accessCode) head['X-Access-Code'] = accessCode;
    if (extra) Object.keys(extra).forEach(function (k) { head[k] = extra[k]; });
    return head;
  }

  function askAccessCode() {
    var code = window.prompt('Code d’accès requis :');
    if (code === null) return false;
    accessCode = code.trim();
    try { localStorage.setItem(CODE_KEY, accessCode); } catch (e) { /* stockage indisponible */ }
    return true;
  }

  function requestId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* pas de randomUUID */ }
    return 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------------------------------------------------------- */
  /* Historique conforme au contrat                                     */
  /* ---------------------------------------------------------------- */

  function history(c) {
    var out = [];
    (c.msgs || []).forEach(function (m) {
      var role = m.c === 'you' ? 'user' : 'assistant';
      var last = out[out.length - 1];
      if (last && last.role === role) { last.content += '\n' + m.x; return; }
      out.push({ role: role, content: m.x });
    });
    while (out.length && out[out.length - 1].role !== 'user') out.pop();
    return out.slice(-30);
  }

  /* ---------------------------------------------------------------- */
  /* Flux SSE                                                           */
  /* ---------------------------------------------------------------- */

  function readSse(response, onEvent) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function handle(raw) {
      var event = 'message';
      var data = '';
      raw.split(/\r?\n/).forEach(function (line) {
        if (line.indexOf('data:') === 0) data += line.slice(5).replace(/^ /, '');
        else if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      });
      if (!data || data === '[DONE]') return;
      var payload;
      try { payload = JSON.parse(data); } catch (e) { return; }
      onEvent(event, payload);
    }

    return (function pump() {
      return reader.read().then(function (result) {
        if (result.done) { if (buffer.trim()) handle(buffer); return; }
        buffer += decoder.decode(result.value, { stream: true });
        var index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          var chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handle(chunk);
        }
        return pump();
      });
    })();
  }

  /* ---------------------------------------------------------------- */
  /* Envoi                                                             */
  /* ---------------------------------------------------------------- */

  function errorText(code) {
    var messages = {
      bad_request: 'La demande n’a pas pu être traitée. Reformulez ou rechargez la page.',
      unauthorized: 'Code d’accès invalide.',
      payload_too_large: 'Le document ou le message est trop long.',
      rate_limited: 'Trop de demandes. Réessayez dans quelques instants.',
      llm_unavailable: 'Le service de rédaction est momentanément indisponible. Réessayez.',
      llm_error: 'Le service de rédaction est momentanément indisponible. Réessayez.',
      truncated: 'Le contrat est trop long pour être généré d’un seul coup. Réessayez.',
      timeout: 'La génération a pris trop de temps. Réessayez.',
      internal: 'Une erreur est survenue. Réessayez.'
    };
    return messages[code] || 'Une erreur est survenue. Réessayez.';
  }

  async function send(text) {
    if (!text || busy) return;
    readDoc();
    if (!curConv()) { var nc = { id: Date.now(), title: text.slice(0, 40), doc: null, msgs: [] }; convs.unshift(nc); cur = nc.id; }
    var c = curConv();
    view('app'); renderHist();
    ['hin', 'cin'].forEach(function (i) { $(i).value = ''; $(i).style.height = 'auto'; });
    msg('you', text, true);
    var w = msg('ai wait', 'Je rédige');
    w.insertAdjacentHTML('beforeend', '<span class="dots" aria-hidden="true"> <i></i><i></i><i></i></span>');
    busy = true; $('csend').disabled = true; $('orb2').classList.add('busy');
    if (!doc) skel();

    var reply = '';
    var question = null;
    var finished = false;

    function finish(label) {
      if (finished) return;
      finished = true;
      busy = false; $('orb2').classList.remove('busy');
      $('csend').disabled = !$('cin').value.trim();
      if (label) { w.className = 'm ai'; w.textContent = label; }
    }

    if (MOCK) {
      var out = demo(text);
      c.doc = { title: out.title, blocks: out.blocks };
      c.title = out.title; c.msgs.push({ c: 'ai', x: out.reply }); persist(); renderHist();
      if (cur === c.id) { doc = c.doc; render(true); w.className = 'm ai'; w.textContent = out.reply; }
      finish();
      return;
    }

    var body = {
      messages: history(c),
      document: doc ? { markdown: docToMarkdown(doc), version: doc.version || 1 } : null,
      contract_type: pendingType || (doc && doc.contractType) || null
    };

    var response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: headers({ 'X-Request-Id': requestId() }),
        body: JSON.stringify(body)
      });
    } catch (e) {
      finish('Connexion impossible. Vérifiez votre réseau.');
      return;
    }

    if (response.status === 401 && askAccessCode()) {
      try {
        response = await fetch('/api/chat', {
          method: 'POST',
          headers: headers({ 'X-Request-Id': requestId() }),
          body: JSON.stringify(body)
        });
      } catch (e) {
        finish('Connexion impossible. Vérifiez votre réseau.');
        return;
      }
    }

    if (!response.ok) {
      var payload = null;
      try { payload = await response.json(); } catch (e) { /* corps illisible */ }
      var code = payload && payload.error ? payload.error.code : 'internal';
      finish(payload && payload.error ? payload.error.message : errorText(code));
      return;
    }

    try {
      await readSse(response, function (event, data) {
        if (event === 'text_delta') {
          reply += data.text || '';
          w.textContent = reply;
        } else if (event === 'status' || event === 'phase' || event === 'tool_start') {
          if (!reply) w.textContent = data.label || w.textContent;
        } else if (event === 'canvas_delta') {
          var paper = $('paper');
          if (paper) {
            if (!paper.querySelector('h1')) {
              var h = document.createElement('h1');
              h.textContent = 'Rédaction en cours…';
              paper.innerHTML = '';
              paper.appendChild(h);
            }
            var last = paper.lastElementChild;
            if (last && last.tagName === 'P') last.textContent += data.text || '';
            else { var p = document.createElement('p'); p.textContent = data.text || ''; paper.appendChild(p); }
          }
        } else if (event === 'canvas_set') {
          var parsed = markdownToDoc(data.markdown);
          parsed.version = data.version;
          parsed.contractType = data.contract_type || null;
          c.doc = parsed;
          c.title = parsed.title;
          if (cur === c.id) { doc = parsed; render(true); }
          persist(); renderHist();
        } else if (event === 'ask_user') {
          question = data;
          reply = data.question + (data.why ? ' (' + data.why + ')' : '');
          w.textContent = reply;
        } else if (event === 'error') {
          finish(data.message || errorText(data.code));
        }
      });
    } catch (e) {
      finish('Connexion interrompue. Réessayez.');
      return;
    }

    if (question) {
      c.msgs.push({ c: 'ai', x: reply + '\nRépondez dans le champ ci-dessous pour continuer.' });
    } else {
      c.msgs.push({ c: 'ai', x: reply || 'Le contrat est prêt.' });
    }
    persist(); renderHist();
    finish(reply || 'Le contrat est prêt.');
    pendingType = null;
  }

  /* ---------------------------------------------------------------- */
  /* Exports                                                            */
  /* ---------------------------------------------------------------- */

  function download(filename, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('Téléchargé : ' + filename);
  }

  async function exportWord() {
    if (!doc) return;
    var markdown = docToMarkdown(doc);
    try {
      var res = await fetch('/api/export/docx', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ markdown: markdown, title: doc.title || 'Contrat' })
      });
      if (!res.ok) {
        var payload = null;
        try { payload = await res.json(); } catch (e) { /* corps illisible */ }
        toast(payload && payload.error ? payload.error.message : 'L’export Word a échoué.');
        return;
      }
      var disposition = res.headers.get('Content-Disposition') || '';
      var match = /filename="([^"]+)"/.exec(disposition);
      var name = match ? match[1] : 'contrat.docx';
      download(name, await res.blob());
    } catch (e) {
      toast('L’export Word a échoué.');
    }
  }

  function exportPdf() {
    if (!doc) return;
    window.print();
  }

  /* Feuille d'impression : seule la feuille du contrat est imprimée. */
  function installPrintStyles() {
    if (document.getElementById('print-style')) return;
    var style = document.createElement('style');
    style.id = 'print-style';
    style.textContent = [
      '@media print {',
      '  body * { visibility: hidden; }',
      '  #paper, #paper * { visibility: visible; }',
      '  #paper { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none; border: 0; }',
      '  .side, .chat, .bar, .rz, .toast, .skip { display: none !important; }',
      '  #shell, #content, #app, .desk, .stage { display: block !important; height: auto !important; overflow: visible !important; }',
      '  @page { size: A4; margin: 2.5cm; }',
      '  #paper p { text-align: justify; }',
      '  #paper h2 { break-after: avoid; }',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------- */
  /* Types de contrat disponibles                                        */
  /* ---------------------------------------------------------------- */

  async function loadTemplates() {
    var list;
    try {
      var res = await fetch('/api/templates', { headers: headers() });
      if (!res.ok) return;
      var payload = await res.json();
      list = (payload.templates || []).filter(function (t) { return t.status === 'ready'; });
    } catch (e) {
      return;
    }
    if (!list.length) return;

    var container = $('chips');
    if (!container) return;
    container.innerHTML = '';
    list.forEach(function (template) {
      var button = document.createElement('button');
      button.className = 'chip';
      button.textContent = template.label;
      button.onclick = function () {
        pendingType = template.id;
        var input = $('hin');
        input.value = 'Je veux un ' + template.label.toLowerCase() + '.';
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      container.appendChild(button);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Branchement                                                        */
  /* ---------------------------------------------------------------- */

  function boot() {
    installPrintStyles();

    window.use = async function () { return null; };
    window.send = send;

    var word = $('dlWord');
    if (word) word.onclick = exportWord;
    var pdf = $('dlPdf');
    if (pdf) pdf.onclick = exportPdf;

    if (!MOCK) loadTemplates();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
