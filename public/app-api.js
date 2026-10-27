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
    MOCK: new URLSearchParams(location.search).get('mock') === '1',
    STORAGE_KEY: 'altredige:convs',
    MAX_MESSAGES: 30,
    THINKING_SHOW_MS: 400,
    STALL_MS: 20000,
    TIMEOUT_MS: 90000,
    TOAST_MS: 4000,
    QUESTION_MAX_FIELDS: 6
  };

  var session = {
    user: null,
    history: [],
    historyEnabled: true,
    historyLoading: false,
    saveTimer: null,
    saving: false,
    saveAgain: false,
    storageWarningShown: false
  };

  var ui = {
    suggestions: [],
    mobileView: 'chat'
  };

  var PLACEHOLDER_RE = /\[À COMPLÉTER[^\]]*\]/g;
  var manualVersionTimer = null;
  var manualEditPending = false;

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
    var composerState = $('composerState');
    if (composerState) {
      composerState.textContent = STATE_LABELS[state] || '';
      composerState.hidden = state === 'idle';
    }
    if (state !== 'idle') hideSuggestions();
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

  /**
   * Parse the restricted Markdown source into editable blocks.
   *
   * A blank line is not the only separator: tables and lists are made of
   * consecutive lines. The previous implementation split on blank lines and
   * joined every remaining line with a space, which destroyed line breaks,
   * flattened lists and turned GFM tables into paragraphs.
   */
  function markdownToDoc(markdown) {
    var title = 'Contrat';
    var blocks = [];
    var lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    var index = 0;

    function isBlank(line) { return !String(line || '').trim(); }
    function isHeading(line) { return /^(#{1,6})\s+/.test(String(line || '').trim()); }
    function isTable(line) { return /^\s*\|/.test(String(line || '')); }
    function isList(line) { return /^\s*(?:[-*+]|\d+[.)])\s+/.test(String(line || '')); }
    function isRule(line) { return /^\s*---+\s*$/.test(String(line || '')); }
    function isPageBreak(line) { return /^\s*<!--\s*pagebreak\s*-->\s*$/i.test(String(line || '')); }
    function startsBlock(line) {
      return isHeading(line) || isTable(line) || isList(line) || isRule(line)
        || isPageBreak(line) || /^\s*>/.test(String(line || ''));
    }

    while (index < lines.length) {
      var line = lines[index];
      if (isBlank(line)) { index += 1; continue; }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
      if (heading) {
        var level = heading[1].length;
        var headingText = heading[2].trim();
        if (level === 1) title = headingText;
        else blocks.push({ t: 'h', level: Math.min(level, 3), x: headingText, md: line.trim() });
        index += 1;
        continue;
      }

      if (isPageBreak(line)) {
        blocks.push({ t: 'pagebreak', x: '', md: '<!-- pagebreak -->' });
        index += 1;
        continue;
      }

      if (isRule(line)) {
        blocks.push({ t: 'hr', x: '', md: '---' });
        index += 1;
        continue;
      }

      if (isTable(line)) {
        var tableLines = [];
        while (index < lines.length && isTable(lines[index])) {
          tableLines.push(lines[index]);
          index += 1;
        }
        var table = parseTableBlock(tableLines);
        if (table) blocks.push(table);
        else blocks.push({ t: 'p', x: tableLines.join('\n'), md: tableLines.join('\n') });
        continue;
      }

      if (isList(line)) {
        var listLines = [];
        while (index < lines.length) {
          if (isBlank(lines[index])) break;
          if (isList(lines[index]) || /^\s+/.test(lines[index])) {
            listLines.push(lines[index]);
            index += 1;
            continue;
          }
          break;
        }
        blocks.push(parseListBlock(listLines));
        continue;
      }

      // Paragraph: soft line breaks are kept as `\n`, so the editor can show
      // the line structure the model actually produced.
      var paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      var paragraphText = paragraph.join('\n');
      blocks.push({ t: 'p', x: paragraphText, md: paragraphText });
    }

    return { title: title, blocks: blocks };
  }

  function splitTableRow(line) {
    var value = String(line || '').trim();
    if (value.charAt(0) === '|') value = value.slice(1);
    if (value.charAt(value.length - 1) === '|') value = value.slice(0, -1);
    var cells = [];
    var current = '';
    for (var i = 0; i < value.length; i += 1) {
      var char = value.charAt(i);
      if (char === '|' && value.charAt(i - 1) !== '\\') {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableSeparator(line) {
    var cells = splitTableRow(line);
    return cells.length > 0 && cells.every(function (cell) {
      return /^:?-{3,}:?$/.test(cell.trim());
    });
  }

  function parseTableBlock(tableLines) {
    if (tableLines.length < 2 || !isTableSeparator(tableLines[1])) return null;
    var rows = tableLines.map(splitTableRow);
    var header = rows[0];
    var body = rows.slice(2);
    var width = header.length;
    var normalized = [header].concat(body).map(function (row) {
      var copy = row.slice(0, width);
      while (copy.length < width) copy.push('');
      return copy;
    });
    return {
      t: 'table',
      header: true,
      rows: normalized,
      x: '',
      md: tableLines.join('\n')
    };
  }

  function parseListBlock(listLines) {
    var items = [];
    var ordered = false;
    var start = 1;
    for (var i = 0; i < listLines.length; i += 1) {
      var match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(listLines[i]);
      if (match) {
        if (i === 0) {
          ordered = /\d/.test(match[2]);
          if (ordered) start = Number(match[2].replace(/[.)]$/, '')) || 1;
        }
        items.push({
          x: match[3].trim(),
          d: match[1].length >= 2 ? 1 : 0
        });
      } else if (items.length) {
        items[items.length - 1].x += '\n' + listLines[i].trim();
      }
    }
    return {
      t: ordered ? 'ol' : 'ul',
      ordered: ordered,
      start: start,
      items: items,
      x: '',
      md: listLines.join('\n')
    };
  }

  function normalizeBlockText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  /** Texte nu d'un fragment Markdown (gras, italique, marqueurs). */
  function plainOf(markdown) {
    return String(markdown)
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
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

  function escapeTableCell(value) {
    return String(value || '').replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ');
  }

  function tableToMarkdown(rows) {
    var normalized = (rows || []).filter(function (row) { return Array.isArray(row); });
    if (!normalized.length) return '';
    var width = normalized[0].length;
    var lines = normalized.map(function (row) {
      var cells = row.slice(0, width);
      while (cells.length < width) cells.push('');
      return '| ' + cells.map(escapeTableCell).join(' | ') + ' |';
    });
    lines.splice(1, 0, '| ' + normalized[0].map(function () { return '---'; }).join(' | ') + ' |');
    return lines.join('\n');
  }

  function listToMarkdown(block) {
    var items = block.items || [];
    return items.map(function (item, index) {
      var prefix = block.t === 'ol' ? (Number(block.start || 1) + index) + '. ' : '- ';
      var text = String(item.x || '');
      var indent = item.d ? '  ' : '';
      return indent + prefix + text.split('\n').join('\n' + indent + '  ');
    }).join('\n');
  }

  function docToMarkdown(doc) {
    if (!doc) return '';
    var out = ['# ' + (doc.title || 'Contrat')];
    (doc.blocks || []).forEach(function (b) {
      if (!b) return;
      if (b.t === 'h') {
        if (b.md && plainOf(b.md) === normalizeBlockText(b.x)) out.push(b.md);
        else out.push((b.level === 3 ? '### ' : '## ') + b.x);
        return;
      }
      if (b.t === 'table') {
        var table = tableToMarkdown(b.rows);
        if (table) out.push(table);
        return;
      }
      if (b.t === 'ul' || b.t === 'ol') {
        var list = listToMarkdown(b);
        if (list) out.push(list);
        return;
      }
      if (b.t === 'hr') { out.push('---'); return; }
      if (b.t === 'pagebreak') { out.push('<!-- pagebreak -->'); return; }
      var text = String(b.x || '');
      if (!text.trim()) return;
      // Le fragment d'origine est réutilisé tant que le texte n'a pas été modifié.
      if (b.md && plainOf(b.md) === normalizeBlockText(text)) out.push(b.md);
      else out.push(text);
    });
    return out.join('\n\n');
  }

  /* ---------------------------------------------------------------- */
  /* Authentication (Firebase Auth, Google sign-in)                     */
  /* ---------------------------------------------------------------- */

  function firebaseAuth() {
    return window.firebase && window.auth ? window.auth : null;
  }

  function prepareGoogleProvider() {
    if (!window.firebase || !window.firebase.auth || !window.firebase.auth.GoogleAuthProvider) return;
    // The delivered page forces the Google account chooser on every sign-in.
    // Rebuild the provider without that hint so Google can reuse the active
    // account; the Firebase session itself is restored automatically later.
    window.provider = new window.firebase.auth.GoogleAuthProvider();
  }

  function enableLocalPersistence(auth) {
    try {
      if (!auth || typeof auth.setPersistence !== 'function') return Promise.resolve();
      // Keep the Firebase session in IndexedDB/localStorage so a reload or a
      // browser restart resumes the same account without a new Google popup.
      return auth.setPersistence('local').catch(function () {
        // Private browsing or blocked storage can refuse persistence; the SDK
        // keeps its current mode and the sign-in flow still works.
      });
    } catch (e) {
      return Promise.resolve();
    }
  }

  function currentFirebaseUser() {
    var auth = firebaseAuth();
    return auth ? auth.currentUser : null;
  }

  async function idToken(forceRefresh) {
    var fbUser = currentFirebaseUser();
    if (!fbUser) return null;
    try { return await fbUser.getIdToken(!!forceRefresh); } catch (e) { return null; }
  }

  async function authHeaders(extra) {
    var head = { 'Content-Type': 'application/json' };
    var token = await idToken(false);
    if (token) head.Authorization = 'Bearer ' + token;
    if (extra) Object.keys(extra).forEach(function (k) { head[k] = extra[k]; });
    return head;
  }

  function authErrorMessage(error) {
    var code = error && error.code ? String(error.code) : '';
    if (code.indexOf('popup-closed-by-user') !== -1 || code.indexOf('cancelled-popup-request') !== -1) return '';
    if (code.indexOf('popup-blocked') !== -1) {
      return 'Le navigateur a bloqué la fenêtre Google. Autorisez les fenêtres puis réessayez.';
    }
    if (code.indexOf('unauthorized-domain') !== -1) {
      return 'Ce domaine n’est pas autorisé dans la console Firebase.';
    }
    if (code.indexOf('operation-not-allowed') !== -1) {
      return 'La connexion Google n’est pas activée dans la console Firebase.';
    }
    if (code.indexOf('network-request-failed') !== -1) {
      return 'Connexion impossible. Vérifiez votre réseau.';
    }
    if (code.indexOf('account-exists-with-different-credential') !== -1) {
      return 'Un compte existe déjà avec cette adresse et une autre méthode de connexion.';
    }
    return 'La connexion Google a échoué. Réessayez.';
  }

  function startGoogleSignIn() {
    var auth = firebaseAuth();
    if (!auth || !window.provider) {
      toast(window.firebaseInitError
        ? 'La connexion Google n’a pas pu être initialisée. Rechargez la page.'
        : 'La connexion Google est indisponible. Rechargez la page.');
      return;
    }
    var button = $('gbtn');
    if (button) button.disabled = true;
    try {
      auth.signInWithPopup(window.provider)
        .catch(function (error) {
          var text = authErrorMessage(error);
          if (text) toast(text);
        })
        .then(function () { if (button) button.disabled = false; });
    } catch (error) {
      if (button) button.disabled = false;
      var text = authErrorMessage(error);
      if (text) toast(text);
    }
  }
  window.startGoogleSignIn = startGoogleSignIn;

  function resetSession() {
    clearTimeout(session.saveTimer);
    session.user = null;
    session.history = [];
    session.historyEnabled = true;
    session.historyLoading = false;
    session.saving = false;
    session.saveAgain = false;
    session.storageWarningShown = false;
    user = null;
    convs = [];
    cur = null;
    doc = null;
    var messages = $('msgs');
    if (messages) messages.innerHTML = '';
    render();
    renderHist();
    if ($('dlWord')) $('dlWord').disabled = true;
    if ($('dlPdf')) $('dlPdf').disabled = true;
    if ($('ttl')) $('ttl').textContent = 'Nouveau contrat';
    if ($('shell')) $('shell').hidden = true;
    if ($('login')) $('login').hidden = false;
    if ($('set')) $('set').hidden = true;
    if ($('menu')) $('menu').hidden = true;
  }

  function enterApp(fbUser) {
    session.user = fbUser;
    var name = fbUser.displayName
      || (fbUser.email ? fbUser.email.split('@')[0] : 'Utilisateur');
    var email = fbUser.email || '';
    user = { name: name, email: email };
    var initial = String(name).trim().charAt(0).toUpperCase() || '?';
    if ($('av')) $('av').textContent = initial;
    if ($('av2')) $('av2').textContent = initial;
    if ($('nm')) $('nm').textContent = name;
    if ($('un')) $('un').textContent = name;
    if ($('ue')) $('ue').textContent = email;
    if ($('login')) $('login').hidden = true;
    if ($('shell')) $('shell').hidden = false;
    newConv();
  }
  window.enter = function () {
    var fbUser = currentFirebaseUser();
    if (fbUser) enterApp(fbUser);
  };

  function exitMock() {
    var url = new URL(location.href);
    url.searchParams.delete('mock');
    // `replace` évite que le bouton Retour ramène l'utilisateur dans la démo.
    location.replace(url.pathname + url.search + url.hash);
  }
  window.exitMock = exitMock;

  function signOutUser() {
    if (CONFIG.MOCK) {
      exitMock();
      return;
    }
    var auth = firebaseAuth();
    if (auth) auth.signOut().catch(function () { /* local state is cleared below */ });
    resetSession();
  }
  window.signOutUser = signOutUser;

  function initAuth() {
    if (CONFIG.MOCK) {
      enterApp({
        displayName: 'Mode démonstration',
        email: 'demo@local',
        getIdToken: async function () { return 'mock'; }
      });
      return;
    }

    var button = $('gbtn');
    if (button) button.onclick = startGoogleSignIn;
    var menuOut = $('mout');
    var settingsOut = $('out2');
    if (menuOut) menuOut.onclick = signOutUser;
    if (settingsOut) settingsOut.onclick = signOutUser;

    var auth = firebaseAuth();
    if (!auth) {
      if (button) {
        button.onclick = function () {
          toast('La connexion Google est indisponible. Rechargez la page.');
        };
      }
      return;
    }
    prepareGoogleProvider();
    enableLocalPersistence(auth).then(function () {
      auth.onAuthStateChanged(function (fbUser) {
        if (fbUser) {
          enterApp(fbUser);
          loadTemplates();
          loadServerHistory();
        } else {
          resetSession();
        }
      });
    });
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
  /* Server-side histories (Firestore through /api/history)             */
  /* ---------------------------------------------------------------- */

  var nativeOpenConv = typeof window.openConv === 'function' ? window.openConv : null;

  function historyNote(text) {
    var note = document.createElement('div');
    note.className = 'none';
    note.textContent = text;
    return note;
  }

  function renderHist() {
    var host = $('hist');
    if (!host) return;
    host.innerHTML = '';
    if (session.historyLoading) {
      host.appendChild(historyNote('Chargement…'));
      return;
    }
    var items = session.historyEnabled && !CONFIG.MOCK
      ? session.history
      : (convs || []).map(function (c) {
        return { id: c.id, title: c.title, local: true };
      });
    if (!items || !items.length) {
      host.appendChild(historyNote('Aucun contrat pour l’instant'));
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'hi' + (String(item.id) === String(cur) ? ' on' : '');
      row.setAttribute('role', 'listitem');

      var open = document.createElement('button');
      open.textContent = item.title || 'Contrat';
      if (item.updated_at) {
        open.title = 'Modifié le ' + new Date(item.updated_at).toLocaleString('fr-FR');
      }
      open.onclick = function () { openConversation(item.id); };
      if (String(item.id) === String(cur)) open.setAttribute('aria-current', 'true');

      var remove = document.createElement('button');
      remove.className = 'del';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Supprimer ' + (item.title || 'ce contrat'));
      remove.onclick = function (event) {
        event.stopPropagation();
        if (item.local) {
          convs = (convs || []).filter(function (c) { return String(c.id) !== String(item.id); });
          if (String(cur) === String(item.id)) newConv(); else renderHist();
          return;
        }
        void deleteServerConversation(item.id, item.title || 'ce contrat');
      };

      row.appendChild(open);
      row.appendChild(remove);
      host.appendChild(row);
    });
  }
  window.renderHist = renderHist;

  function openConversation(id) {
    var known = session.historyEnabled && !CONFIG.MOCK
      ? (session.history || []).filter(function (x) { return String(x.id) === String(id); })[0]
      : null;
    if (!known) {
      if (nativeOpenConv) nativeOpenConv(id);
      return;
    }
    void openServerConversation(id);
  }
  window.openConv = openConversation;

  function newConv() {
    cur = null;
    doc = null;
    manualEditPending = false;
    showSuggestions([]);
    closeVersionPanel();
    var messages = $('msgs');
    if (messages) messages.innerHTML = '';
    render();
    if ($('dlWord')) $('dlWord').disabled = true;
    if ($('dlPdf')) $('dlPdf').disabled = true;
    if ($('ttl')) $('ttl').textContent = 'Nouveau contrat';
    updateLegalNotice(false);
    syncHistoryButtons();
    view('home');
    renderHist();
    closeSide();
    if ($('hin')) $('hin').focus();
  }
  window.newConv = newConv;

  /**
   * Authenticated fetch for /api/history. Refreshes the ID token once on 401
   * (contract §8.7), then signs out if the session is still rejected.
   */
  async function fetchHistory(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: await authHeaders(opts.headers || {}),
      body: opts.body
    };
    var response;
    try { response = await fetch(CONFIG.API_BASE + path, init); } catch (e) { return null; }

    if (response.status === 401) {
      var token = await idToken(true);
      if (token) {
        init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + token });
        try { response = await fetch(CONFIG.API_BASE + path, init); } catch (e) { return null; }
      }
    }
    if (response.status === 401) {
      toast('Votre session a expiré. Reconnectez-vous.');
      signOutUser();
    }
    return response;
  }

  async function loadServerHistory() {
    if (!session.user) return;
    session.historyLoading = true;
    renderHist();
    var response = await fetchHistory('/api/history');
    session.historyLoading = false;
    if (!response) { renderHist(); return; }
    if (response.status === 404) {
      session.historyEnabled = false;
      renderHist();
      return;
    }
    if (!response.ok) { renderHist(); return; }
    try {
      var payload = await response.json();
      session.history = Array.isArray(payload.items) ? payload.items : [];
      session.historyEnabled = true;
    } catch (e) { /* keep the current list */ }
    renderHist();
  }

  function applyServerConversation(data) {
    var parsed = markdownToDoc(data.markdown || '');
    parsed.title = data.title || parsed.title || 'Contrat';
    parsed.version = data.version || 1;
    parsed.contractType = data.contract_type || null;
    parsed.markdown = data.markdown || '';
    parsed.placeholders = 0;
    parsed.issues = [];

    cur = data.id;
    doc = parsed;
    convs = (convs || []).filter(function (c) { return String(c.id) !== String(data.id); });
    var conversation = {
      id: data.id,
      title: parsed.title,
      doc: parsed,
      versions: [],
      msgs: (data.messages || []).map(function (m) {
        return { id: uid(), role: m.role, content: m.content, status: 'done' };
      })
    };
    convs.unshift(conversation);
    pushVersion(conversation, parsed.markdown, {
      version: parsed.version,
      title: parsed.title,
      source: 'server',
      label: 'Version enregistrée'
    });

    var messages = $('msgs');
    if (messages) messages.innerHTML = '';
    conversation.msgs.forEach(function (m) {
      msg(m.role === 'user' ? 'you' : 'ai', m.content, false);
      var last = messages && messages.lastElementChild;
      if (last && last.classList.contains('you')) last.setAttribute('title', 'Message enregistré');
    });
    if ($('ttl')) $('ttl').textContent = parsed.title;
    if ($('ttl')) $('ttl').title = parsed.title;
    if ($('dlWord')) $('dlWord').disabled = !parsed.markdown;
    if ($('dlPdf')) $('dlPdf').disabled = !parsed.markdown;
    showSuggestions([]);
    view('app');
    render(true);
    updateDocMeta(parsed);
    renderHist();
    closeSide();
    closeVersionPanel();
    if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) setMobileView('doc');
  }

  async function openServerConversation(id) {
    var response = await fetchHistory('/api/history/' + encodeURIComponent(id));
    if (!response) { toast('Impossible de charger ce contrat. Vérifiez votre réseau.'); return; }
    if (response.status === 404) {
      toast('Ce contrat n’existe plus.');
      session.history = session.history.filter(function (x) { return String(x.id) !== String(id); });
      renderHist();
      return;
    }
    if (!response.ok) { toast('Impossible de charger ce contrat. Réessayez.'); return; }
    var data;
    try { data = await response.json(); } catch (e) { toast('Impossible de charger ce contrat. Réessayez.'); return; }
    applyServerConversation(data);
  }

  async function deleteServerConversation(id, title) {
    if (!window.confirm('Supprimer « ' + title + ' » ? Cette action est définitive.')) return;
    var response = await fetchHistory('/api/history/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!response) { toast('La suppression a échoué. Vérifiez votre réseau.'); return; }
    if (response.status !== 204 && response.status !== 404) {
      toast('La suppression a échoué. Réessayez.');
      return;
    }
    session.history = (session.history || []).filter(function (x) { return String(x.id) !== String(id); });
    convs = (convs || []).filter(function (c) { return String(c.id) !== String(id); });
    if (String(cur) === String(id)) newConv(); else renderHist();
    toast('Contrat supprimé.');
  }

  function snapshotMessages(conversation) {
    var out = [];
    ((conversation && conversation.msgs) || []).forEach(function (m) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
      var content = String(m.content || '').trim();
      if (!content) return;
      content = content.slice(0, 8000);
      var last = out[out.length - 1];
      if (last && last.role === m.role) {
        last.content = (last.content + '\n' + content).slice(0, 8000);
        return;
      }
      out.push({ role: m.role, content: content });
    });
    return out.slice(-CONFIG.MAX_MESSAGES);
  }

  function conversationMarkdown(conversation) {
    if (conversation && String(cur) === String(conversation.id) && doc) return docToMarkdown(doc);
    if (conversation && conversation.doc) return docToMarkdown(conversation.doc);
    return '';
  }

  function upsertHistoryItem(item) {
    if (!item || !item.id) return;
    session.history = [item]
      .concat((session.history || []).filter(function (x) { return String(x.id) !== String(item.id); }))
      .sort(function (a, b) {
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      })
      .slice(0, 50);
    renderHist();
  }

  async function saveCurrentConversation() {
    if (CONFIG.MOCK || !session.user || !session.historyEnabled) return;
    var conversation = curConv();
    if (!conversation) return;

    var markdown = conversationMarkdown(conversation);
    var messages = snapshotMessages(conversation);
    if (!markdown && !messages.length) return;
    if (!conversation.id || String(conversation.id).length < 8) conversation.id = uid();
    if (!cur) cur = conversation.id;

    var title = String((conversation.doc && conversation.doc.title) || conversation.title || 'Contrat')
      .trim().slice(0, 200) || 'Contrat';
    var version = Number((conversation.doc && conversation.doc.version) || (doc && doc.version) || 1);
    var body = {
      title: title,
      contract_type: (conversation.doc && conversation.doc.contractType)
        || (doc && doc.contractType)
        || null,
      markdown: markdown,
      version: Math.max(1, Math.min(1000000, version || 1)),
      messages: messages
    };

    if (session.saving) { session.saveAgain = true; return; }
    session.saving = true;
    try {
      var response = await fetchHistory('/api/history/' + encodeURIComponent(conversation.id), {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      if (!response) return;
      if (response.status === 404) {
        session.historyEnabled = false;
        renderHist();
        return;
      }
      if (response.status === 503) {
        if (!session.storageWarningShown) {
          session.storageWarningShown = true;
          toast('Vos contrats seront enregistrés dès que le stockage sera disponible.');
        }
        return;
      }
      if (response.status === 413) {
        toast('Le contrat est trop long pour être sauvegardé.');
        return;
      }
      if (!response.ok) return;
      var payload = null;
      try { payload = await response.json(); } catch (e) { /* no server timestamp */ }
      conversation.title = title;
      conversation.updated_at = payload && payload.updated_at ? payload.updated_at : new Date().toISOString();
      upsertHistoryItem({
        id: conversation.id,
        title: title,
        contract_type: body.contract_type,
        updated_at: conversation.updated_at
      });
    } finally {
      session.saving = false;
      if (session.saveAgain) {
        session.saveAgain = false;
        scheduleSave(250);
      }
    }
  }

  function scheduleSave(delay) {
    if (CONFIG.MOCK || !session.user || !session.historyEnabled) return;
    clearTimeout(session.saveTimer);
    session.saveTimer = setTimeout(function () {
      void saveCurrentConversation();
    }, typeof delay === 'number' ? delay : 900);
  }

  // Called by the prototype's persist() after a manual document edit.
  window.lexPersist = function () { scheduleSave(); };

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

      /* --- document : structure Markdown conservée --- */
      '#paper p,#paper li{white-space:pre-wrap}',
      '#paper ul,#paper ol{margin:0 0 12px;padding-left:24px}',
      '#paper li{margin:2px 0}',
      '#paper li.nested{margin-left:18px}',
      '#paper h3{font:700 14px/1.4 Georgia,serif;margin:18px 0 5px}',
      '#paper table{width:100%;border-collapse:collapse;margin:10px 0 16px;font:13.5px/1.55 Georgia,serif}',
      '#paper th,#paper td{border:1px solid #d8d2c9;padding:7px 9px;vertical-align:top;text-align:left;white-space:pre-wrap}',
      '#paper th{background:#f6f3ee;font-weight:700}',
      '#paper hr{border:0;border-top:1px solid var(--line);margin:18px 0}',
      '#paper .pagebreak{break-after:page;height:0}',
      '@media print{#paper table{page-break-inside:avoid}#paper th,#paper td{border-color:#999}}',

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

      /* --- P2 : activité et suggestions --- */
      '.activity-live{display:flex;align-items:center;gap:7px;color:var(--mut);font-size:12.5px;padding:2px 0 7px;min-height:20px;flex:0 0 auto}',
      '.activity-live .act-live-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.act-spin{width:9px;height:9px;border-radius:50%;background:currentColor;opacity:.45;animation:breathe 1.2s ease-in-out infinite;flex:none}',
      '#suggestionsDock{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding:0 14px 8px;background:transparent;flex:0 0 auto;scrollbar-width:none}',
      '#suggestionsDock::-webkit-scrollbar{display:none}',
      '#suggestionsDock[hidden]{display:none!important}',
      '#suggestionsDock .chip{font-size:12px;padding:5px 10px;min-height:32px;background:var(--panel);border-color:var(--line);white-space:nowrap;flex:0 0 auto}',
      '#suggestionsDock .chip:hover{border-color:var(--mut)}',
      '#composerState{display:none;color:var(--mut);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}',
      '.m-time{font-size:10.5px;color:var(--mut);margin-top:3px;text-align:right;opacity:.8}',

      /* --- P2 : barre de document sur une ligne --- */
      '.bar{flex-wrap:nowrap;overflow:hidden;min-width:0}',
      '.bar .ttl{flex:1 1 auto;min-width:0;margin-right:0}',
      '.bar .zm,.bar .btn,#issues,#docMeta{flex:0 0 auto}',
      '#issues summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:165px}',
      '#docMeta{max-width:185px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
      '#docMeta:empty{display:none}',
      '.bar .btn{white-space:nowrap}',

      /* --- P4 : historique, formulaire de champs --- */
      '.btn.icon{min-width:32px;padding:6px 8px;font-size:15px;line-height:1}',
      '.btn.hist{font-size:12.5px;padding:6px 9px}',
      '.btn.icon:disabled,.btn.hist:disabled{opacity:.35;cursor:default}',
      '.stage{position:relative}',
      '.historyPanel{position:absolute;top:52px;right:14px;z-index:24;width:min(370px,calc(100% - 20px));max-height:min(66vh,560px);display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 50px rgba(40,32,24,.18);overflow:hidden}',
      '.historyPanel[hidden]{display:none!important}',
      '.history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-bottom:1px solid var(--line);font-size:13px}',
      '.history-close{border:0;background:transparent;color:var(--mut);font-size:20px;line-height:1;padding:2px 5px;cursor:pointer}',
      '.history-list{overflow:auto;padding:4px 0}',
      '.version-row{display:flex;align-items:center;gap:10px;padding:9px 13px;border-bottom:1px solid var(--line)}',
      '.version-row:last-child{border-bottom:0}',
      '.version-row.current{background:rgba(120,100,70,.06)}',
      '.version-main{min-width:0;flex:1}',
      '.version-label{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.version-meta{font-size:11px;color:var(--mut);margin-top:2px}',
      '.version-current{font-size:11px;color:var(--mut);white-space:nowrap}',
      '.version-restore{font-size:11.5px;padding:5px 8px;white-space:nowrap}',
      '.fields-card{width:min(620px,100%);max-height:86vh;display:flex;flex-direction:column;text-align:left}',
      '.fields-card h2{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}',
      '.fields-x{border:0;background:transparent;color:var(--mut);font-size:22px;line-height:1;padding:2px 5px;cursor:pointer}',
      '.fields-intro{color:var(--mut);font-size:12.5px;margin:0 0 12px;line-height:1.5}',
      '.fields-form{overflow-y:auto;min-height:0;padding-right:2px}',
      '.fields-group{border:1px solid var(--line);border-radius:12px;padding:9px 12px 10px;margin:0 0 10px}',
      '.fields-group legend{font-size:11.5px;font-weight:600;color:var(--mut);padding:0 6px}',
      '.field-row{display:grid;gap:4px;margin:7px 0}',
      '.field-label{font-size:12px;color:var(--ink)}',
      '.field-input{font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);min-height:42px}',
      '.field-input:focus{outline:2px solid rgba(120,100,70,.28);outline-offset:1px}',
      '.fields-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:8px;position:sticky;bottom:0;background:var(--panel)}',

      /* --- P2 : navigation mobile Chat / Document --- */
      '#mobileTabs{display:none}',
      '@media (max-width:820px){',
      '  #app:not([hidden]){position:fixed;left:0;right:0;top:calc(46px + var(--mock-banner-h,0px) + env(safe-area-inset-top,0px));bottom:0;display:block!important;height:auto!important;grid-template-columns:none!important;grid-template-rows:none!important}',
      '  #app .chat,#app .stage{height:100%;min-height:0}',
      '  body.mobile-doc #app .chat{display:none!important}',
      '  body.mobile-doc #app .stage{display:flex!important}',
      '  body:not(.mobile-doc) #app .stage{display:none!important}',
      '  body:not(.mobile-doc) #app .chat{display:flex!important}',
      '  #mobileTabs{display:flex;position:fixed;left:0;right:0;top:calc(var(--mock-banner-h,0px) + env(safe-area-inset-top,0px));height:46px;z-index:31;background:var(--panel);border-bottom:1px solid var(--line);align-items:stretch}',
      '  #mobileTabs[hidden]{display:none!important}',
      '  #mobileTabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;font-size:13.5px;color:var(--mut);position:relative}',
      '  #mobileTabs button.on{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}',
      '  #mobileTabs .mtab-count{display:inline-block;min-width:17px;margin-left:5px;padding:0 5px;border-radius:999px;background:var(--chip);font-size:11px;line-height:17px;color:var(--ink)}',
      '  .chat{padding-top:0!important;border-right:0!important;border-bottom:0!important}',
      '  .brand{padding:11px 14px 3px!important;font-size:17px!important}',
      '  .msgs{padding:4px 14px 8px!important}',
      '  .chat .composer{margin:0 10px calc(10px + env(safe-area-inset-bottom,0px))!important}',
      '  #agentStatus{display:none!important}',
      '  #composerState{display:inline!important}',
      '  #suggestionsDock{padding:0 10px 7px!important}',
      '  .bar{padding:8px 10px!important;gap:6px!important}',
      '  .bar .hint,.bar .zm{display:none!important}',
      '  .bar .btn{padding:6px 9px!important;font-size:12.5px!important}',
      '  #docMeta{max-width:48px;font-size:0;white-space:nowrap}',
      '  #docMeta::before{content:attr(data-fields);font-size:12px;color:var(--ink)}',
      '  #docMeta[data-fields=""]{display:none!important}',
      '  #historyBtn{font-size:0;width:32px;padding:6px 0}',
      '  #historyBtn::before{content:"≡";font-size:15px}',
      '  #undoBtn{width:32px;padding:6px 0}',
      '  .historyPanel{position:fixed;top:calc(100px + env(safe-area-inset-top,0px));left:10px;right:10px;width:auto;max-height:58vh}',
      '  .fields-card{max-height:88vh;padding:16px!important}',
      '  .fields-actions .btn{flex:1}',
      '  #issues summary{font-size:0;max-width:34px}',
      '  #issues summary::before{content:"⚠";font-size:14px;line-height:1}',
      '  .desk{padding:14px 8px 36px!important}',
      '  .paper{width:100%;padding:24px 17px!important;font-size:14.5px!important}',
      '  #legalFixed{font-size:10.5px;padding:6px 10px!important}',
      '}',
      '@media (min-width:821px){body.has-mock-banner #shell{padding-top:var(--mock-banner-h,0px)}#mobileTabs{display:none!important}}',
      '#legalFixed{font-size:11px;color:var(--mut);padding:5px 20px;border-top:1px solid var(--line);background:var(--bg);text-align:center}',
      '#legalFixed[hidden]{display:none!important}',

      /* --- bandeau mode simulé --- */
      '#mockBanner{position:fixed;top:0;left:0;right:0;z-index:50;background:#b45309;color:#fff;font-size:12px;text-align:center;padding:3px 8px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}',
      '#mockBanner button{font:inherit;font-weight:600;background:#fff;color:#7c2d12;border:0;border-radius:5px;padding:2px 9px;cursor:pointer}',

      /* --- impression --- */
      '@media print{body *{visibility:hidden}#paper,#paper *{visibility:visible}#paper{position:absolute;left:0;top:0;width:100%;box-shadow:none;border:0}.side,.chat,.bar,.rz,.toast,.skip,#agentStatus,.activity{display:none!important}#shell,#content,#app,.desk,.stage{display:block!important;height:auto!important;overflow:visible!important}@page{size:A4;margin:2.5cm}#paper p{text-align:justify}#paper h2{break-after:avoid}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function installMockTools() {
    // Outil de contrôle manuel réservé au mode simulé : charge un Markdown
    // de référence pour vérifier le rendu des tableaux et des listes.
    window.__lexLoadMarkdown = function (markdown, title) {
      if (!markdown) return null;
      var parsed = markdownToDoc(markdown);
      parsed.title = title || parsed.title || 'Contrat';
      parsed.version = 1;
      parsed.markdown = String(markdown);
      parsed.contractType = null;
      parsed.placeholders = 0;
      parsed.issues = [];

      var conversation = curConv();
      if (!conversation) {
        cur = 'mock-' + uid();
        conversation = { id: cur, title: parsed.title, doc: parsed, versions: [], msgs: [] };
        convs.unshift(conversation);
      }
      doc = parsed;
      conversation.doc = parsed;
      conversation.title = parsed.title;
      conversation.versions = [];
      pushVersion(conversation, parsed.markdown, {
        version: 1,
        title: parsed.title,
        source: 'server',
        label: 'Version enregistrée'
      });
      if ($('ttl')) {
        $('ttl').textContent = parsed.title;
        $('ttl').title = parsed.title;
      }
      view('app');
      render(true);
      updateDocMeta(parsed);
      renderHist();
      closeSide();
      closeVersionPanel();
      return parsed.markdown.length;
    };
  }

  function installMockBanner() {
    if ($('mockBanner')) return;
    var banner = el('div');
    banner.id = 'mockBanner';
    banner.appendChild(document.createTextNode('MODE SIMULÉ — réponses de démonstration. '));
    var exit = el('button', '', 'Passer en mode réel');
    exit.type = 'button';
    exit.onclick = exitMock;
    banner.appendChild(exit);
    document.body.appendChild(banner);
    document.body.classList.add('has-mock-banner');

    var syncBannerHeight = function () {
      document.documentElement.style.setProperty('--mock-banner-h', banner.offsetHeight + 'px');
    };
    syncBannerHeight();
    window.addEventListener('resize', syncBannerHeight);
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncBannerHeight).observe(banner);
  }

  /* ---------------------------------------------------------------- */
  /* P4 — historique de versions et formulaire de champs                */
  /* ---------------------------------------------------------------- */

  function versionsOf(conversation) {
    if (!conversation) return [];
    if (!Array.isArray(conversation.versions)) conversation.versions = [];
    return conversation.versions;
  }

  function pushVersion(conversation, markdown, options) {
    if (!conversation || !markdown) return null;
    var opts = options || {};
    var list = versionsOf(conversation);
    var at = opts.at || new Date().toISOString();
    var version = Math.max(1, Number(opts.version) || 1);
    var title = String(opts.title || conversation.title || 'Contrat');
    var label = String(opts.label || 'Version');
    var source = String(opts.source || 'manual');

    if (list.length) {
      var last = list[list.length - 1];
      if (last.markdown === markdown) {
        last.at = at;
        last.version = Math.max(Number(last.version) || 1, version);
        last.title = title;
        return last;
      }
    }

    var snapshot = {
      id: uid(),
      at: at,
      version: version,
      markdown: markdown,
      title: title,
      source: source,
      label: label
    };
    list.push(snapshot);
    if (list.length > 30) list.splice(0, list.length - 30);
    return snapshot;
  }

  function versionSourceLabel(source) {
    var labels = {
      'assistant-create': 'Assistant',
      'assistant-edit': 'Assistant',
      'before-edit': 'Automatique',
      'before-undo': 'Automatique',
      'before-restore': 'Automatique',
      'manual': 'Manuelle',
      'server': 'Serveur',
      'restore': 'Restauration'
    };
    return labels[source] || 'Version';
  }

  function versionTime(value) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function maxVersion(conversation) {
    var versions = versionsOf(conversation);
    var max = Number(doc && doc.version) || 1;
    versions.forEach(function (version) {
      max = Math.max(max, Number(version.version) || 1);
    });
    return max;
  }

  function syncHistoryButtons() {
    var undo = $('undoBtn');
    var history = $('historyBtn');
    var available = Boolean(doc);
    if (undo) {
      undo.disabled = !available || versionsOf(curConv()).length < 2;
      undo.title = available
        ? 'Annuler la dernière modification'
        : 'Aucune version à annuler';
    }
    if (history) {
      history.disabled = !available;
      history.title = available ? 'Historique des versions' : 'Aucun document';
    }
  }

  function renderVersionPanel() {
    var panel = $('historyPanel');
    var list = $('historyList');
    if (!panel || !list || panel.hidden) return;
    list.innerHTML = '';
    var conversation = curConv();
    var versions = versionsOf(conversation);
    if (!versions.length) {
      list.appendChild(el('div', 'none', 'Aucune version enregistrée.'));
      return;
    }

    // Le dernier instantané est la version affichée : `endTurn` peut
    // resérialiser le Markdown (mêmes blocs, espaces différents).
    var currentId = versions[versions.length - 1].id;
    versions.slice().reverse().forEach(function (version) {
      var current = version.id === currentId;
      var row = el('div', 'version-row' + (current ? ' current' : ''));

      var main = el('div', 'version-main');
      main.appendChild(el('div', 'version-label', version.label || 'Version'));
      var meta = 'v' + (Number(version.version) || 1)
        + ' · ' + versionTime(version.at)
        + ' · ' + versionSourceLabel(version.source);
      main.appendChild(el('div', 'version-meta', meta));
      row.appendChild(main);

      if (current) {
        row.appendChild(el('span', 'version-current', 'Actuelle'));
      } else {
        var restore = el('button', 'btn version-restore', 'Restaurer');
        restore.type = 'button';
        restore.title = 'Restaurer cette version du document';
        restore.onclick = function () { restoreVersion(version.id); };
        row.appendChild(restore);
      }
      list.appendChild(row);
    });
  }

  function openVersionPanel() {
    var panel = $('historyPanel');
    if (!panel || !doc) return;
    if (!busy && manualEditPending) recordManualVersion();
    panel.hidden = false;
    renderVersionPanel();
    var history = $('historyBtn');
    if (history) history.setAttribute('aria-expanded', 'true');
  }

  function closeVersionPanel() {
    var panel = $('historyPanel');
    if (panel) panel.hidden = true;
    var history = $('historyBtn');
    if (history) history.setAttribute('aria-expanded', 'false');
  }

  function toggleVersionPanel() {
    var panel = $('historyPanel');
    if (!panel) return;
    if (panel.hidden) openVersionPanel(); else closeVersionPanel();
  }

  function applyVersionSnapshot(snapshot, recordCurrent) {
    var conversation = curConv();
    if (!conversation || !doc || !snapshot) return;
    if (recordCurrent && doc.markdown && doc.markdown !== snapshot.markdown) {
      pushVersion(conversation, doc.markdown, {
        version: doc.version,
        title: doc.title,
        source: 'before-restore',
        label: 'Avant restauration'
      });
    }

    manualEditPending = false;
    var nextVersion = maxVersion(conversation) + 1;
    var parsed = markdownToDoc(snapshot.markdown);
    parsed.version = nextVersion;
    parsed.contractType = doc.contractType || (conversation.doc && conversation.doc.contractType) || null;
    parsed.markdown = snapshot.markdown;
    parsed.placeholders = 0;
    parsed.issues = [];

    doc = parsed;
    conversation.doc = parsed;
    conversation.title = parsed.title || conversation.title;
    pushVersion(conversation, snapshot.markdown, {
      version: nextVersion,
      title: parsed.title,
      source: 'restore',
      label: 'Version restaurée (v' + snapshot.version + ')'
    });
    if ($('ttl')) $('ttl').textContent = parsed.title;
    if ($('ttl')) $('ttl').title = parsed.title;
    render(true);
    updateDocMeta(parsed);
    persist();
    renderHist();
    closeVersionPanel();
    showSuggestions([]);
    toast('Version restaurée.');
  }

  function restoreVersion(id) {
    readDoc();
    var conversation = curConv();
    var versions = versionsOf(conversation);
    var snapshot = versions.filter(function (version) {
      return String(version.id) === String(id);
    })[0];
    if (!snapshot) return;
    if (versions.length && versions[versions.length - 1].id === snapshot.id) {
      toast('Cette version est déjà affichée.');
      return;
    }
    applyVersionSnapshot(snapshot, true);
  }

  function undoLastVersion() {
    readDoc();
    var conversation = curConv();
    if (!doc || !conversation) return;
    var versions = versionsOf(conversation);
    var last = versions[versions.length - 1];
    if (!last || last.markdown !== doc.markdown) {
      pushVersion(conversation, doc.markdown, {
        version: doc.version,
        title: doc.title,
        source: 'before-undo',
        label: 'Avant annulation'
      });
      versions = versionsOf(conversation);
    }
    if (versions.length < 2) {
      toast('Aucune version antérieure.');
      return;
    }
    applyVersionSnapshot(versions[versions.length - 2], false);
  }

  function scheduleManualVersion() {
    manualEditPending = true;
    if (manualVersionTimer) clearTimeout(manualVersionTimer);
    manualVersionTimer = setTimeout(function () {
      manualVersionTimer = null;
      recordManualVersion();
    }, 1400);
  }

  function recordManualVersion() {
    if (!manualEditPending || busy || !doc) return;
    var conversation = curConv();
    if (!conversation || !conversation.doc) {
      manualEditPending = false;
      return;
    }
    var versions = versionsOf(conversation);
    var previous = versions.length
      ? (versions[versions.length - 1].markdown || '')
      : (conversation.doc.markdown || '');
    readDoc();
    if (!doc || !doc.markdown || doc.markdown === previous) {
      manualEditPending = false;
      return;
    }

    manualEditPending = false;
    doc.version = maxVersion(conversation) + 1;
    conversation.doc = doc;
    conversation.title = doc.title || conversation.title;
    pushVersion(conversation, doc.markdown, {
      version: doc.version,
      title: doc.title,
      source: 'manual',
      label: 'Modification manuelle'
    });
    updateDocMeta(doc);
    syncHistoryButtons();
    persist();
    if (!$('historyPanel').hidden) renderVersionPanel();
  }

  function installVersionHistory() {
    var bar = document.querySelector('.bar');
    var word = $('dlWord');
    if (bar && !$('undoBtn')) {
      var undo = el('button', 'btn icon', '↶');
      undo.id = 'undoBtn';
      undo.type = 'button';
      undo.setAttribute('aria-label', 'Annuler la dernière modification');
      undo.title = 'Annuler la dernière modification';
      undo.onclick = undoLastVersion;
      bar.insertBefore(undo, word || null);

      var history = el('button', 'btn hist', 'Historique');
      history.id = 'historyBtn';
      history.type = 'button';
      history.setAttribute('aria-expanded', 'false');
      history.setAttribute('aria-label', 'Historique des versions');
      history.title = 'Historique des versions';
      history.onclick = function (event) {
        event.stopPropagation();
        toggleVersionPanel();
      };
      bar.insertBefore(history, undo);
    }

    var stage = document.querySelector('.stage');
    var desk = document.querySelector('.desk');
    if (stage && !$('historyPanel')) {
      var panel = el('div', 'historyPanel');
      panel.id = 'historyPanel';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Historique des versions');
      var head = el('div', 'history-head');
      head.appendChild(el('strong', '', 'Historique des versions'));
      var close = el('button', 'history-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Fermer l’historique');
      close.onclick = closeVersionPanel;
      head.appendChild(close);
      panel.appendChild(head);
      var list = el('div', 'history-list');
      list.id = 'historyList';
      panel.appendChild(list);
      stage.insertBefore(panel, desk || null);
      panel.addEventListener('click', function (event) { event.stopPropagation(); });
      document.addEventListener('click', function (event) {
        if (panel.hidden) return;
        var button = $('historyBtn');
        if (button && (button === event.target || button.contains(event.target))) return;
        if (!panel.contains(event.target)) closeVersionPanel();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeVersionPanel();
      });
    }

    var paper = $('paper');
    if (paper) paper.addEventListener('input', scheduleManualVersion);
    syncHistoryButtons();
  }

  function analyzePlaceholders(markdown) {
    var items = [];
    var article = 'En-tête';
    String(markdown || '').split(/\r?\n/).forEach(function (line) {
      var heading = /^##\s+(.+)$/.exec(line.trim());
      if (heading) article = heading[1].trim();
      var re = new RegExp(PLACEHOLDER_RE.source, 'g');
      var match;
      while ((match = re.exec(line))) {
        var raw = match[0];
        var label = raw.replace(/^\[À COMPLÉTER\s*:?\s*/i, '').replace(/\]$/, '').trim();
        items.push({
          raw: raw,
          label: label || 'Champ à compléter',
          article: article
        });
      }
    });
    return items;
  }

  function escapeMarkdownValue(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/([*_\[\]`])/g, '\\$1')
      .replace(/\r?\n+/g, ' ')
      .trim();
  }

  function applyPlaceholderValues(markdown, values) {
    var index = 0;
    return String(markdown || '').replace(PLACEHOLDER_RE, function (raw) {
      var value = values[index];
      index += 1;
      return value && value.trim() ? escapeMarkdownValue(value) : raw;
    });
  }

  function closeFieldsForm() {
    var modal = $('fieldsModal');
    if (modal) modal.hidden = true;
  }

  function openFieldsForm() {
    if (!doc) {
      toast('Aucun document à compléter.');
      return;
    }
    readDoc();
    var source = (doc && doc.markdown) || '';
    var placeholders = analyzePlaceholders(source);
    if (!placeholders.length) {
      toast('Aucun champ à compléter.');
      return;
    }

    var modal = $('fieldsModal');
    if (!modal) {
      modal = el('div', 'modal');
      modal.id = 'fieldsModal';
      modal.hidden = true;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'fieldsTitle');
      document.body.appendChild(modal);
    }
    modal.innerHTML = '';

    var card = el('div', 'card fields-card');
    var heading = el('h2', '', 'Compléter les champs');
    heading.id = 'fieldsTitle';
    var close = el('button', 'fields-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Fermer');
    close.onclick = closeFieldsForm;
    heading.appendChild(close);
    card.appendChild(heading);
    card.appendChild(el('p', 'fields-intro', 'Renseignez les informations manquantes. Les valeurs remplacent les champs du document en une seule fois.'));

    var form = el('form', 'fields-form');
    var groups = [];
    var byArticle = {};
    placeholders.forEach(function (field, index) {
      if (!byArticle[field.article]) {
        byArticle[field.article] = [];
        groups.push(field.article);
      }
      field.index = index;
      byArticle[field.article].push(field);
    });

    groups.forEach(function (article) {
      var fieldset = el('fieldset', 'fields-group');
      fieldset.appendChild(el('legend', '', article));
      byArticle[article].forEach(function (field) {
        var label = el('label', 'field-row');
        label.appendChild(el('span', 'field-label', field.label));
        var input = el('input', 'field-input');
        input.type = 'text';
        input.name = 'field-' + field.index;
        input.setAttribute('data-field-index', String(field.index));
        input.placeholder = field.raw;
        input.autocomplete = 'off';
        label.appendChild(input);
        fieldset.appendChild(label);
      });
      form.appendChild(fieldset);
    });

    var actions = el('div', 'fields-actions');
    var cancel = el('button', 'btn', 'Annuler');
    cancel.type = 'button';
    cancel.onclick = closeFieldsForm;
    var save = el('button', 'btn main', 'Enregistrer');
    save.type = 'submit';
    actions.appendChild(cancel);
    actions.appendChild(save);
    form.appendChild(actions);
    card.appendChild(form);
    modal.appendChild(card);
    modal.hidden = false;

    form.onsubmit = function (event) {
      event.preventDefault();
      var values = [];
      Array.prototype.forEach.call(form.querySelectorAll('[data-field-index]'), function (input) {
        values[Number(input.getAttribute('data-field-index'))] = input.value;
      });
      if (!values.some(function (value) { return value && value.trim(); })) {
        toast('Renseignez au moins un champ.');
        return;
      }
      var updated = applyPlaceholderValues(source, values);
      if (updated === source) {
        closeFieldsForm();
        return;
      }

      manualEditPending = false;
      var conversation = curConv();
      var previousVersion = doc.version || 1;
      var parsed = markdownToDoc(updated);
      parsed.version = Math.max(maxVersion(conversation), previousVersion) + 1;
      parsed.contractType = doc.contractType || null;
      parsed.markdown = updated;
      parsed.placeholders = 0;
      parsed.issues = (doc.issues || []).slice();
      doc = parsed;
      if (conversation) {
        conversation.doc = parsed;
        conversation.title = parsed.title || conversation.title;
        pushVersion(conversation, updated, {
          version: parsed.version,
          title: parsed.title,
          source: 'manual',
          label: 'Champs complétés'
        });
      }
      if ($('ttl')) $('ttl').textContent = parsed.title;
      if ($('ttl')) $('ttl').title = parsed.title;
      render(true);
      updateDocMeta(parsed);
      persist();
      closeFieldsForm();
      showSuggestions([]);
      toast('Champs mis à jour.');
    };

    modal.onclick = function (event) {
      if (event.target === modal) closeFieldsForm();
    };
    var first = form.querySelector('input');
    if (first) first.focus();
  }
  window.openFieldsForm = openFieldsForm;

  function installFieldFormShortcuts() {
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeFieldsForm();
    });
  }

  /**
   * Une seule barre de suggestions, dans le flux, juste au-dessus du
   * composeur. L'ancienne rangée statique `#quick` est neutralisée.
   */
  function installChatDock() {
    var chat = document.querySelector('.chat');
    if (!chat) return;
    var quick = $('quick');
    if (quick) {
      quick.hidden = true;
      quick.innerHTML = '';
    }
    var composer = chat.querySelector('.composer');
    if (!composer) return;

    var dock = $('suggestionsDock');
    if (!dock) {
      dock = el('div');
      dock.id = 'suggestionsDock';
      dock.setAttribute('role', 'group');
      dock.setAttribute('aria-label', 'Suggestions');
      dock.hidden = true;
    }
    if (dock.parentNode !== chat) chat.insertBefore(dock, composer);

    var crow = composer.querySelector('.crow');
    if (crow && !$('composerState')) {
      var state = el('span', '', '');
      state.id = 'composerState';
      state.setAttribute('role', 'status');
      state.setAttribute('aria-live', 'polite');
      state.hidden = true;
      crow.insertBefore(state, crow.firstChild);
    }
    renderSuggestionDock();
  }

  function setMobileView(view) {
    ui.mobileView = view === 'doc' ? 'doc' : 'chat';
    document.body.classList.toggle('mobile-doc', ui.mobileView === 'doc');
    var tabs = $('mobileTabs');
    if (!tabs) return;
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (button) {
      var on = button.getAttribute('data-view') === ui.mobileView;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (ui.mobileView === 'doc') {
      var msgs = $('msgs');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
  }
  window.setMobileView = setMobileView;

  function setMobileDocCount(count) {
    var badge = $('mtabDocCount');
    if (!badge) return;
    badge.textContent = count > 0 ? String(count) : '';
    badge.hidden = !(count > 0);
  }

  function installMobileTabs() {
    if ($('mobileTabs')) return;
    var tabs = el('div');
    tabs.id = 'mobileTabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Vue mobile');
    [['chat', 'Chat'], ['doc', 'Document']].forEach(function (entry) {
      var button = el('button', '', entry[1]);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('data-view', entry[0]);
      if (entry[0] === 'doc') {
        var badge = el('span', 'mtab-count', '');
        badge.id = 'mtabDocCount';
        badge.hidden = true;
        button.appendChild(badge);
      }
      button.onclick = function () { setMobileView(entry[0]); };
      tabs.appendChild(button);
    });
    document.body.appendChild(tabs);

    var app = $('app');
    if (app) {
      var sync = function () { tabs.hidden = app.hidden; };
      sync();
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['hidden'] });
      }
    }
    setMobileView('chat');
  }

  /* ---------------------------------------------------------------- */
  /* Rendu : bloc d'activité                                            */
  /* ---------------------------------------------------------------- */

  function renderActivity(message) {
    var activity = message.activity;
    if (!activity) return null;

    var steps = activity.steps || [];
    var tools = activity.tools || [];
    var streaming = message.status === 'streaming';

    if (streaming) {
      // Pendant le travail : une seule ligne vivante. Les étapes détaillées
      // n'apparaissent qu'une fois le tour terminé.
      var running = steps.filter(function (step) { return step.state === 'running'; }).pop();
      var lastTool = tools[tools.length - 1];
      var activeTool = lastTool && !lastTool.done ? lastTool : null;
      var liveLabel = (activeTool && activeTool.label)
        || (running && running.label)
        || activity.phase
        || (lastTool && lastTool.label)
        || 'Je réfléchis…';
      var live = el('div', 'activity-live');
      live.setAttribute('role', 'status');
      live.appendChild(el('span', 'act-spin'));
      live.appendChild(el('span', 'act-live-label', liveLabel));
      return live;
    }

    var hasContent = steps.length || tools.length || activity.phase || activity.thinking;
    if (!hasContent) return null;

    var details = el('details', 'activity');
    details.open = false;
    var summary = el('summary');
    var count = steps.length || tools.length;
    var fallback = count
      ? count + ' étape' + (count > 1 ? 's' : '')
      : 'Activité';
    summary.appendChild(el('span', 'act-sum-label', activity.collapsedLabel || fallback));
    details.appendChild(summary);

    var body = el('div', 'act-body');

    if (activity.phase) {
      var phase = el('div', 'act-phase');
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

  function formatTime(value) {
    if (!value) return '';
    var date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function scrollMsgs(force) {
    var msgs = $('msgs');
    if (!msgs) return;
    var nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
    if (force || nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }

  /** Barre unique de suggestions, juste au-dessus du composeur. */
  function renderSuggestionDock() {
    var host = $('suggestionsDock');
    if (!host) return;
    host.innerHTML = '';
    var items = ui.suggestions || [];
    host.hidden = items.length === 0;
    items.forEach(function (suggestion) {
      var chip = el('button', 'chip', suggestion.label);
      chip.type = 'button';
      chip.title = suggestion.message || suggestion.label;
      chip.onclick = function () {
        if (/^compl[ée]ter/i.test(suggestion.label) && doc) {
          if (typeof window.openFieldsForm === 'function') {
            window.openFieldsForm();
            return;
          }
        }
        window.send(suggestion.message || suggestion.label);
      };
      host.appendChild(chip);
    });
  }

  function showSuggestions(items) {
    ui.suggestions = Array.isArray(items) ? items.slice(0, 3) : [];
    renderSuggestionDock();
  }

  function hideSuggestions() {
    var host = $('suggestionsDock');
    if (host) host.hidden = true;
  }

  /** The old per-message row is no longer rendered (single dynamic dock). */
  function renderSuggestions() {
    return null;
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

    var sources = renderSources(message);
    if (sources) bubble.appendChild(sources);

    // Le compteur de champs et l'avertissement juridique sont désormais des
    // éléments fixes de l'interface, pas des blocs répétés dans chaque bulle.
    if (message.at) bubble.appendChild(el('div', 'm-time', formatTime(message.at)));

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
    scrollMsgs(false);
  }

  /* ---------------------------------------------------------------- */
  /* Envoi                                                              */
  /* ---------------------------------------------------------------- */

  function errorText(code) {
    var messages = {
      bad_request: 'La demande n’a pas pu être traitée. Reformulez ou rechargez la page.',
      unauthorized: 'Votre session a expiré. Reconnectez-vous.',
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
    if (!c) {
      c = { id: uid(), title: text.slice(0, 40), doc: null, msgs: [] };
      convs.unshift(c);
      cur = c.id;
      upsertHistoryItem({ id: c.id, title: c.title, updated_at: new Date().toISOString() });
    }
    view('app'); renderHist();
    ['hin', 'cin'].forEach(function (i) { $(i).value = ''; $(i).style.height = 'auto'; });

    hideSuggestions();
    ui.suggestions = [];
    var sentAt = new Date().toISOString();
    var userMessage = { id: uid(), role: 'user', content: text, status: 'done', at: sentAt };
    c.msgs.push(userMessage);
    msg('you', text, true);
    var lastMsg = $('msgs').lastElementChild;
    if (lastMsg) {
      lastMsg.setAttribute('title', formatTime(sentAt));
      lastMsg.appendChild(el('div', 'm-time', formatTime(sentAt)));
    }

    var message = { id: uid(), role: 'assistant', content: '', status: 'streaming', at: sentAt, activity: { phase: null, steps: [], tools: [], thinking: null, ms: 0 }, question: null, sources: [], suggestions: [], error: null, retryText: text };
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
        headers: await authHeaders({ 'X-Request-Id': uid() }),
        body: JSON.stringify(body)
      });
    } catch (e) {
      finishWithError(message, { code: 'network', message: 'Connexion impossible. Vérifiez votre réseau.', retryable: true });
      return;
    }

    if (response.status === 401) {
      // Refresh the ID token once, then give up and sign out (contract §8.7).
      var refreshed = await idToken(true);
      if (refreshed) {
        try {
          response = await fetch(CONFIG.API_BASE + '/api/chat', {
            method: 'POST',
            headers: await authHeaders({ 'X-Request-Id': uid() }),
            body: JSON.stringify(body)
          });
        } catch (e) {
          finishWithError(message, { code: 'network', message: 'Connexion impossible. Vérifiez votre réseau.', retryable: true });
          return;
        }
      }
      if (response.status === 401) {
        finishWithError(message, { code: 'unauthorized', message: 'Votre session a expiré. Reconnectez-vous.', retryable: false });
        toast('Votre session a expiré. Reconnectez-vous.');
        signOutUser();
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
        message.activity.tools.push({ id: data.id, label: data.label || data.name, ok: true, done: false, ms: 0, startedAt: Date.now() });
        setState('working');
        refreshBubble(message);
        break;

      case 'tool_end':
        (message.activity.tools || []).forEach(function (tool) {
          if (tool.id === data.id) {
            tool.ok = data.ok !== false;
            tool.done = true;
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
        manualEditPending = false;
        var conversation = curConv();
        if (conversation && conversation.doc && conversation.doc.markdown
            && conversation.doc.markdown !== data.markdown) {
          pushVersion(conversation, conversation.doc.markdown, {
            version: conversation.doc.version,
            title: conversation.doc.title,
            source: 'before-edit',
            label: 'Avant modification'
          });
        }
        if (cur === conversation.id) { doc = parsed; render(true); }
        conversation.doc = parsed;
        conversation.title = parsed.title;
        pushVersion(conversation, data.markdown, {
          version: data.version,
          title: parsed.title,
          source: data.mode === 'create' ? 'assistant-create' : 'assistant-edit',
          label: data.mode === 'create' ? 'Création assistée' : 'Modification assistée'
        });
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
        // Stockées pour la fin du tour : la barre unique ne s'affiche pas
        // pendant que l'assistant travaille.
        message.suggestions = data.items || [];
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
    showSuggestions([]);
    endTurn();
  }

  function finalize(message, bubble, c) {
    clearWatchers();
    message.status = 'done';
    message.at = message.at || new Date().toISOString();
    message.activity.ms = Date.now() - agent.startedAt;
    var steps = message.activity.steps || [];
    // Un tour réussi ne laisse pas de puce « en cours » ou « à faire ».
    steps.forEach(function (step) {
      if (step.state === 'running' || step.state === 'pending') step.state = 'done';
    });
    (message.activity.tools || []).forEach(function (tool) { tool.done = true; });
    var count = steps.length || (message.activity.tools || []).length;
    message.activity.collapsedLabel = count + ' étape' + (count > 1 ? 's' : '')
      + ' · ' + Math.max(1, Math.round(message.activity.ms / 1000)) + ' s';
    setState(message.question ? 'awaiting_input' : 'idle');
    refreshBubble(message);
    persist();
    endTurn();
    if (message.question) showSuggestions([]);
    else showSuggestions(message.suggestions || []);
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
    '**Monsieur [À COMPLÉTER : nom du bailleur]**, demeurant à [À COMPLÉTER : adresse du bailleur], ci-après « le **Bailleur** »,',
    '',
    'et **Madame [À COMPLÉTER : nom de la locataire]**, demeurant à [À COMPLÉTER : adresse de la locataire], ci-après « la **Locataire** ».',
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
    '| Lu et approuvé | Lu et approuvé |',
    '| Signature : | Signature : |',
    '| Nom : | Nom : |'
  ].join('\n');

  async function mockTurn(text, message, bubble, c) {
    var lower = text.toLowerCase();
    var events;

    if (lower.indexOf('limite') !== -1) {
      var error = await fetch(CONFIG.API_BASE + '/api/chat', { method: 'POST', headers: await authHeaders(), body: '{}' });
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
        { event: 'tool_end', data: { seq: 14, t: 2600, id: 't2', ok: true, duration_ms: 700, result_summary: 'Contrat écrit, 6 champs à compléter' } },
        { event: 'canvas_start', data: { seq: 15, t: 2700, mode: 'create', title: 'Contrat de bail' } },
        { event: 'canvas_delta', data: { seq: 16, t: 2800, text: '# Contrat de bail à usage d\'habitation\n\n' } },
        { event: 'canvas_set', data: { seq: 17, t: 3000, mode: 'create', markdown: MOCK_CONTRACT, version: 1, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 6, issues: [], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }, { key: 'locataire', label: 'Identité du locataire', filled: false }, { key: 'loyer', label: 'Loyer mensuel', filled: true }], optional: [{ key: 'caution', label: 'Caution', filled: false }] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'sources', data: { seq: 18, t: 3100, items: [{ id: 's01', title: 'Code du travail de Côte d\'Ivoire', ref: 'S01', kind: 'law', url: null }] } },
        { event: 'suggestions', data: { seq: 19, t: 3200, items: [{ label: 'Compléter les champs', message: 'Aide-moi à compléter les champs restants du contrat.' }, { label: 'Ajouter les signatures', message: 'Ajoute un bloc de signatures avec les parties du contrat.' }, { label: 'Ajouter une pénalité', message: 'Ajoute une clause de pénalité de retard.' }] } },
        { event: 'text_delta', data: { seq: 20, t: 3300, text: 'Le bail est prêt. Il reste 6 champs à compléter.' } },
        { event: 'done', data: { seq: 21, t: 3400, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } }
      ];
    } else if (lower.indexOf('préavis') !== -1 || lower.indexOf('preavis') !== -1) {
      events = [
        { event: 'ready', data: { seq: 1, t: 0 } },
        { event: 'canvas_start', data: { seq: 2, t: 60, mode: 'edit', title: 'Contrat de bail', reason: 'Je modifie le préavis' } },
        { event: 'canvas_set', data: { seq: 3, t: 400, mode: 'edit', markdown: MOCK_CONTRACT.replace('12 mois', '3 mois'), version: 2, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 6, issues: [], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }, { key: 'locataire', label: 'Identité du locataire', filled: false }, { key: 'loyer', label: 'Loyer mensuel', filled: true }], optional: [{ key: 'caution', label: 'Caution', filled: false }] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'text_delta', data: { seq: 4, t: 500, text: 'Le préavis est passé à trois mois.' } },
        { event: 'suggestions', data: { seq: 5, t: 540, items: [{ label: 'Compléter les champs', message: 'Aide-moi à compléter les champs restants du contrat.' }, { label: 'Ajouter les signatures', message: 'Ajoute un bloc de signatures avec les parties du contrat.' }, { label: 'Ajouter la confidentialité', message: 'Ajoute une clause de confidentialité.' }] } },
        { event: 'done', data: { seq: 6, t: 550, stop_reason: 'end_turn' } }
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
        { event: 'canvas_set', data: { seq: 12, t: 900, mode: 'create', markdown: MOCK_CONTRACT, version: 1, title: 'Contrat de bail', contract_type: 'bail-habitation', validation: { placeholders: 6, issues: [{ code: 'missing_article', severity: 'warning', message: 'Article « Charges » absent.' }], fields: { required: [{ key: 'bailleur', label: 'Identité du bailleur', filled: false }], optional: [] } }, legal_notice: { required: true, text: 'Ce document doit être relu et validé par un professionnel du droit avant signature.' } } },
        { event: 'text_delta', data: { seq: 13, t: 1000, text: 'Le bail est prêt. Il reste 6 champs à compléter.' } },
        { event: 'suggestions', data: { seq: 14, t: 1040, items: [{ label: 'Compléter les champs', message: 'Aide-moi à compléter les champs restants du contrat.' }, { label: 'Ajouter les signatures', message: 'Ajoute un bloc de signatures avec les parties du contrat.' }, { label: 'Ajouter une pénalité', message: 'Ajoute une clause de pénalité de retard.' }] } },
        { event: 'done', data: { seq: 15, t: 1050, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } } }
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

  function renderTable(block, index) {
    var table = el('table');
    table.setAttribute('data-block-index', String(index));
    var rows = block.rows || [];
    if (!rows.length) return table;
    var thead = el('thead');
    var headRow = el('tr');
    rows[0].forEach(function (cell) {
      var th = el('th');
      renderInline(th, cell);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    rows.slice(1).forEach(function (row) {
      var tr = el('tr');
      var width = rows[0].length;
      for (var i = 0; i < width; i += 1) {
        var td = el('td');
        renderInline(td, row[i] || '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderList(block, index) {
    var list = el(block.t === 'ol' ? 'ol' : 'ul');
    list.setAttribute('data-block-index', String(index));
    if (block.t === 'ol' && Number(block.start || 1) !== 1) list.start = Number(block.start);
    (block.items || []).forEach(function (item) {
      var li = el('li');
      if (item.d) li.className = 'nested';
      renderInline(li, item.x || '');
      list.appendChild(li);
    });
    return list;
  }

  function renderBlock(block, index) {
    if (!block) return null;
    if (block.t === 'h') {
      var heading = el(block.level === 3 ? 'h3' : 'h2');
      heading.setAttribute('data-block-index', String(index));
      renderInline(heading, block.x || '');
      return heading;
    }
    if (block.t === 'table') return renderTable(block, index);
    if (block.t === 'ul' || block.t === 'ol') return renderList(block, index);
    if (block.t === 'hr') {
      var rule = el('hr');
      rule.setAttribute('data-block-index', String(index));
      return rule;
    }
    if (block.t === 'pagebreak') {
      var pagebreak = el('div', 'pagebreak');
      pagebreak.setAttribute('data-block-index', String(index));
      return pagebreak;
    }
    var paragraph = el('p');
    paragraph.setAttribute('data-block-index', String(index));
    renderInline(paragraph, block.x || '');
    return paragraph;
  }

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

    (doc.blocks || []).forEach(function (block, index) {
      var node = renderBlock(block, index);
      if (node) paper.appendChild(node);
    });

    $('ttl').textContent = doc.title;
    $('ttl').title = doc.title || '';
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
    meta.textContent = [version, count ? '⚠ ' + count + ' champ' + (count > 1 ? 's' : '') : ''].filter(Boolean).join(' · ');
    meta.setAttribute('data-fields', count ? '⚠ ' + count : '');
    meta.title = count
      ? count + ' champ' + (count > 1 ? 's' : '') + ' à compléter — cliquez pour les remplir'
      : (version ? 'Version ' + document.version : '');
    meta.setAttribute('role', count ? 'button' : '');
    meta.setAttribute('tabindex', count ? '0' : '-1');
    meta.onclick = count && typeof window.openFieldsForm === 'function'
      ? function () { window.openFieldsForm(); }
      : null;
    meta.onkeydown = count
      ? function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (typeof window.openFieldsForm === 'function') window.openFieldsForm();
        }
      }
      : null;

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
    summary.title = issues.length ? issues.map(function (issue) { return issue.message; }).join('\n') : '';

    setMobileDocCount(count);
    updateLegalNotice(Boolean(document));
    syncHistoryButtons();
    if ($('historyPanel') && !$('historyPanel').hidden) renderVersionPanel();
  }

  function installLegalNotice() {
    if ($('legalFixed')) return;
    var stage = document.querySelector('.stage');
    var desk = document.querySelector('.desk');
    if (!stage || !desk) return;
    var notice = el('div', '', 'Ce document doit être relu et validé par un professionnel du droit avant signature.');
    notice.id = 'legalFixed';
    notice.setAttribute('role', 'note');
    notice.hidden = true;
    stage.insertBefore(notice, desk);
  }

  function updateLegalNotice(visible) {
    var notice = $('legalFixed');
    if (!notice) return;
    notice.hidden = !visible;
    notice.textContent = 'Ce document doit être relu et validé par un professionnel du droit avant signature.';
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
        headers: await authHeaders(),
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
      var res = await fetch(CONFIG.API_BASE + '/api/templates', { headers: await authHeaders() });
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
      var previousBlocks = doc.blocks || [];
      var blocks = [];

      function textOf(node) {
        var text = node && (node.innerText !== undefined ? node.innerText : node.textContent);
        return String(text || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
      }

      function previousAt(node) {
        var raw = node.getAttribute('data-block-index');
        var index = raw === null ? -1 : Number(raw);
        return Number.isInteger(index) && index >= 0 ? previousBlocks[index] : null;
      }

      Array.prototype.forEach.call(paper.children, function (node) {
        if (node === titleNode) return;
        var previous = previousAt(node);

        if (node.tagName === 'H2' || node.tagName === 'H3') {
          var headingText = textOf(node);
          if (!headingText) return;
          var heading = { t: 'h', level: node.tagName === 'H3' ? 3 : 2, x: headingText };
          if (previous && previous.t === 'h' && previous.md
              && plainOf(previous.md) === normalizeBlockText(headingText)) {
            heading.md = previous.md;
          }
          blocks.push(heading);
          return;
        }

        if (node.tagName === 'TABLE') {
          var rows = [];
          Array.prototype.forEach.call(node.querySelectorAll('tr'), function (row) {
            var cells = [];
            Array.prototype.forEach.call(row.querySelectorAll('th,td'), function (cell) {
              cells.push(textOf(cell));
            });
            if (cells.length) rows.push(cells);
          });
          if (rows.length) {
            var width = rows[0].length;
            rows = rows.map(function (row) {
              var copy = row.slice(0, width);
              while (copy.length < width) copy.push('');
              return copy;
            });
            blocks.push({ t: 'table', header: true, rows: rows, x: '', md: tableToMarkdown(rows) });
          }
          return;
        }

        if (node.tagName === 'UL' || node.tagName === 'OL') {
          var items = [];
          Array.prototype.forEach.call(node.children, function (item) {
            if (!item || item.tagName !== 'LI') return;
            var itemText = textOf(item);
            if (!itemText) return;
            items.push({ x: itemText, d: item.classList.contains('nested') ? 1 : 0 });
          });
          if (items.length) {
            var ordered = node.tagName === 'OL';
            blocks.push({
              t: ordered ? 'ol' : 'ul',
              ordered: ordered,
              start: ordered ? Number(node.start || 1) : 1,
              items: items,
              x: '',
              md: ''
            });
          }
          return;
        }

        if (node.tagName === 'HR') {
          blocks.push({ t: 'hr', x: '', md: '---' });
          return;
        }

        if (node.classList && node.classList.contains('pagebreak')) {
          blocks.push({ t: 'pagebreak', x: '', md: '<!-- pagebreak -->' });
          return;
        }

        // Element inserted by the browser when the user presses Enter, or an
        // unknown block: keep its visible text instead of dropping it.
        var text = textOf(node);
        if (!text) return;
        var paragraph = { t: 'p', x: text };
        if (previous && previous.t === 'p' && previous.md
            && plainOf(previous.md) === normalizeBlockText(text)) {
          paragraph.md = previous.md;
        }
        blocks.push(paragraph);
      });

      doc.blocks = blocks;
      if (titleNode) doc.title = (titleNode.innerText || doc.title).trim();
      doc.markdown = docToMarkdown(doc);
    };
    installChatDock();
    installMobileTabs();
    installLegalNotice();
    installVersionHistory();
    installFieldFormShortcuts();
    if (CONFIG.MOCK) installMockTools();
    if (CONFIG.MOCK) installMockBanner();

    window.use = async function () { return null; };
    window.send = send;

    var word = $('dlWord');
    if (word) word.onclick = exportWord;
    var pdf = $('dlPdf');
    if (pdf) pdf.onclick = exportPdf;

    initAuth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
