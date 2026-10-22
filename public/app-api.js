/*
 * Branchement de l'IA — alt.redige v2.
 *
 * Le front livré appelait `window.claude.use('sample')` (API de démonstration
 * absente de l'environnement de production). Ce fichier le remplace par
 * l'API LexCanvas et implémente la partie « agent » de la spécification
 * frontend v2 :
 *
 *   - machine à états pilotée uniquement par les événements SSE ;
 *   - bloc d'activité (phase, étapes, outils) dans la bulle de l'assistant ;
 *   - carte de question (`ask_user`) ;
 *   - suggestions de suite et sources juridiques ;
 *   - mode simulé `?mock=1` (scénarios de la spec).
 *
 * Le document affiché est une vue en blocs ; la source de vérité est le
 * Markdown du backend.
 *
 * Ce fichier est intégré dans `public/index.html` par `scripts/inject-app-api.mjs`.
 */
(function () {
  'use strict';

  var CONFIG = {
    API_BASE: '',
    MOCK: new URLSearchParams(location.search).has('mock'),
    STORAGE_KEY: 'altredige:convs',
    MAX_MESSAGES: 30,
    THINKING_SHOW_MS: 400,
    STALL_MS: 20000,
    TIMEOUT_MS: 90000,
    TOAST_MS: 4000,
    QUESTION_MAX_FIELDS: 6
  };

  var CODE_KEY = 'altredige.accesscode';
  var accessCode = '';
  try { accessCode = localStorage.getItem(CODE_KEY) || ''; } catch (e) { accessCode = ''; }

  /* ---------------------------------------------------------------- */
  /* Utilitaires                                                        */
  /* ---------------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* stockage indisponible */ } }
  function getS(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function uid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* pas de randomUUID */ }
    return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------------------------------------------------------- */
  /* État de l'agent (spec v2 §11)                                     */
  /* ---------------------------------------------------------------- */

  var agent = {
    state: 'idle',
    phase: null,
    steps: [],
    tools: [],
    thinking: null,
    startedAt: 0,
    lastByteAt: 0,
    controller: null,
    stallTimer: null,
    timeoutTimer: null,
    current: null
  };

  var STATE_LABELS = {
    idle: 'Prêt',
    connecting: 'Envoi…',
    thinking: 'Je réfléchis…',
    working: 'Je travaille…',
    replying: 'Je réponds…',
    drafting: 'Rédaction en cours…',
    editing: 'Modification en cours…',
    awaiting_input: 'J’ai besoin d’une précision',
    stalled: 'Cela prend plus de temps que prévu…',
    retrying: 'Nouvel essai…',
    cancelled: 'Interrompu',
    error: 'Erreur'
  };

  function setState(state) {
    agent.state = state;
    var orb = $('orb2') || $('orb');
    if (orb) {
      var visual = { idle: 'idle', connecting: 'thinking', thinking: 'thinking', working: 'writing', replying: 'writing', drafting: 'writing', editing: 'writing', awaiting_input: 'waiting', stalled: 'thinking', retrying: 'thinking', cancelled: 'idle', error: 'error' }[state] || 'idle';
      orb.setAttribute('data-state', visual);
    }
    var status = $('agentStatus');
    if (status) {
      status.textContent = STATE_LABELS[state] || '';
      status.hidden = state === 'idle';
    }
  }

  function resetActivity() {
    agent.phase = null;
    agent.steps = [];
    agent.tools = [];
    agent.thinking = null;
  }

  /* ---------------------------------------------------------------- */
  /* Markdown <-> blocs (vue affichée)                                  */
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
      if (/^##+\s+/.test(first)) {
        blocks.push({ t: 'h', x: first.replace(/^##+\s+/, '').trim(), md: first });
        continue;
      }
      if (/^\|/.test(first)) {
        blocks.push({ t: 'p', x: lines.join('\n'), md: lines.join('\n') });
        continue;
      }
      var joined = lines.map(function (l) { return l.trim(); }).join(' ');
      blocks.push({ t: 'p', x: joined, md: joined });
    }

    return { title: title, blocks: blocks };
  }

  /** Texte nu d'un fragment Markdown (gras, italique, marqueurs). */
  function plainOf(markdown) {
    return String(markdown)
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/\[À COMPLÉTER[^\]]*\]/g, ' ')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .trim();
  }

  /** Remplit un élément avec le rendu en ligne d'un fragment Markdown. */
  function renderInline(node, text) {
    var pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[À COMPLÉTER[^\]]*\])/g;
    var index = 0;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > index) node.appendChild(document.createTextNode(text.slice(index, match.index)));
      var token = match[0];
      if (token.indexOf('**') === 0) {
        var strong = el('strong');
        strong.textContent = token.slice(2, -2);
        node.appendChild(strong);
      } else if (token.charAt(0) === '*') {
        var em = el('em');
        em.textContent = token.slice(1, -1);
        node.appendChild(em);
      } else if (token.charAt(0) === '`') {
        var code = el('code');
        code.textContent = token.slice(1, -1);
        node.appendChild(code);
      } else {
        var mark = el('mark', 'ph', token);
        mark.setAttribute('title', 'Champ à compléter');
        node.appendChild(mark);
      }
      index = match.index + token.length;
    }
    if (index < text.length) node.appendChild(document.createTextNode(text.slice(index)));
  }

  function docToMarkdown(doc) {
    if (!doc) return '';
    var out = ['# ' + (doc.title || 'Contrat')];
    (doc.blocks || []).forEach(function (b) {
      if (!b || !b.x) return;
      // Le fragment d'origine est réutilisé tant que le texte n'a pas été modifié.
      if (b.md && plainOf(b.md) === String(b.x).trim()) out.push(b.md);
      else if (b.t === 'h') out.push('## ' + b.x);
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
    store(CODE_KEY, accessCode);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Historique conforme au contrat                                     */
  /* ---------------------------------------------------------------- */

  function history(messages) {
    var out = [];
    (messages || []).forEach(function (m) {
      if (!m || m.role !== 'user' && m.role !== 'assistant') return;
      if (!m.content) return;
      var last = out[out.length - 1];
      if (last && last.role === m.role) { last.content += '\n' + m.content; return; }
      out.push({ role: m.role, content: m.content });
    });
    while (out.length && out[out.length - 1].role !== 'user') out.pop();
    return out.slice(-CONFIG.MAX_MESSAGES);
  }

  /* ---------------------------------------------------------------- */
  /* Décodage SSE                                                       */
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
  /* Styles de l'agent                                                  */
  /* ---------------------------------------------------------------- */

  function installStyles() {
    if ($('agent-style')) return;
    var style = el('style');
    style.id = 'agent-style';
    style.textContent = [
      /* --- orbe de présence --- */
      '[data-state="thinking"]{animation:breathe 1.6s ease-in-out infinite}',
      '[data-state="writing"]{animation:pulse .9s ease-in-out infinite}',
      '[data-state="error"]{filter:saturate(.2)}',
      '@keyframes breathe{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.06);opacity:1}}',
      '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}',
      '@media (prefers-reduced-motion:reduce){[data-state]{animation:none!important}}',

      /* --- ligne d'état --- */
      '#agentStatus{font-size:12px;color:var(--mut);padding:2px 0 6px}',

      /* --- bloc d'activité --- */
      '.activity{border:1px solid var(--line);border-radius:12px;margin:0 0 8px;overflow:hidden;font-size:12.5px}',
      '.activity>summary{cursor:pointer;list-style:none;padding:7px 10px;color:var(--mut);display:flex;gap:8px;align-items:center}',
      '.activity>summary::-webkit-details-marker{display:none}',
      '.act-body{padding:0 10px 9px}',
      '.act-phase{display:flex;gap:7px;align-items:center;margin-bottom:7px;color:var(--ink)}',
      '.act-phase .dot{width:7px;height:7px;border-radius:50%;background:var(--ink);flex:none}',
      '.act-phase.active .dot{animation:breathe 1.6s ease-in-out infinite}',
      '.act-steps{list-style:none;margin:0;padding:0;display:grid;gap:3px}',
      '.act-steps li{display:flex;gap:8px;align-items:baseline;color:var(--mut)}',
      '.act-steps li.running{color:var(--ink)}',
      '.act-steps li.done{opacity:.62}',
      '.act-steps .mark{width:14px;flex:none;text-align:center}',
      '.act-steps .detail{opacity:.7}',
      '.act-tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}',
      '.act-tools .tool{border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--mut);font-size:11.5px}',
      '.act-tools .tool.ok{border-color:var(--line);color:var(--ink)}',
      '.act-tools .tool.ko{border-color:#c66;color:#c66}',
      '.act-think{margin-top:8px}',
      '.act-think>summary{cursor:pointer;color:var(--mut);font-size:11.5px}',
      '.act-think .body{color:var(--mut);white-space:pre-wrap;padding-top:5px}',

      /* --- carte de question --- */
      '.qcard{border:1px solid var(--line);border-radius:14px;padding:12px;margin:4px 0 8px;background:var(--panel)}',
      '.qcard .q{font-weight:600;margin-bottom:6px}',
      '.qcard details.why{color:var(--mut);font-size:12px;margin-bottom:8px}',
      '.qcard details.why summary{cursor:pointer}',
      '.qopts{display:grid;gap:6px;margin:2px 0 10px}',
      '.qopts label{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:8px 10px;cursor:pointer;min-height:44px}',
      '.qopts label:has(input:checked){border-color:var(--ink);background:var(--chip)}',
      '.qcard .qfields{display:grid;gap:8px;margin-bottom:10px}',
      '.qcard .qfields label{display:grid;gap:3px;font-size:12.5px;color:var(--mut)}',
      '.qcard input[type=text],.qcard input[type=number],.qcard input[type=date],.qcard select{font:inherit;padding:8px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);min-height:44px}',
      '.qcard .qerr{color:#c66;font-size:12px;min-height:15px}',
      '.qactions{display:flex;gap:8px;flex-wrap:wrap}',
      '.qcard .answered{color:var(--mut);font-size:12.5px}',

      /* --- suggestions et sources --- */
      '.chipsrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '.chipsrow .chip{font-size:12.5px;padding:5px 11px;min-height:34px}',
      '.srcrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.srcrow .src{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11.5px;color:var(--mut)}',

      /* --- explication de clause --- */
      '.clause{border:1px solid var(--line);border-radius:14px;padding:12px;margin:8px 0;background:var(--panel);font-size:13.5px;line-height:1.55}',
      '.clause .clause-title{font-weight:600;margin-bottom:6px}',
      '.clause .clause-quote{margin:6px 0;padding:6px 10px;border-left:3px solid var(--line);color:var(--mut);font-style:italic}',
      '.clause .clause-list{margin:6px 0;padding-left:18px}',
      '.clause .clause-limits{margin-top:8px;font-size:11.5px;color:var(--mut)}',

      /* --- champs obligatoires et avertissement juridique --- */
      '.fieldsbox{margin:8px 0;font-size:12.5px;color:var(--mut)}',
      '.fieldsbox .fields-title{margin-bottom:2px}',
      '.legalnotice{margin:8px 0;padding:8px 10px;border-radius:10px;font-size:11.5px;color:var(--mut);border:1px solid var(--line);background:var(--panel)}',

      /* --- bandeau mode simulé --- */
      '#mockBanner{position:fixed;top:0;left:0;right:0;z-index:50;background:#b45309;color:#fff;font-size:12px;text-align:center;padding:3px}',

      /* --- impression --- */
      '@media print{body *{visibility:hidden}#paper,#paper *{visibility:visible}#paper{position:absolute;left:0;top:0;width:100%;box-shadow:none;border:0}.side,.chat,.bar,.rz,.toast,.skip,#agentStatus,.activity{display:none!important}#shell,#content,#app,.desk,.stage{display:block!important;height:auto!important;overflow:visible!important}@page{size:A4;margin:2.5cm}#paper p{text-align:justify}#paper h2{break-after:avoid}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function installMockBanner() {
    if ($('mockBanner')) return;
    var banner = el('div', '', 'MODE SIMULÉ');
    banner.id = 'mockBanner';
    document.body.appendChild(banner);
  }

  /* ---------------------------------------------------------------- */
  /* Rendu : bloc d'activité                                            */
  /* ---------------------------------------------------------------- */

  function renderActivity(message) {
    var activity = message.activity;
    if (!activity) return null;

    var steps = activity.steps || [];
    var tools = activity.tools || [];
    var hasContent = steps.length || tools.length || activity.phase || activity.thinking;
    if (!hasContent) return null;

    var details = el('details', 'activity');
    details.open = message.status === 'streaming';
    var summary = el('summary');
    summary.appendChild(el('span', 'act-sum-label', activity.collapsedLabel || 'Activité'));
    details.appendChild(summary);

    var body = el('div', 'act-body');

    if (activity.phase) {
      var phase = el('div', 'act-phase' + (message.status === 'streaming' ? ' active' : ''));
      phase.appendChild(el('span', 'dot'));
      phase.appendChild(el('span', '', activity.phase));
      body.appendChild(phase);
    }

    if (steps.length) {
      var list = el('ul', 'act-steps');
      steps.forEach(function (step) {
        var item = el('li', step.state || '');
        var marks = { running: '◐', done: '✓', failed: '✕', skipped: '–', pending: '○' };
        item.appendChild(el('span', 'mark', marks[step.state] || '○'));
        item.appendChild(el('span', '', step.label || ''));
        if (step.detail) item.appendChild(el('span', 'detail', '— ' + step.detail));
        list.appendChild(item);
      });
      body.appendChild(list);
    }

    if (tools.length) {
      var chips = el('div', 'act-tools');
      tools.forEach(function (tool) {
        var chip = el('span', 'tool ' + (tool.ok ? 'ok' : 'ko'));
        chip.textContent = tool.label + (tool.ms ? ' · ' + (tool.ms / 1000).toFixed(1).replace('.', ',') + ' s' : '');
        chips.appendChild(chip);
      });
      body.appendChild(chips);
    }

    if (activity.thinking && activity.thinking.text) {
      var think = el('details', 'act-think');
      var thinkSummary = el('summary', '', 'Résumé de la réflexion' + (activity.thinking.ms ? ' · ' + Math.round(activity.thinking.ms / 1000) + ' s' : ''));
      think.appendChild(thinkSummary);
      think.appendChild(el('div', 'body', activity.thinking.text));
      body.appendChild(think);
    }

    details.appendChild(body);
    return details;
  }

  /* ---------------------------------------------------------------- */
  /* Rendu : carte de question                                          */
  /* ---------------------------------------------------------------- */

  function questionCard(message) {
    var question = message.question;
    if (!question) return null;

    var card = el('div', 'qcard');
    card.appendChild(el('div', 'q', question.question || ''));

    if (question.why) {
      var why = el('details', 'why');
      why.appendChild(el('summary', '', 'Pourquoi je demande'));
      why.appendChild(el('div', '', question.why));
      card.appendChild(why);
    }

    if (question.answered) {
      var summary = question.answered.skipped
        ? 'Question passée — je laisserai un champ à compléter.'
        : 'Réponse : ' + Object.keys(question.answered.values || {}).map(function (key) {
          return key + ' : ' + question.answered.values[key];
        }).join(', ');
      card.appendChild(el('div', 'answered', summary));
      return card;
    }

    var inputs = {};
    var error = el('div', 'qerr');

    function control(name, label, type, options) {
      var wrap = el('label');
      wrap.appendChild(el('span', '', label));
      if (type === 'select') {
        var select = el('select');
        (options || []).forEach(function (option) {
          var item = el('option', '', option.label);
          item.value = option.id;
          select.appendChild(item);
        });
        wrap.appendChild(select);
        inputs[name] = { node: select, type: 'select' };
      } else {
        var input = el('input');
        input.type = type === 'amount' || type === 'number' ? 'number' : (type === 'date' ? 'date' : 'text');
        wrap.appendChild(input);
        inputs[name] = { node: input, type: type };
      }
      return wrap;
    }

    if (question.kind === 'single' || question.kind === 'multi') {
      var options = el('div', 'qopts');
      (question.options || []).forEach(function (option) {
        var label = el('label');
        var input = el('input');
        input.type = question.kind === 'multi' ? 'checkbox' : 'radio';
        input.name = 'q_' + question.question_id;
        input.value = option.id;
        label.appendChild(input);
        label.appendChild(el('span', '', option.label));
        options.appendChild(label);
      });
      if (question.allow_other) {
        var other = el('label');
        var otherInput = el('input');
        otherInput.type = question.kind === 'multi' ? 'checkbox' : 'radio';
        otherInput.name = 'q_' + question.question_id;
        otherInput.value = '__other__';
        other.appendChild(otherInput);
        other.appendChild(el('span', '', 'Autre…'));
        options.appendChild(other);
      }
      card.appendChild(options);
    } else if (question.kind === 'confirm') {
      var confirm = el('div', 'qopts');
      (question.options || []).forEach(function (option) {
        var label = el('label');
        var input = el('input');
        input.type = 'radio';
        input.name = 'q_' + question.question_id;
        input.value = option.id;
        label.appendChild(input);
        label.appendChild(el('span', '', option.label));
        confirm.appendChild(label);
      });
      card.appendChild(confirm);
    } else if (question.kind === 'form') {
      var fields = el('div', 'qfields');
      (question.fields || []).slice(0, CONFIG.QUESTION_MAX_FIELDS).forEach(function (field) {
        fields.appendChild(control(field.id, field.label + (field.required ? ' *' : ''), field.type, field.options));
      });
      card.appendChild(fields);
    } else if (question.kind === 'text') {
      var single = el('div', 'qfields');
      single.appendChild(control('text', 'Votre réponse', 'text'));
      card.appendChild(single);
    } else {
      var single = el('div', 'qfields');
      single.appendChild(control('text', 'Votre réponse', 'text'));
      card.appendChild(single);
    }

    var actions = el('div', 'qactions');
    var validate = el('button', 'btn main', 'Valider');
    validate.onclick = function () { submit(question, card, inputs, error); };
    actions.appendChild(validate);

    if (question.blocking === false) {
      var skip = el('button', 'btn', 'Passer');
      skip.onclick = function () { submit(question, card, inputs, error, true); };
      actions.appendChild(skip);
    }
    card.appendChild(actions);
    card.appendChild(error);
    return card;
  }

  function submit(question, card, inputs, error, skipped) {
    var values = {};
    var labels = [];

    if (skipped) {
      // Rien à envoyer : le front le signale et laisse un champ à compléter.
      card.innerHTML = '';
      card.appendChild(el('div', 'answered', 'Question passée — je laisserai un champ à compléter.'));
      return;
    }

    if (question.kind === 'single' || question.kind === 'confirm') {
      var checked = card.querySelector('input[name="q_' + question.question_id + '"]:checked');
      if (!checked) { error.textContent = 'Choisissez une option.'; return; }
      if (checked.value === '__other__') {
        var free = el('input');
        free.type = 'text';
        free.placeholder = 'Votre réponse';
        card.appendChild(free);
        error.textContent = 'Indiquez votre réponse.';
        free.onkeydown = function (e) { if (e.key === 'Enter') { values.other = free.value; labels.push(free.value); finish(); } };
        return;
      }
      values.choice = checked.value;
      var label = card.querySelector('label:has(input:checked) span');
      labels.push(label ? label.textContent : checked.value);
    } else if (question.kind === 'multi') {
      var all = card.querySelectorAll('input[name="q_' + question.question_id + '"]:checked');
      var choices = [];
      all.forEach(function (input) { choices.push(input.value); });
      if (!choices.length) { error.textContent = 'Choisissez au moins une option.'; return; }
      values.choices = choices;
      labels = choices.map(function (value) {
        var node = card.querySelector('label:has(input[value="' + value + '"]) span');
        return node ? node.textContent : value;
      });
    } else if (question.kind === 'form') {
      var missing = null;
      (question.fields || []).forEach(function (field) {
        var entry = inputs[field.id];
        if (!entry) return;
        var value = entry.node.value.trim();
        if (field.required && !value) missing = missing || field.label;
        values[field.id] = value;
        if (value) labels.push(field.label + ' : ' + value);
      });
      if (missing) { error.textContent = 'Le champ « ' + missing + ' » est obligatoire.'; return; }
    } else {
      var text = inputs.text && inputs.text.node.value.trim();
      if (!text) { error.textContent = 'Saisissez une réponse.'; return; }
      values.text = text;
      labels.push(text);
    }

    function finish() {
      var content = labels.join(', ') || 'Réponse envoyée';
      var answers = [{ question_id: question.question_id, values: values, skipped: false }];
      card.innerHTML = '';
      card.appendChild(el('div', 'answered', 'Réponse : ' + content));
      if (typeof window.answerQuestion === 'function') window.answerQuestion(content, answers);
    }

    finish();
  }

  /* ---------------------------------------------------------------- */
  /* Rendu : sources et suggestions                                     */
  /* ---------------------------------------------------------------- */

  function renderSources(message) {
    if (!message.sources || !message.sources.length) return null;
    var row = el('div', 'srcrow');
    message.sources.forEach(function (source) {
      var chip = el('span', 'src', source.title + (source.ref ? ' · ' + source.ref : ''));
      if (source.url) {
        var link = el('a', 'src');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = chip.textContent;
        row.appendChild(link);
      } else {
        row.appendChild(chip);
      }
    });
    return row;
  }

  function renderSuggestions(message) {
    if (!message.suggestions || !message.suggestions.length) return null;
    var row = el('div', 'chipsrow');
    message.suggestions.forEach(function (suggestion) {
      var chip = el('button', 'chip', suggestion.label);
      chip.onclick = function () { window.send(suggestion.message); };
      row.appendChild(chip);
    });
    return row;
  }

  /* ---------------------------------------------------------------- */
  /* Rendu : explication de clause, champs, avertissement juridique     */
  /* ---------------------------------------------------------------- */

  /** L'explication d'une clause (`clause_explained`). */
  function renderClause(message) {
    if (!message.clause) return null;
    var clause = message.clause;
    var box = el('div', 'clause');

    box.appendChild(el('div', 'clause-title', clause.article || 'Clause'));
    if (clause.quote) box.appendChild(el('blockquote', 'clause-quote', clause.quote));
    if (clause.explanation) box.appendChild(el('div', 'clause-text', clause.explanation));

    if (clause.obligations && clause.obligations.length) {
      var obligations = el('ul', 'clause-list');
      clause.obligations.forEach(function (item) {
        var label = item.party ? item.party + ' — ' : '';
        obligations.appendChild(el('li', '', label + (item.duty || '')));
      });
      box.appendChild(obligations);
    }

    if (clause.risks && clause.risks.length) {
      var risks = el('ul', 'clause-list');
      clause.risks.forEach(function (risk) { risks.appendChild(el('li', '', risk)); });
      box.appendChild(risks);
    }

    if (clause.limits) box.appendChild(el('div', 'clause-limits', clause.limits));
    return box;
  }

  /** L'avertissement de revalidation juridique (`legal_notice`). */
  function renderLegalNotice(message) {
    if (!message.legalNotice || !message.legalNotice.text) return null;
    return el('div', 'legalnotice', message.legalNotice.text);
  }

  /** Les champs obligatoires qui restent à compléter (`validation.fields`). */
  function renderFields(message) {
    if (!message.fields || !message.fields.required) return null;
    var missing = message.fields.required.filter(function (field) { return !field.filled; });
    if (!missing.length) return null;
    var box = el('div', 'fieldsbox');
    box.appendChild(el('div', 'fields-title', 'Champs obligatoires à compléter :'));
    var row = el('div', 'chipsrow');
    missing.forEach(function (field) { row.appendChild(el('span', 'chip', field.label)); });
    box.appendChild(row);
    return box;
  }

  /* ---------------------------------------------------------------- */
  /* Bulle de l'assistant                                                */
  /* ---------------------------------------------------------------- */

  function assistantBubble(message) {
    var bubble = el('div', 'm ai');
    bubble.setAttribute('data-message-id', message.id);

    var activity = renderActivity(message);
    if (activity) bubble.appendChild(activity);

    var text = el('div', 'msg-text', message.content || '');
    bubble.appendChild(text);

    var card = questionCard(message);
    if (card) bubble.appendChild(card);

    var clause = renderClause(message);
    if (clause) bubble.appendChild(clause);

    var fields = renderFields(message);
    if (fields) bubble.appendChild(fields);

    var notice = renderLegalNotice(message);
    if (notice) bubble.appendChild(notice);

    var sources = renderSources(message);
    if (sources) bubble.appendChild(sources);

    var suggestions = renderSuggestions(message);
    if (suggestions) bubble.appendChild(suggestions);

    if (message.error) {
      var error = el('div', 'qerr', message.error.message || 'Une erreur est survenue.');
      bubble.appendChild(error);
      var retry = el('button', 'btn', 'Réessayer');
      retry.onclick = function () { window.send(message.retryText || ''); };
      bubble.appendChild(retry);
    }

    return bubble;
  }

  function refreshBubble(message) {
    var old = document.querySelector('[data-message-id="' + message.id + '"]');
    if (!old) return;
    var fresh = assistantBubble(message);
    old.parentNode.replaceChild(fresh, old);
  }

  /* ---------------------------------------------------------------- */
  /* Envoi                                                              */
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

  function startStallWatch() {
    clearTimeout(agent.stallTimer);
    agent.stallTimer = setTimeout(function () {
      if (agent.state === 'thinking' || agent.state === 'working' || agent.state === 'drafting') {
        setState('stalled');
      }
    }, CONFIG.STALL_MS);
  }

  function clearWatchers() {
    clearTimeout(agent.stallTimer);
    clearTimeout(agent.timeoutTimer);
  }

  async function send(text) {
    if (!text || busy) return;
    readDoc();

    var c = curConv();
    if (!c) { c = { id: Date.now(), title: text.slice(0, 40), doc: null, msgs: [] }; convs.unshift(c); cur = c.id; }
    view('app'); renderHist();
    ['hin', 'cin'].forEach(function (i) { $(i).value = ''; $(i).style.height = 'auto'; });

    var userMessage = { id: uid(), role: 'user', content: text, status: 'done' };
    c.msgs.push(userMessage);
    msg('you', text, true);

    var message = { id: uid(), role: 'assistant', content: '', status: 'streaming', activity: { phase: null, steps: [], tools: [], thinking: null, ms: 0 }, question: null, sources: [], suggestions: [], error: null, retryText: text };
    c.msgs.push(message);
    var bubble = assistantBubble(message);
    $('msgs').appendChild(bubble);
    $('msgs').scrollTop = 1e9;

    busy = true; $('csend').disabled = true; $('orb2').classList.add('busy');
    if (!doc) skel();

    resetActivity();
    setState('connecting');
    agent.startedAt = Date.now();
    agent.lastByteAt = agent.startedAt;
    startStallWatch();
    agent.timeoutTimer = setTimeout(function () {
      finishWithError(message, { code: 'timeout', message: 'La génération a pris trop de temps. Réessayez.', retryable: true });
    }, CONFIG.TIMEOUT_MS);

    var pendingAnswers = null;
    window.answerQuestion = function (content, answers) { pendingAnswers = answers; window.send(content, answers); };

    if (CONFIG.MOCK) {
      await mockTurn(text, message, bubble, c);
      return;
    }

    var body = {
      messages: history(c.msgs.filter(function (m) { return m.id !== message.id; })),
      document: doc ? { markdown: docToMarkdown(doc), version: doc.version || 1 } : null,
      contract_type: (doc && doc.contractType) || null
    };
    if (pendingAnswers) body.answers = pendingAnswers;

    var response;
    try {
      response = await fetch(CONFIG.API_BASE + '/api/chat', {
        method: 'POST',
        headers: headers({ 'X-Request-Id': uid() }),
        body: JSON.stringify(body)
      });
    } catch (e) {
      finishWithError(message, { code: 'network', message: 'Connexion impossible. Vérifiez votre réseau.', retryable: true });
      return;
    }

    if (response.status === 401 && askAccessCode()) {
      try {
        response = await fetch(CONFIG.API_BASE + '/api/chat', {
          method: 'POST',
          headers: headers({ 'X-Request-Id': uid() }),
          body: JSON.stringify(body)
        });
      } catch (e) {
        finishWithError(message, { code: 'network', message: 'Connexion impossible. Vérifiez votre réseau.', retryable: true });
        return;
      }
    }

    if (!response.ok) {
      var payload = null;
      try { payload = await response.json(); } catch (e) { /* corps illisible */ }
      var code = payload && payload.error ? payload.error.code : 'internal';
      finishWithError(message, { code: code, message: payload && payload.error ? payload.error.message : errorText(code), retryable: true });
      return;
    }

    setState('thinking');

    try {
      await readSse(response, function (event, data) {
        agent.lastByteAt = Date.now();
        startStallWatch();
        handleEvent(event, data, message, bubble);
      });
    } catch (e) {
      finishWithError(message, { code: 'network', message: 'Connexion interrompue. Réessayez.', retryable: true });
      return;
    }

    finalize(message, bubble, c);
  }

  function handleEvent(event, data, message, bubble) {
    switch (event) {
      case 'ready':
        setState('thinking');
        break;

      case 'status':
      case 'phase':
        message.activity.phase = data.label || data.phase || message.activity.phase;
        if (stateIsQuiet(agent.state)) setState('thinking');
        refreshBubble(message);
        break;

      case 'plan':
        message.activity.steps = (data.steps || []).map(function (step) {
          return { id: step.id, label: step.label, state: 'pending', detail: '' };
        });
        refreshBubble(message);
        break;

      case 'step':
        (message.activity.steps || []).forEach(function (step) {
          if (step.id === data.id) {
            step.state = data.state;
            step.detail = data.detail || step.detail;
          }
        });
        if (data.state === 'running') setState('working');
        refreshBubble(message);
        break;

      case 'tool_start':
        message.activity.tools.push({ id: data.id, label: data.label || data.name, ok: true, ms: 0, startedAt: Date.now() });
        setState('working');
        refreshBubble(message);
        break;

      case 'tool_end':
        (message.activity.tools || []).forEach(function (tool) {
          if (tool.id === data.id) {
            tool.ok = data.ok !== false;
            tool.ms = typeof data.duration_ms === 'number' ? data.duration_ms : 0;
            tool.label = tool.label + (data.result_summary ? ' — ' + data.result_summary : '');
          }
        });
        refreshBubble(message);
        break;

      case 'thinking_start':
        message.activity.thinking = { text: '', ms: 0, startedAt: Date.now(), id: data.id };
        break;

      case 'thinking_delta':
        if (!message.activity.thinking) message.activity.thinking = { text: '', ms: 0, startedAt: Date.now() };
        message.activity.thinking.text += data.text || '';
        refreshBubble(message);
        break;

      case 'thinking_end':
        if (message.activity.thinking) message.activity.thinking.ms = data.duration_ms || 0;
        refreshBubble(message);
        break;

      case 'retry':
        setState('retrying');
        message.activity.phase = data.label || message.activity.phase;
        refreshBubble(message);
        break;

      case 'warning':
        toast(data.label || 'Avertissement');
        break;

      case 'text_delta':
        message.content += data.text || '';
        setState('replying');
        refreshBubble(message);
        break;

      case 'canvas_start':
        setState(data.mode === 'edit' ? 'editing' : 'drafting');
        message.activity.phase = data.reason || message.activity.phase;
        refreshBubble(message);
        break;

      case 'canvas_delta':
        if (agent.state !== 'editing') setState('drafting');
        appendDraft(data.text || '');
        break;

      case 'canvas_set':
        var parsed = markdownToDoc(data.markdown);
        parsed.version = data.version;
        parsed.contractType = data.contract_type || null;
        parsed.markdown = data.markdown;
        parsed.placeholders = data.validation ? data.validation.placeholders : 0;
        parsed.issues = (data.validation && data.validation.issues) || [];
        // Champs obligatoires et avertissement juridique (contrat d'API §3.3).
        message.fields = (data.validation && data.validation.fields) || null;
        message.legalNotice = data.legal_notice || null;
        if (cur === curConv().id) { doc = parsed; render(true); }
        curConv().doc = parsed;
        curConv().title = parsed.title;
        persist(); renderHist();
        setState('replying');
        refreshBubble(message);
        break;

      case 'clause_explained':
        message.clause = data;
        refreshBubble(message);
        break;

      case 'ask_user':
        message.question = data;
        setState('awaiting_input');
        refreshBubble(message);
        break;

      case 'sources':
        message.sources = data.items || [];
        refreshBubble(message);
        break;

      case 'suggestions':
        message.suggestions = data.items || [];
        refreshBubble(message);
        break;

      case 'done':
        if (data.stop_reason === 'awaiting_input') setState('awaiting_input');
        break;

      case 'error':
        finishWithError(message, { code: data.code, message: data.message || errorText(data.code), retryable: data.retryable });
        break;

      default:
        break; // événement inconnu : ignoré, sans erreur
    }
  }

  function stateIsQuiet(state) {
    return state === 'idle' || state === 'connecting' || state === 'thinking';
  }

  function appendDraft(text) {
    var paper = $('paper');
    if (!paper) return;
    if (!paper.querySelector('h1')) {
      var h = el('h1', '', 'Rédaction en cours…');
      paper.innerHTML = '';
      paper.appendChild(h);
    }
    var last = paper.lastElementChild;
    if (last && last.tagName === 'P') last.textContent += text;
    else { var p = el('p', '', text); paper.appendChild(p); }
  }

  function finishWithError(message, error) {
    clearWatchers();
    message.status = 'error';
    message.error = error;
    setState('error');
    refreshBubble(message);
    persist();
    endTurn();
  }

  function finalize(message, bubble, c) {
    clearWatchers();
    message.status = 'done';
    message.activity.ms = Date.now() - agent.startedAt;
    var steps = message.activity.steps || [];
    message.activity.collapsedLabel = steps.length + ' étape' + (steps.length > 1 ? 's' : '') + ' · ' + Math.max(1, Math.round(message.activity.ms / 1000)) + ' s';
    setState(message.question ? 'awaiting_input' : 'idle');
    refreshBubble(message);
    persist();
    endTurn();
  }

  function endTurn() {
    if (doc) {
      doc.markdown = docToMarkdown(doc);
      updateDocMeta(doc);
    }
    busy = false;
    $('orb2').classList.remove('busy');
    $('csend').disabled = !$('cin').value.trim();
  }

  /* ---------------------------------------------------------------- */
  /* Mode simulé (spec v2 §8 et §15)                                    */
  /* ---------------------------------------------------------------- */

  function mockStream(events) {
    var chunks = events.map(function (event) {
      return 'event: ' + event.event + '\ndata: ' + JSON.stringify(event.data) + '\n\n';
    }).join('');
    var encoder = new TextEncoder();
    var bytes = encoder.encode(chunks);
    return new Response(new ReadableStream({
      start: function (controller) {
        var offset = 0;
        function push() {
          if (offset >= bytes.length) { controller.close(); return; }
          var size = 60 + Math.floor(Math.random() * 90);
          controller.enqueue(bytes.slice(offset, offset + size));
          offset += size;
          setTimeout(push, 50 + Math.floor(Math.random() * 100));
        }
        push();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  var MOCK_CONTRACT = [
    '# Contrat de bail à usage d\'habitation',
    '',
    'Entre les soussignés :',
    '',
    '**Monsieur [À COMPLÉTER : nom du bailleur]**, demeurant à [À COMPLÉTER : adresse], ci-après « le **Bailleur** »,',
    '',
    'et **Madame [À COMPLÉTER : nom de la locataire]**, demeurant à [À COMPLÉTER : adresse], ci-après « la **Locataire** ».',
    '',
    '## Article 1 – Objet du contrat',
    '',
    'Le Bailleur donne à bail à la Locataire un studio situé à [À COMPLÉTER : adresse du logement], à usage d\'habitation.',
    '',
    '## Article 2 – Durée et loyer',
    '',
    '1. Le bail est consenti pour une durée de 12 mois.',
    '2. Le loyer mensuel est fixé à **70 000 FCFA**.',
    '',
    '## Article 3 – Signatures',
    '',
    'Fait à Abidjan, le [À COMPLÉTER : date].',
    '',
    '| Le Bailleur | La Locataire |',
    '|---|---|',
    '| Lu et approuvé | Lu et approuvé |'
  ].join('\n');

  async function mockTurn(text, message, bubble, c) {
    var lower = text.toLowerCase();
    var events;

    if (lower.indexOf('limite') !== -1) {
      var error = await fetch(CONFIG.API_BASE + '/api/chat', { method: 'POST', headers: headers(), body: '{}' });
      void error;
      message.status = 'error';
      message.error = { code: 'rate_limited', message: 'Trop de demandes. Réessayez dans quelques instants.', retryable: true };
      setState('error');
      refreshBubble(message);
      endTurn();
      return;
    }

    if (lower.indexOf('erreur') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'canvas_start', data: { seq: 2, t: 50, mode: 'create', title: 'Contrat' } },
        { event: 'canvas_delta', data: { seq: 3, t: 100, text: '# Brouillon interrompu' } },
        { event: 'error', data: { seq: 4, t: 150, code: 'truncated', message: 'Le contrat est trop long pour être généré d\'un seul coup. Réessayez.', retryable: true } }
      ];
    } else if (lower.indexOf('explique') !== -1 || lower.indexOf('expliquer') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'phase', data: { seq: 2, t: 80, phase: 'understanding', label: 'Je relis la clause demandée' } },
        { event: 'tool_start', data: { seq: 3, t: 120, id: 't1', name: 'explain_clause', label: 'J\'explique la clause' } },
        { event: 'tool_end', data: { seq: 4, t: 400, id: 't1', ok: true, duration_ms: 280, result_summary: 'Article 2 – Résiliation expliqué' } },
        { event: 'clause_explained', data: { seq: 5, t: 420, article: 'Article 2 – Résiliation', quote: 'Chaque partie peut résilier le bail selon les modalités ci-dessous.', explanation: 'Le texte prévoit que chaque partie peut mettre fin au bail en respectant les modalités indiquées juste après. Il s\'applique aux deux parties.', obligations: [{ party: 'chaque partie', duty: 'respecter les modalités de résiliation prévues au contrat' }], risks: ['Les délais de préavis doivent être respectés.'], depends_on: ['durée du bail'], limits: 'Cette explication est une aide à la lecture. Elle ne remplace pas l\'avis d\'un professionnel du droit.', document_version: 1 } },
        { event: 'text_delta', data: { seq: 6, t: 500, text: 'Voici ce que prévoit la clause de résiliation.' } },
        { event: 'done', data: { seq: 7, t: 550, stop_reason: 'end_turn' } }
      ];
    } else if (lower.indexOf('question') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'phase', data: { seq: 2, t: 100, phase: 'understanding', label: 'Je lis votre demande' } },
        { event: 'ask_user', data: { seq: 3, t: 200, question_id: 'q_duree', kind: 'single', question: 'Quelle durée pour le bail ?', why: 'Elle détermine le préavis et le renouvellement.', blocking: true, allow_other: true, options: [{ id: '6', label: '6 mois' }, { id: '12', label: '12 mois' }, { id: '24', label: '24 mois' }] } },
        { event: 'done', data: { seq: 4, t: 250, stop_reason: 'awaiting_input' } }
      ];
    } else if (lower.indexOf('confirmer') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'ask_user', data: { seq: 2, t: 150, question_id: 'q_remplacer', kind: 'confirm', question: 'Remplacer l\'article 4 ?', blocking: true, allow_other: false, options: [{ id: 'yes', label: 'Remplacer' }, { id: 'no', label: 'Garder' }] } },
        { event: 'done', data: { seq: 3, t: 200, stop_reason: 'awaiting_input' } }
      ];
    } else if (lower.indexOf('formulaire') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'ask_user', data: { seq: 2, t: 150, question_id: 'q_form', kind: 'form', question: 'Quelques informations ?', why: 'Elles sont nécessaires au contrat.', blocking: true, allow_other: false, fields: [{ id: 'bailleur', label: 'Bailleur', type: 'text', required: true }, { id: 'locataire', label: 'Locataire', type: 'text', required: true }, { id: 'loyer', label: 'Loyer', type: 'amount', unit: 'FCFA', required: false }, { id: 'effet', label: 'Date d\'effet', type: 'date', required: false }] } },
        { event: 'done', data: { seq: 3, t: 200, stop_reason: 'awaiting_input' } }
      ];
    } else if (lower.indexOf('réflexion') !== -1 || lower.indexOf('reflexion') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'phase', data: { seq: 2, t: 100, phase: 'researching', label: 'Je consulte le modèle de bail' } },
        { event: 'plan', data: { seq: 3, t: 150, steps: [{ id: 's1', label: 'Identifier les parties' }, { id: 's2', label: 'Choisir les clauses' }, { id: 's3', label: 'Rédiger' }, { id: 's4', label: 'Vérifier' }] } },
        { event: 'step', data: { seq: 4, t: 200, id: 's1', state: 'running' } },
        { event: 'step', data: { seq: 5, t: 400, id: 's1', state: 'done', detail: 'Bailleur et locataire identifiés' } },
        { event: 'step', data: { seq: 6, t: 420, id: 's2', state: 'done' } },
        { event: 'step', data: { seq: 7, t: 440, id: 's3', state: 'running' } },
        { event: 'thinking_start', data: { seq: 8, t: 450, id: 'th1' } },
        { event: 'thinking_delta', data: { seq: 9, t: 600, id: 'th1', text: 'Le bail est meublé, donc la durée minimale diffère.' } },
        { event: 'thinking_end', data: { seq: 10, t: 1200, id: 'th1', duration_ms: 750 } },
        { event: 'tool_start', data: { seq: 11, t: 1300, id: 't1', name: 'get_template', label: 'Je consulte le modèle de contrat' } },
        { event: 'tool_end', data: { seq: 12, t: 1800, id: 't1', ok: true, duration_ms: 500, result_summary: 'Modèle « Bail d\'habitation »' } },
        { event: 'tool_start', data: { seq: 13, t: 1900, id: 't2', name: 'create_canvas', label: 'Je rédige le contrat' } },
        { event: 'tool_end', data: { seq: 14, t: 2600, id: 't2', ok: true, duration_ms: 700, result_summary: 'Contrat écrit, 5 champs à compléter' } },
        { event: 'canvas_start', data: { seq: 15, t: 2700, mode: 'create', title: 'Contrat de bail' } },
        { event: 'canvas_delta', data: { seq: 16, t: 2800, text: '# Contrat de bail à usage d\'habitation\n\n' } },
        { event: 'canvas_set', data: { seq: 17, t: 3000, mode: 'create', markdown: MOCK_CONTRACT, version: 1, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 5, issues: [], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }, { key: 'locataire', label: 'Identité du locataire', filled: false }, { key: 'loyer', label: 'Loyer mensuel', filled: true }], optional: [{ key: 'caution', label: 'Caution', filled: false }] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'sources', data: { seq: 18, t: 3100, items: [{ id: 's01', title: 'Code du travail de Côte d\'Ivoire', ref: 'S01', kind: 'law', url: null }] } },
        { event: 'suggestions', data: { seq: 19, t: 3200, items: [{ label: 'Compléter les champs restants', message: 'Complète les champs restants' }, { label: 'Ajouter une pénalité de retard', message: 'Ajoute une clause de pénalité de retard' }] } },
        { event: 'text_delta', data: { seq: 20, t: 3300, text: 'Le bail est prêt. Il reste 5 champs à compléter.' } },
        { event: 'done', data: { seq: 21, t: 3400, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } }
      ];
    } else if (lower.indexOf('préavis') !== -1 || lower.indexOf('preavis') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'canvas_start', data: { seq: 2, t: 60, mode: 'edit', title: 'Contrat de bail', reason: 'Je modifie le préavis' } },
        { event: 'canvas_set', data: { seq: 3, t: 400, mode: 'edit', markdown: MOCK_CONTRACT.replace('12 mois', '3 mois'), version: 2, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 5, issues: [], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }, { key: 'locataire', label: 'Identité du locataire', filled: false }, { key: 'loyer', label: 'Loyer mensuel', filled: true }], optional: [{ key: 'caution', label: 'Caution', filled: false }] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'text_delta', data: { seq: 4, t: 500, text: 'Le préavis est passé à trois mois.' } },
        { event: 'done', data: { seq: 5, t: 550, stop_reason: 'end_turn' } }
      ];
    } else if (lower.indexOf('lent') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'phase', data: { seq: 2, t: 100, phase: 'researching', label: 'Je consulte le modèle de bail' } }
      ];
    } else if (lower.indexOf('retry') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'retry', data: { seq: 2, t: 100, attempt: 1, max: 3, label: 'Connexion interrompue, je réessaie', delay_ms: 500 } },
        { event: 'retry', data: { seq: 3, t: 400, attempt: 2, max: 3, label: 'Connexion interrompue, je réessaie', delay_ms: 500 } },
        { event: 'text_delta', data: { seq: 4, t: 900, text: 'Le contrat est prêt.' } },
        { event: 'done', data: { seq: 5, t: 950, stop_reason: 'end_turn' } }
      ];
    } else {
      // Scénario par défaut : création d'un contrat.
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'phase', data: { seq: 2, t: 80, phase: 'researching', label: 'Je consulte le modèle de bail' } },
        { event: 'plan', data: { seq: 3, t: 120, steps: [{ id: 's1', label: 'Identifier les parties' }, { id: 's2', label: 'Choisir les clauses' }, { id: 's3', label: 'Rédiger' }, { id: 's4', label: 'Vérifier' }] } },
        { event: 'step', data: { seq: 4, t: 150, id: 's1', state: 'done' } },
        { event: 'step', data: { seq: 5, t: 160, id: 's2', state: 'done' } },
        { event: 'step', data: { seq: 6, t: 170, id: 's3', state: 'running' } },
        { event: 'tool_start', data: { seq: 7, t: 200, id: 't1', name: 'get_template', label: 'Je consulte le modèle de contrat' } },
        { event: 'tool_end', data: { seq: 8, t: 600, id: 't1', ok: true, duration_ms: 400, result_summary: 'Modèle « Bail d\'habitation »' } },
        { event: 'canvas_start', data: { seq: 9, t: 700, mode: 'create', title: 'Contrat de bail' } },
        { event: 'canvas_delta', data: { seq: 10, t: 760, text: '# Contrat de bail à usage d\'habitation\n\n' } },
        { event: 'canvas_delta', data: { seq: 11, t: 820, text: 'Entre les soussignés :\n\n' } },
        { event: 'canvas_set', data: { seq: 12, t: 900, mode: 'create', markdown: MOCK_CONTRACT, version: 1, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 5, issues: [{ code: 'missing_article', severity: 'warning', message: 'Article « Charges » absent.' }], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }], optional: [] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'text_delta', data: { seq: 13, t: 1000, text: 'Le bail est prêt. Il reste 5 champs à compléter.' } },
        { event: 'done', data: { seq: 14, t: 1050, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } }
      ];
    }

    try {
      await readSse(mockStream(events), function (event, data) {
        agent.lastByteAt = Date.now();
        handleEvent(event, data, message, bubble);
      });
    } catch (e) {
      finishWithError(message, { code: 'network', message: 'Connexion interrompue. Réessayez.', retryable: true });
      return;
    }
    finalize(message, bubble, c);
  }

  /* ---------------------------------------------------------------- */
  /* Rendu de la feuille                                                 */
  /* ---------------------------------------------------------------- */

  /** Rendu complet d'un document Markdown (spécification v2 §5.8). */
  function renderPaper(fresh) {
    var paper = $('paper');
    if (!paper) return;
    paper.innerHTML = '';
    if (fresh) { paper.classList.remove('fresh'); void paper.offsetWidth; paper.classList.add('fresh'); }

    if (!doc) {
      paper.appendChild(el('div', 'empty', 'Votre contrat apparaîtra ici.'));
      $('ttl').textContent = 'Nouveau contrat';
      $('dlWord').disabled = $('dlPdf').disabled = true;
      updateDocMeta(null);
      return;
    }

    var title = el('h1');
    title.textContent = doc.title || 'Contrat';
    paper.appendChild(title);

    (doc.blocks || []).forEach(function (block) {
      if (!block || !block.x) return;
      var node = el(block.t === 'h' ? 'h2' : 'p');
      renderInline(node, block.x);
      paper.appendChild(node);
    });

    $('ttl').textContent = doc.title;
    $('dlWord').disabled = $('dlPdf').disabled = false;
    updateDocMeta(doc);
  }

  /** Compteur de champs à compléter et points d'attention. */
  function updateDocMeta(document) {
    var meta = $('docMeta');
    var details = $('issues');
    var list = $('issuesList');
    var summary = $('issuesSum');
    if (!meta || !details || !list || !summary) return;

    var markdown = document && document.markdown ? document.markdown : '';
    var count = (markdown.match(/\[À COMPLÉTER[^\]]*\]/g) || []).length;
    var version = document && document.version ? 'v' + document.version : '';
    meta.textContent = [version, count ? count + ' champ' + (count > 1 ? 's' : '') + ' à compléter' : ''].filter(Boolean).join(' · ');

    var issues = (document && document.issues) || [];
    list.innerHTML = '';
    issues.forEach(function (issue) {
      var item = el('li', 'issue-' + (issue.severity || 'info'));
      item.appendChild(el('span', 'sev', issue.severity || 'info'));
      item.appendChild(el('span', '', issue.message || ''));
      list.appendChild(item);
    });
    details.hidden = issues.length === 0;
    summary.textContent = issues.length ? 'Points d’attention (' + issues.length + ')' : 'Points d’attention';
  }

  /* ---------------------------------------------------------------- */
  /* Exports                                                            */
  /* ---------------------------------------------------------------- */

  function download(filename, blob) {
    var a = el('a');
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
      var res = await fetch(CONFIG.API_BASE + '/api/export/docx', {
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
      download(match ? match[1] : 'contrat.docx', await res.blob());
    } catch (e) {
      toast('L’export Word a échoué.');
    }
  }

  function exportPdf() {
    if (!doc) return;
    window.print();
  }

  /* ---------------------------------------------------------------- */
  /* Types de contrat disponibles                                        */
  /* ---------------------------------------------------------------- */

  async function loadTemplates() {
    var list;
    try {
      var res = await fetch(CONFIG.API_BASE + '/api/templates', { headers: headers() });
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
      var button = el('button', 'chip', template.label);
      button.onclick = function () {
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
    installStyles();

    // Rendu et relecture : le prototype fournissait ses propres versions,
    // remplacées ici par le rendu Markdown (spécification v2 §5.8).
    window.render = renderPaper;
    window.readDoc = function () {
      if (!doc) return;
      var paper = $('paper');
      if (!paper) return;
      var titleNode = paper.querySelector('h1');
      var blocks = [];
      Array.prototype.forEach.call(paper.children, function (node) {
        if (node === titleNode) return;
        if (node.tagName !== 'H2' && node.tagName !== 'P') return;
        var text = (node.innerText || '').trim();
        if (!text) return;
        var previous = (doc.blocks || [])[blocks.length];
        var block = { t: node.tagName === 'H2' ? 'h' : 'p', x: text };
        if (previous && previous.md && plainOf(previous.md) === text) block.md = previous.md;
        blocks.push(block);
      });
      doc.blocks = blocks;
      if (titleNode) doc.title = (titleNode.innerText || doc.title).trim();
    };
    if (CONFIG.MOCK) installMockBanner();

    window.use = async function () { return null; };
    window.send = send;

    var word = $('dlWord');
    if (word) word.onclick = exportWord;
    var pdf = $('dlPdf');
    if (pdf) pdf.onclick = exportPdf;

    if (!CONFIG.MOCK) loadTemplates();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
