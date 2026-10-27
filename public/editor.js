'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const AUTHOR = { user: 'You', assistant: 'Copilot', import: 'Imported', external: 'File changed' };
  const TOKEN_KEY = 'draftloop-token';
  const state = {
    docId: null,
    token: null,
    title: '',
    doc: null,
    loadedRevision: 0,
    latestRevision: 0,
    viewingRevision: null,
    mode: 'edit',
    dirty: false,
    editCount: 0,
    saving: false,
    lock: null,
    conflict: false,
    comments: [],
    revisions: [],
    authoredOpen: new WeakMap(),
    pending: null,
    activeComment: null,
    showResolved: false,
    commentsKey: '',
    historyKey: '',
    selectedHistory: null,
    bannerKind: null,
    polling: false,
    presenceDirty: null,
    presenceAt: 0
  };
  let saveTimer = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  async function api(method, url, body) {
    const headers = { 'x-review-token': state.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || response.statusText);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  const docUrl = suffix => `/api/doc/${encodeURIComponent(state.docId)}${suffix}`;
  const setStatus = text => { $('#save-status').textContent = text; };
  const time = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  function showBanner(kind, message, actions = []) {
    const banner = $('#banner');
    banner.replaceChildren(el('span', { text: message }), ...actions.map(([label, handler]) => el('button', { type: 'button', text: label, onclick: handler })));
    banner.hidden = false;
    state.bannerKind = kind;
  }

  function hideBanner(kind) {
    if (kind && state.bannerKind !== kind) return;
    $('#banner').hidden = true;
    state.bannerKind = null;
  }

  // ---------- Document loading and serialization ----------

  const editable = () => state.mode === 'edit' && !state.lock && state.viewingRevision === null && !state.conflict;

  function applyEditable() {
    $('#mode-edit').setAttribute('aria-pressed', String(state.mode === 'edit'));
    $('#mode-view').setAttribute('aria-pressed', String(state.mode === 'view'));
    if (state.doc?.body) state.doc.body.contentEditable = editable() ? 'true' : 'false';
  }

  function captureView() {
    const doc = state.doc;
    if (!doc) return null;
    return { x: doc.defaultView.scrollX, y: doc.defaultView.scrollY, open: [...doc.querySelectorAll('details')].map(d => d.open) };
  }

  function restoreView(view) {
    const doc = state.doc;
    const details = [...doc.querySelectorAll('details')];
    if (view.open.length === details.length) details.forEach((d, i) => { d.open = view.open[i]; });
    doc.defaultView.scrollTo(view.x, view.y);
  }

  function loadDocument(revision, { preserve = false, readOnly = false } = {}) {
    const frame = $('#document');
    const view = preserve ? captureView() : null;
    return new Promise(resolve => {
      frame.addEventListener('load', () => {
        setupDocument(frame.contentDocument, revision, readOnly);
        if (view) restoreView(view);
        renderHighlights();
        resolve();
      }, { once: true });
      frame.src = `/doc/${encodeURIComponent(state.docId)}/rev/${revision}`;
    });
  }

  function setupDocument(doc, revision, readOnly) {
    state.doc = doc;
    if (!readOnly) {
      state.loadedRevision = revision;
      state.dirty = false;
      state.editCount = 0;
    }
    state.authoredOpen = new WeakMap();
    doc.querySelectorAll('details').forEach(d => state.authoredOpen.set(d, d.open));
    const style = doc.createElement('style');
    style.id = '__review-style';
    style.textContent = `
      ::highlight(review-comment) { background: rgba(250, 200, 40, .38); }
      ::highlight(review-active) { background: rgba(250, 150, 0, .6); }
      [data-review-outline] { outline: 3px solid rgba(240, 170, 0, .85) !important; outline-offset: -3px; }
      [data-review-outline="active"] { outline-color: #e37400 !important; }
      body[contenteditable="true"] { outline: none; caret-color: auto; }`;
    doc.head.append(style);
    // Diagrams and images are commented on as a whole in this version, not edited in place.
    doc.querySelectorAll('svg, img, video, iframe, object').forEach(node => {
      if (node.parentElement?.closest('svg')) return;
      if (!node.hasAttribute('contenteditable')) {
        node.setAttribute('contenteditable', 'false');
        node.setAttribute('data-review-ce', '');
      }
    });
    doc.addEventListener('input', onInput);
    doc.addEventListener('contextmenu', onContextMenu);
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('click', onDocumentClick);
    doc.addEventListener('selectionchange', updateCommentButton);
    doc.addEventListener('mousedown', hideMenu);
    doc.addEventListener('scroll', () => { hideMenu(); }, { passive: true });
    applyEditable();
    updateCommentButton();
  }

  function serialize() {
    const doc = state.doc;
    const clone = doc.documentElement.cloneNode(true);
    clone.querySelector('#__review-style')?.remove();
    clone.querySelectorAll('[data-review-outline]').forEach(node => node.removeAttribute('data-review-outline'));
    clone.querySelectorAll('[data-review-ce]').forEach(node => {
      node.removeAttribute('contenteditable');
      node.removeAttribute('data-review-ce');
    });
    clone.querySelector('body')?.removeAttribute('contenteditable');
    // Expanding sections while reading must not change how the saved draft opens.
    const originals = doc.querySelectorAll('details');
    const copies = clone.querySelectorAll('details');
    originals.forEach((details, index) => {
      const authored = state.authoredOpen.get(details);
      if (authored !== undefined && copies[index]) copies[index].toggleAttribute('open', authored);
    });
    return `<!doctype html>\n${clone.outerHTML}\n`;
  }

  // ---------- Saving ----------

  function onInput() {
    if (!editable()) return;
    state.dirty = true;
    state.editCount++;
    setStatus('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1200);
    reportPresence();
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!state.dirty || state.saving || state.lock || state.viewingRevision !== null || state.conflict) return;
    state.saving = true;
    const editCount = state.editCount;
    setStatus('Saving…');
    try {
      const meta = await api('POST', docUrl('/revisions'), { base: state.loadedRevision, html: serialize() });
      state.loadedRevision = meta.revision;
      state.latestRevision = Math.max(state.latestRevision, meta.revision);
      if (state.editCount === editCount) {
        state.dirty = false;
        setStatus(`Saved · version ${meta.revision}`);
      } else {
        saveTimer = setTimeout(save, 600);
      }
    } catch (error) {
      if (error.status === 409) {
        showConflict();
      } else if (error.status === 423) {
        state.lock = state.lock || { owner: 'assistant' };
        setStatus('Not saved: Copilot is editing');
        applyEditable();
      } else {
        setStatus(`Save failed: ${error.message}. Retrying…`);
        saveTimer = setTimeout(save, 5000);
      }
    } finally {
      state.saving = false;
      reportPresence(true);
    }
  }

  async function flushSave() {
    if (state.dirty && editable()) await save();
    while (state.saving) await new Promise(resolve => setTimeout(resolve, 100));
  }

  function reportPresence(force = false) {
    const dirty = state.dirty;
    if (!force && state.presenceDirty === dirty && Date.now() - state.presenceAt < 3000) return;
    state.presenceDirty = dirty;
    state.presenceAt = Date.now();
    api('POST', docUrl('/presence'), { dirty }).catch(() => {});
  }

  function showConflict() {
    state.conflict = true;
    applyEditable();
    showBanner('conflict', 'A newer version was saved while you were editing.', [
      ['Keep my version', async () => {
        const html = serialize();
        const latest = (await api('GET', docUrl('/state'))).document.latestRevision;
        const meta = await api('POST', docUrl('/revisions'), { base: latest, html });
        state.conflict = false;
        state.dirty = false;
        state.loadedRevision = meta.revision;
        hideBanner('conflict');
        setStatus(`Saved · version ${meta.revision}`);
        await poll();
      }],
      ['Load the newer version', async () => {
        const saved = await api('POST', docUrl('/conflicts'), { html: serialize() });
        state.conflict = false;
        hideBanner('conflict');
        await loadDocument(state.latestRevision, { preserve: true });
        setStatus(`Your unsaved text was copied to ${saved.path}`);
      }]
    ]);
  }

  // ---------- Comment anchors ----------

  function textIndex(doc) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    return { text, nodes };
  }

  function pointAt(index, offset) {
    let low = 0;
    let high = index.nodes.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (index.nodes[mid].start <= offset) low = mid;
      else high = mid - 1;
    }
    const entry = index.nodes[low];
    return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.data.length) };
  }

  function contextFor(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const summary = element?.closest('details')?.querySelector(':scope > summary');
    const section = element?.closest('section, article');
    const heading = section?.querySelector('h1, h2, h3');
    const clean = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return { heading: clean(summary?.querySelector('strong')?.textContent || summary?.textContent), section: clean(heading?.textContent) };
  }

  function captureText(range) {
    const doc = state.doc;
    const quote = range.toString();
    if (!quote.trim()) return null;
    const before = doc.createRange();
    before.setStart(doc.body, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const { text } = textIndex(doc);
    const holder = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    return {
      kind: 'text',
      label: `“${clip(quote.replace(/\s+/g, ' ').trim(), 160)}”`,
      target: {
        quote: quote.slice(0, 4000),
        prefix: text.slice(Math.max(0, start - 64), start),
        suffix: text.slice(start + quote.length, start + quote.length + 64),
        elementId: holder?.closest('[id]')?.id || undefined,
        ...contextFor(range.startContainer)
      }
    };
  }

  function visualLabel(node) {
    const title = node.querySelector?.(':scope > title')?.textContent;
    return (title || node.getAttribute('aria-label') || node.getAttribute('alt') || node.tagName.toLowerCase()).replace(/\s+/g, ' ').trim();
  }

  function captureVisual(node) {
    const tag = node.tagName.toLowerCase();
    const label = visualLabel(node);
    return {
      kind: 'element',
      label: `${tag === 'img' ? 'Image' : 'Diagram'}: ${clip(label, 120)}`,
      target: { elementTag: tag, elementId: node.id || undefined, elementIndex: [...state.doc.querySelectorAll(tag)].indexOf(node), elementLabel: label.slice(0, 500), ...contextFor(node) }
    };
  }

  function compactIndex(doc) {
    const index = textIndex(doc);
    let compact = '';
    const map = [];
    for (let i = 0; i < index.text.length; i++) {
      const char = index.text[i];
      if (char !== ' ' && char !== '\n' && char !== '\t' && char !== '\r' && char !== '\u00a0' && !/\s/.test(char)) {
        compact += char;
        map.push(i);
      }
    }
    return { index, compact, map };
  }

  function findQuote(doc, target, cache) {
    const quote = (target.quote || '').replace(/\s+/g, '');
    if (!quote) return null;
    const { index, compact, map } = cache;
    const prefix = (target.prefix || '').replace(/\s+/g, '');
    const suffix = (target.suffix || '').replace(/\s+/g, '');
    let best = -1;
    let bestScore = -1;
    for (let at = compact.indexOf(quote); at >= 0; at = compact.indexOf(quote, at + 1)) {
      let score = 0;
      while (score < prefix.length && compact[at - 1 - score] === prefix[prefix.length - 1 - score]) score++;
      let after = 0;
      while (after < suffix.length && compact[at + quote.length + after] === suffix[after]) after++;
      if (score + after > bestScore) {
        best = at;
        bestScore = score + after;
      }
    }
    if (best < 0) return null;
    const start = pointAt(index, map[best]);
    const end = pointAt(index, map[best + quote.length - 1] + 1);
    const range = doc.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function findVisual(doc, target) {
    const tag = target.elementTag || 'svg';
    if (target.elementId) {
      const byId = doc.getElementById(target.elementId);
      if (byId) return byId;
    }
    const nodes = [...doc.querySelectorAll(tag)];
    return nodes.find(node => target.elementLabel && visualLabel(node) === target.elementLabel) || nodes[target.elementIndex] || null;
  }

  function renderHighlights() {
    const doc = state.doc;
    if (!doc?.body) return;
    const win = doc.defaultView;
    doc.querySelectorAll('[data-review-outline]').forEach(node => node.removeAttribute('data-review-outline'));
    state.anchors = new Map();
    const ranges = [];
    let active = null;
    let cache = null;
    for (const comment of state.comments) {
      if (comment.status !== 'open' && comment.id !== state.activeComment) continue;
      if (comment.kind === 'text') {
        cache ||= compactIndex(doc);
        const range = findQuote(doc, comment.target, cache);
        if (!range) continue;
        state.anchors.set(comment.id, range);
        if (comment.id === state.activeComment) active = range;
        else ranges.push(range);
      } else {
        const node = findVisual(doc, comment.target);
        if (!node) continue;
        state.anchors.set(comment.id, node);
        node.setAttribute('data-review-outline', comment.id === state.activeComment ? 'active' : '');
      }
    }
    if (win.CSS?.highlights && win.Highlight) {
      win.CSS.highlights.set('review-comment', new win.Highlight(...ranges));
      if (active) win.CSS.highlights.set('review-active', new win.Highlight(active));
      else win.CSS.highlights.delete('review-active');
    }
  }

  function revealAnchor(id) {
    const anchor = state.anchors?.get(id);
    if (!anchor) return false;
    const node = anchor instanceof state.doc.defaultView.Range ? anchor.startContainer.parentElement : anchor;
    for (let details = node.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  // ---------- Document events ----------

  function selectionTarget() {
    const selection = state.doc?.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!state.doc.body.contains(range.commonAncestorContainer)) return null;
    return captureText(range);
  }

  function updateCommentButton() {
    const selection = state.doc?.getSelection();
    $('#comment-button').disabled = !selection || selection.isCollapsed || state.viewingRevision !== null;
  }

  function onContextMenu(event) {
    if (state.viewingRevision !== null) return;
    const visual = event.target.closest?.('svg, img');
    const outer = visual?.tagName.toLowerCase() === 'svg' ? (visual.ownerSVGElement ? visual.ownerSVGElement : visual) : visual;
    const pending = outer ? captureVisual(outer) : selectionTarget();
    if (!pending) return;
    event.preventDefault();
    state.pending = pending;
    const frame = $('#document').getBoundingClientRect();
    const menu = $('#context-menu');
    $('#menu-comment').textContent = outer ? `Comment on this ${outer.tagName.toLowerCase() === 'img' ? 'image' : 'diagram'}` : 'Comment';
    menu.hidden = false;
    menu.style.left = `${Math.min(frame.left + event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(frame.top + event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
    $('#menu-comment').focus();
  }

  function hideMenu() {
    $('#context-menu').hidden = true;
  }

  function onKeyDown(event) {
    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      const pending = selectionTarget();
      if (pending) openComposer(pending);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      flushSave();
    } else if (event.key === 'Escape') {
      hideMenu();
    }
  }

  function onDocumentClick(event) {
    const doc = state.doc;
    const link = event.target.closest?.('a[href]');
    if (link) {
      event.preventDefault();
      if (state.mode === 'view' || event.ctrlKey || event.metaKey) {
        const href = link.getAttribute('href');
        if (href.startsWith('#')) {
          const target = doc.getElementById(decodeURIComponent(href.slice(1)));
          if (target) {
            for (let details = target.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
            target.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        } else if (/^https?:/i.test(link.href)) {
          window.open(link.href, '_blank', 'noopener');
        }
      }
      return;
    }
    const summary = event.target.closest?.('summary');
    if (summary && editable()) {
      // While editing, only the arrow area toggles a section so its title text stays editable.
      event.preventDefault();
      if (event.clientX - summary.getBoundingClientRect().left < 28) summary.parentElement.open = !summary.parentElement.open;
    }
    const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret && state.anchors) {
      for (const [id, anchor] of state.anchors) {
        const hit = anchor instanceof doc.defaultView.Range ? anchor.isPointInRange(caret.startContainer, caret.startOffset) : anchor.contains(event.target);
        if (hit) {
          activateComment(id, false);
          return;
        }
      }
    }
  }

  // ---------- Composer ----------

  async function openComposer(pending) {
    hideMenu();
    state.pending = pending;
    const composer = $('#composer');
    $('#composer-target').textContent = pending.label;
    $('#composer-body').value = '';
    composer.hidden = false;
    const frame = $('#document').getBoundingClientRect();
    composer.style.left = `${Math.max(16, frame.right - composer.offsetWidth - 24)}px`;
    composer.style.top = `${frame.top + 24}px`;
    $('#composer-body').focus();
  }

  function closeComposer() {
    $('#composer').hidden = true;
    state.pending = null;
  }

  async function submitComment(event) {
    event.preventDefault();
    const body = $('#composer-body').value.trim();
    if (!body || !state.pending) return;
    const pending = state.pending;
    await flushSave();
    try {
      const comment = await api('POST', docUrl('/comments'), { revision: state.loadedRevision, kind: pending.kind, target: pending.target, body });
      closeComposer();
      state.activeComment = comment.id;
      await refresh();
      renderHighlights();
      selectTab('comments');
    } catch (error) {
      $('#composer-target').textContent = `Could not save the comment: ${error.message}`;
    }
  }

  // ---------- Side panel ----------

  function selectTab(name) {
    for (const tab of ['comments', 'history']) {
      $(`#tab-${tab}`).setAttribute('aria-selected', String(tab === name));
      $(`#panel-${tab}`).hidden = tab !== name;
    }
  }

  function activateComment(id, scroll = true) {
    state.activeComment = id;
    renderHighlights();
    state.commentsKey = '';
    renderComments();
    selectTab('comments');
    if (scroll) revealAnchor(id);
    document.querySelector(`[data-comment="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function renderComments() {
    const open = state.comments.filter(comment => comment.status === 'open');
    $('#comment-count').textContent = open.length ? `(${open.length})` : '';
    const visible = state.showResolved ? state.comments : open;
    const key = JSON.stringify([visible, state.activeComment]);
    if (key === state.commentsKey) return;
    state.commentsKey = key;
    const list = $('#comment-list');
    // Keep any reply the user is typing when new replies arrive.
    const drafts = new Map([...list.querySelectorAll('textarea[data-reply]')].map(area => [area.dataset.reply, area.value]));
    const focused = document.activeElement?.dataset?.reply;
    list.replaceChildren(...visible.map(comment => {
      const target = comment.kind === 'text'
        ? `“${clip((comment.target.quote || '').replace(/\s+/g, ' ').trim(), 200)}”`
        : `Diagram: ${comment.target.elementLabel || comment.target.elementTag}`;
      const replyArea = el('textarea', { 'data-reply': comment.id, rows: 2, placeholder: 'Reply' });
      replyArea.value = drafts.get(comment.id) || '';
      const item = el('li', {
        class: `comment${comment.id === state.activeComment ? ' active' : ''}${comment.status === 'resolved' ? ' resolved' : ''}`,
        'data-comment': comment.id,
        onclick: event => {
          if (!event.target.closest('button, textarea')) activateComment(comment.id);
        }
      }, [
        el('p', { class: 'comment-target', text: target }),
        el('div', { class: 'comment-meta', text: `You · ${time(comment.created)} · version ${comment.revision}` }, comment.status === 'resolved' ? el('span', { class: 'badge', text: 'Resolved' }) : null),
        el('p', { class: 'comment-body', text: comment.body }),
        ...comment.replies.map(reply => el('div', { class: 'reply' }, [
          el('div', { class: 'comment-meta', text: `${AUTHOR[reply.author] || reply.author} · ${time(reply.created)}` }),
          el('p', { class: 'comment-body', text: reply.body })
        ])),
        el('form', { class: 'reply-form', onsubmit: event => submitReply(event, comment.id) }, [
          replyArea,
          el('div', { class: 'comment-actions' }, [
            el('button', { type: 'submit', text: 'Reply' }),
            el('button', { type: 'button', text: comment.status === 'open' ? 'Resolve' : 'Reopen', onclick: () => setCommentStatus(comment.id, comment.status === 'open' ? 'resolved' : 'open') })
          ])
        ])
      ]);
      return item;
    }));
    if (!visible.length) list.append(el('li', { class: 'hint', text: state.showResolved ? 'No comments yet.' : 'No open comments.' }));
    if (focused) list.querySelector(`textarea[data-reply="${CSS.escape(focused)}"]`)?.focus();
  }

  async function submitReply(event, id) {
    event.preventDefault();
    const area = event.target.querySelector('textarea');
    const body = area.value.trim();
    if (!body) return;
    await api('POST', docUrl(`/comments/${id}/replies`), { body });
    area.value = '';
    await refresh();
  }

  async function setCommentStatus(id, status) {
    await api('POST', docUrl(`/comments/${id}/status`), { status });
    await refresh();
    renderHighlights();
  }

  function renderHistory() {
    const key = JSON.stringify([state.revisions.length, state.revisions.at(-1)?.revision, state.selectedHistory, state.viewingRevision]);
    if (key === state.historyKey) return;
    state.historyKey = key;
    const items = [...state.revisions].reverse().map(meta => el('li', { class: 'history-item' }, el('button', {
      type: 'button',
      'aria-current': String(meta.revision === state.selectedHistory),
      onclick: () => showHistory(meta.revision)
    }, [
      el('span', { text: `Version ${meta.revision}${meta.revision === state.latestRevision ? ' (current)' : ''} · ${AUTHOR[meta.author] || meta.author}` }),
      el('span', { class: 'summary', text: `${time(meta.created)}${meta.summary ? ` · ${meta.summary}` : ''}` })
    ])));
    $('#history-list').replaceChildren(...items);
  }

  function diffList(result) {
    if (!result.lines.length) return el('p', { class: 'hint', text: 'No visible text changed.' });
    return el('ol', { class: 'diff' }, result.lines.map(line => el('li', { class: line.type, text: line.text })));
  }

  async function showHistory(revision, compareTo = revision - 1) {
    state.selectedHistory = revision;
    renderHistory();
    const meta = state.revisions.find(item => item.revision === revision);
    const detail = $('#history-detail');
    detail.hidden = false;
    detail.replaceChildren(el('p', { class: 'hint', text: 'Loading…' }));
    const result = await api('GET', docUrl(`/diff?from=${compareTo}&to=${revision}`));
    const actions = [
      el('button', { type: 'button', text: state.viewingRevision === revision ? 'Back to current' : 'View this version', onclick: () => (state.viewingRevision === revision ? backToCurrent() : viewRevision(revision)) })
    ];
    if (revision !== state.latestRevision) {
      actions.push(el('button', { type: 'button', text: 'Compare with current', onclick: () => showCurrentComparison(revision) }));
      actions.push(el('button', { type: 'button', text: 'Restore this version', onclick: () => restoreRevision(revision) }));
    }
    detail.replaceChildren(
      el('h3', { text: `Version ${revision} · ${AUTHOR[meta?.author] || meta?.author || ''}` }),
      el('div', { class: 'comment-meta', text: `${meta ? time(meta.created) : ''}${meta?.summary ? ` · ${meta.summary}` : ''}` }),
      el('div', { class: 'comment-meta', text: compareTo === revision - 1 ? `Changes from version ${compareTo || 'none'}: +${result.added} / −${result.removed} lines` : `Changes from version ${compareTo}` }),
      diffList(result),
      el('div', { class: 'history-actions' }, actions)
    );
  }

  async function showCurrentComparison(revision) {
    const detail = $('#history-detail');
    const result = await api('GET', docUrl(`/diff?from=${revision}&to=${state.latestRevision}`));
    detail.replaceChildren(
      el('h3', { text: `Version ${revision} → current (version ${state.latestRevision})` }),
      el('div', { class: 'comment-meta', text: `+${result.added} / −${result.removed} lines` }),
      diffList(result),
      el('div', { class: 'history-actions' }, [
        el('button', { type: 'button', text: 'Back', onclick: () => showHistory(revision) }),
        el('button', { type: 'button', text: 'Restore this version', onclick: () => restoreRevision(revision) })
      ])
    );
  }

  async function viewRevision(revision) {
    await flushSave();
    state.viewingRevision = revision;
    await loadDocument(revision, { readOnly: true });
    showBanner('history', `You are viewing version ${revision}. It is read-only.`, [
      ['Back to current', backToCurrent],
      ...(revision !== state.latestRevision ? [['Restore this version', () => restoreRevision(revision)]] : [])
    ]);
    state.historyKey = '';
    showHistory(revision);
  }

  async function backToCurrent() {
    state.viewingRevision = null;
    hideBanner('history');
    await loadDocument(state.latestRevision);
    state.historyKey = '';
    renderHistory();
    if (state.selectedHistory) showHistory(state.selectedHistory);
  }

  async function restoreRevision(revision) {
    if (!window.confirm(`Restore version ${revision}? The current text stays in history.`)) return;
    await flushSave();
    try {
      const meta = await api('POST', docUrl('/restore'), { base: state.latestRevision, revision });
      state.viewingRevision = null;
      hideBanner('history');
      await refresh();
      await loadDocument(meta.revision);
      setStatus(`Restored version ${revision} as version ${meta.revision}`);
      showHistory(meta.revision);
    } catch (error) {
      setStatus(`Restore failed: ${error.message}`);
    }
  }

  // ---------- Sync with the server ----------

  async function refresh() {
    const result = await api('GET', docUrl('/state'));
    state.title = result.document.title;
    document.title = `${result.document.title} · Review`;
    $('#doc-title').textContent = result.document.title;
    state.latestRevision = result.document.latestRevision;
    state.lock = result.document.lock;
    state.revisions = result.revisions;
    state.comments = result.comments;
    if (state.lock) {
      showBanner('lock', 'Copilot is editing this document. Editing is paused until it finishes.');
    } else {
      hideBanner('lock');
    }
    applyEditable();
    renderComments();
    renderHistory();
  }

  async function poll() {
    if (state.polling || !state.docId) return;
    state.polling = true;
    try {
      await refresh();
      if (state.viewingRevision === null && !state.saving && state.latestRevision > state.loadedRevision) {
        if (!state.dirty) {
          await loadDocument(state.latestRevision, { preserve: true });
          const meta = state.revisions.find(item => item.revision === state.latestRevision);
          setStatus(`Updated to version ${state.latestRevision}${meta ? ` · ${AUTHOR[meta.author] || meta.author}` : ''}`);
        } else if (!state.conflict && !state.lock) {
          showConflict();
        }
      }
      renderHighlights();
    } catch (error) {
      setStatus(error.status === 401 ? 'The server restarted. Open the editor link again.' : 'Connection lost. Retrying…');
    } finally {
      state.polling = false;
    }
  }

  async function showDocumentList() {
    $('#document').hidden = true;
    $('.side-panel').hidden = true;
    const list = $('#document-list');
    list.hidden = false;
    const { documents } = await api('GET', '/api/documents');
    $('#doc-title').textContent = 'DraftLoop';
    list.replaceChildren(
      el('h1', { text: 'Drafts' }),
      documents.length
        ? el('ul', {}, documents.map(doc => el('li', {}, [
          el('a', { href: `/?doc=${encodeURIComponent(doc.id)}`, text: doc.title || doc.id }),
          el('span', { class: 'hint', text: ` · version ${doc.latestRevision ?? '?'} · ${doc.openComments ?? 0} open comments` })
        ])))
        : el('p', { class: 'hint', text: 'No drafts yet. Open one with "cli.mjs open <draft.html>".' })
    );
  }

  function bindUi() {
    $('#mode-edit').addEventListener('click', () => { state.mode = 'edit'; applyEditable(); });
    $('#mode-view').addEventListener('click', async () => { await flushSave(); state.mode = 'view'; applyEditable(); });
    $('#comment-button').addEventListener('click', () => {
      const pending = selectionTarget();
      if (pending) openComposer(pending);
    });
    $('#expand-all').addEventListener('click', () => state.doc?.querySelectorAll('details').forEach(d => { d.open = true; }));
    $('#collapse-all').addEventListener('click', () => state.doc?.querySelectorAll('details').forEach(d => { d.open = false; }));
    $('#menu-comment').addEventListener('click', () => { if (state.pending) openComposer(state.pending); });
    $('#composer').addEventListener('submit', submitComment);
    $('#composer-cancel').addEventListener('click', closeComposer);
    $('#composer-body').addEventListener('keydown', event => {
      if (event.key === 'Escape') closeComposer();
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) $('#composer').requestSubmit();
    });
    $('#tab-comments').addEventListener('click', () => selectTab('comments'));
    $('#tab-history').addEventListener('click', () => selectTab('history'));
    $('#show-resolved').addEventListener('change', event => {
      state.showResolved = event.target.checked;
      renderComments();
      renderHighlights();
    });
    $('#copy-request').addEventListener('click', async () => {
      const text = `Review my DraftLoop comments on "${state.title}" (document ${state.docId}).`;
      try {
        await navigator.clipboard.writeText(text);
        setStatus('Review request copied. Paste it into your Copilot session.');
      } catch {
        window.prompt('Copy this into your Copilot session:', text);
      }
    });
    document.addEventListener('mousedown', event => {
      if (!event.target.closest('#context-menu')) hideMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') hideMenu();
    });
    window.addEventListener('beforeunload', event => {
      if (state.dirty) event.preventDefault();
    });
  }

  async function init() {
    const params = new URLSearchParams(location.search);
    state.docId = params.get('doc');
    const fromLink = new URLSearchParams(location.hash.slice(1)).get('token');
    if (fromLink) {
      sessionStorage.setItem(TOKEN_KEY, fromLink);
      history.replaceState(null, '', location.pathname + location.search);
    }
    state.token = fromLink || sessionStorage.getItem(TOKEN_KEY);
    if (!state.token) {
      $('#doc-title').textContent = 'DraftLoop';
      showBanner('auth', 'Open this page from the link printed by "cli.mjs open".');
      return;
    }
    try {
      await api('POST', '/api/session', {});
    } catch (error) {
      $('#doc-title').textContent = 'DraftLoop';
      showBanner('auth', error.status === 401 ? 'This link is from an earlier server run. Run "cli.mjs open" again.' : `Cannot reach the review server: ${error.message}`);
      return;
    }
    bindUi();
    if (!state.docId) {
      await showDocumentList();
      return;
    }
    await refresh();
    await loadDocument(state.latestRevision);
    setStatus(`Version ${state.loadedRevision}`);
    setInterval(poll, 2000);
    setInterval(() => reportPresence(), 3000);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
