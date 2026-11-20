'use strict';
// A Confluence page tab's page: header, body and comments (add, reply, edit your own) (design 102, "The page tab"). Title and body
// are edited together and saved together, with the version number the draft started from as the conflict base. Every
// write goes to the host as a message; the host answers `pending` then `result` for that op. A draft is never cleared on a
// failure. No Confluence text is parsed as HTML: textContent here, ProseMirror's serializer in ticketEditor.js.
(function () {
  const vscode = acquireVsCodeApi();
  const E = window.jayEditor;
  const el = E.el;
  const post = (m) => vscode.postMessage(m);
  const OPEN = 'Open in Confluence';
  // read-only reasons that mean "edit it in Confluence" (shown as the button, not as a note)
  const IN_CONFLUENCE = new Set(['legacy', 'live', 'archived']);

  let data = null;          // the last render message
  let lastEditing = false;
  let loadedOnce = false;
  let nextRequest = 1;
  const waiting = new Map(); // requestId -> callback(users)

  function searchUsers(query, cb) {
    const requestId = nextRequest++;
    waiting.set(requestId, cb);
    post({ type: 'searchUsers', requestId, query });
  }
  const openConfluence = () => post({ type: 'openExternal' });
  const reload = () => post({ type: 'reload' });
  const meId = () => (data && data.me ? data.me.accountId : null);
  const nameOf = (id) => (data && data.names && Object.prototype.hasOwnProperty.call(data.names, id) ? data.names[id] : 'Unknown');
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const button = (cls, text, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  };
  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  const renderOpts = () => ({ meId: meId(), onOpenJira: openConfluence, openLabel: OPEN });
  const bodyOf = (adf) => (adf ? E.renderAdf(adf, renderOpts()) : el('p', 'none', "This page's body can't be shown in jay"));

  /** Shows text (and an optional action button) in a .status-msg element. */
  function say(box, text, action) {
    clear(box);
    box.hidden = !text;
    box.dataset.kind = action ? action.cls : '';
    if (!text) return;
    box.appendChild(el('span', 'text', text));
    if (action) box.appendChild(button(action.cls, action.label, action.run));
  }

  // ---- skeleton ----
  const banner = el('div', 'banner'); banner.hidden = true;
  const header = el('header', 'header');
  const pathNav = el('nav', 'path');
  const headline = el('div', 'headline');
  const openLink = button('open-confluence', OPEN, openConfluence);
  headline.append(el('span', 'kind', 'Confluence page'), openLink);
  const titleBox = el('div', 'title');
  const titleText = el('h1', 'title-text');
  const titleEdit = el('div', 'title-edit'); titleEdit.hidden = true;
  const titleInput = el('input', 'title-input'); titleInput.type = 'text';
  titleEdit.appendChild(titleInput);
  titleBox.append(titleText, titleEdit);
  const byline = el('div', 'byline');
  const readOnly = el('div', 'read-only');
  const note = el('span', 'read-only-note'); note.hidden = true;
  const editInConfluence = button('edit-in-confluence', 'Edit in Confluence', openConfluence); editInConfluence.hidden = true;
  readOnly.append(note, editInConfluence);
  header.append(pathNav, headline, titleBox, byline, readOnly);
  const bodySec = el('section', 'page-body');
  const commentsSec = el('section', 'page-comments');
  document.body.append(banner, header, bodySec, commentsSec);

  function showBanner(text, onReload) {
    clear(banner);
    banner.hidden = false;
    banner.appendChild(el('span', 'text', text));
    if (onReload) banner.appendChild(button('reload', 'Reload', onReload));
  }

  // ---- the body and title, edited and saved together ----
  const edit = button('page-edit', 'Edit', () => start()); edit.disabled = true;
  const body = el('div', 'body');
  const theirs = el('details', 'confluence-now'); theirs.hidden = true;
  const theirsBody = el('div', 'theirs-body');
  theirs.append(el('summary', '', 'Confluence now has:'), theirsBody);
  const editorHost = el('div', 'editor-host');
  const save = button('save', 'Save', () => sendSave());
  const cancel = button('cancel', 'Cancel', () => { if (!h.busy) end(); });
  const controls = el('div', 'controls'); controls.append(save, cancel); controls.hidden = true;
  const msg = el('div', 'status-msg'); msg.hidden = true;
  bodySec.append(edit, body, theirs, editorHost, controls, msg);

  // the one write handler on this page so far: op 'page'
  // savedVersion: the version an ok save made, the base for an edit started before the render that shows it
  const h = { busy: false, base: null, lastSent: null, rebaseNext: false, editor: null, savedVersion: null };
  const titleEmpty = () => !titleInput.value.trim();
  const setDisabled = (on) => { for (const c of [save, cancel, titleInput]) c.disabled = on; if (!on) save.disabled = titleEmpty(); };
  titleInput.addEventListener('input', () => { save.disabled = h.busy || titleEmpty(); });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendSave(); } else if (e.key === 'Escape') { e.preventDefault(); if (!h.busy) end(); }
  });

  function updateEditing() {
    const on = !!(h.editor || edits.size || replies.size || (newComment.editor && !newComment.editor.isEmpty()));
    if (on !== lastEditing) { lastEditing = on; post({ type: 'editing', on }); }
  }
  function start() {
    if (h.editor || !data || !data.editable) return;
    const page = data.page;
    h.base = Number.isInteger(h.savedVersion) && h.savedVersion > page.version.number ? h.savedVersion : page.version.number;
    titleInput.value = page.title || '';
    h.editor = E.createEditor(editorHost, page.adf, {
      onSubmit: sendSave, onCancel: () => { if (!h.busy) end(); }, searchUsers, onOpenJira: openConfluence, openLabel: OPEN,
    });
    titleText.hidden = true; titleEdit.hidden = false; body.hidden = true; edit.hidden = true; controls.hidden = false;
    setDisabled(false);
    h.editor.view.focus();
    updateEditing();
  }
  function hideTheirs() { clear(theirsBody); theirs.hidden = true; theirs.open = false; }
  function end() {
    if (!h.editor) return;
    hideTheirs(); h.rebaseNext = false;
    h.editor.destroy(); h.editor = null;
    titleText.hidden = false; titleEdit.hidden = true; body.hidden = false; controls.hidden = true;
    edit.hidden = !(data && data.editable);
    say(msg, '');
    updateEditing();
  }
  /** Sends a write and remembers it, so Retry resends exactly the same thing. Pending from here: the host always answers. */
  function send(m) {
    if (h.busy) return;
    h.lastSent = m; h.busy = true;
    setDisabled(true);
    post(m);
  }
  function sendSave() {
    if (!h.editor || h.busy || titleEmpty()) return;
    send({ type: 'save', title: titleInput.value.trim(), adf: h.editor.toAdf(), base: h.base });
  }
  function onPending(op) {
    if (op !== 'page') { const hh = handlerFor(op); if (hh) onWritePending(hh); return; }
    h.busy = true; setDisabled(true);
  }
  function onResult(op, r) {
    if (op !== 'page') { const hh = handlerFor(op); if (hh) onWriteResult(hh, r); return; }
    h.busy = false;
    if (h.editor) setDisabled(false);
    if (!r) return;
    if (r.ok) { h.savedVersion = r.value && Number.isInteger(r.value.version) ? r.value.version : null; end(); return; }
    if (r.kind === 'busy') say(msg, r.message || 'Another change to this page is still being saved');
    else if (r.kind === 'conflict') say(msg, r.message || 'Changed in Confluence since you opened it', { cls: 'reload', label: 'Reload', run: () => { h.rebaseNext = true; reload(); } });
    else if (r.kind === 'failed') say(msg, r.message || 'Failed', { cls: 'retry', label: 'Retry', run: () => { if (h.lastSent) send(h.lastSent); } });
    else say(msg, r.message || 'Confluence rejected the change');
  }

  // ---- comments: list, add, reply, edit own. Comments never touch the body, so they work on read-only pages too, as long
  // as this sign-in may write to Confluence (a page that is read-only only because of its format still allows them) ----
  const canComment = () => !!data && (!data.readOnlyReason || data.readOnlyReason === 'legacy' || data.readOnlyReason === 'live');
  const commentsTitle = el('h2', 'comments-title', 'Comments');
  const commentsList = el('div', 'comments-list');
  const newBox = el('div', 'new-comment');
  commentsSec.append(commentsTitle, commentsList, newBox);
  const handlers = new Map();  // op -> handler { busy, lastSent, controls(), msg, ok(), retry() } for comment writes
  const edits = new Map();     // comment id -> handler of an open edit (.editor, .box)
  const replies = new Map();   // parent comment id -> handler of an open reply (.editor, .box)
  const newComment = { editor: null };

  function handlerFor(op) {
    if (handlers.has(op)) return handlers.get(op);
    if (op.startsWith('comment:')) return edits.get(op.slice(8)) || null;
    if (op.startsWith('reply:')) return replies.get(op.slice(6)) || null;
    return null;
  }
  function sendW(hh, m) {
    if (hh.busy) return;
    hh.lastSent = m; hh.busy = true;
    for (const c of hh.controls()) c.disabled = true;
    post(m);
  }
  function onWritePending(hh) { hh.busy = true; for (const c of hh.controls()) c.disabled = true; }
  function onWriteResult(hh, r) {
    hh.busy = false;
    for (const c of hh.controls()) c.disabled = false;
    if (hh.after) hh.after();
    if (!r) return;
    if (r.ok) { say(hh.msg, ''); hh.ok(); return; }
    if (r.kind === 'busy') say(hh.msg, r.message || 'Another change to this page is still being saved');
    else if (r.kind === 'conflict') say(hh.msg, r.message || 'Changed in Confluence since you opened it', { cls: 'reload', label: 'Reload', run: () => { hh.rebaseNext = true; reload(); } });
    else if (r.kind === 'failed') say(hh.msg, r.message || 'Failed', { cls: 'retry', label: 'Retry', run: () => sendW(hh, hh.lastSent) });
    else say(hh.msg, r.message || 'Confluence rejected the change');
  }

  /** An editor with Save/Cancel (or a named submit button), used for edits and replies. */
  function makeBox(initial, label, cls, onSend, onEnd) {
    const box = el('div', cls);
    const hh = { busy: false, box, lastSent: null };
    const submit = button('save', label, () => { if (!hh.busy && !hh.editor.isEmpty()) onSend(hh); });
    const cancel = button('cancel', 'Cancel', () => { if (!hh.busy) onEnd(); });
    const msgBox = el('div', 'status-msg'); msgBox.hidden = true;
    hh.msg = msgBox; hh.controls = () => [submit, cancel]; hh.retry = () => sendW(hh, hh.lastSent);
    hh.after = () => { submit.disabled = hh.editor.isEmpty(); };
    hh.theirs = el('details', 'confluence-now'); hh.theirs.hidden = true;
    hh.editor = E.createEditor(box, initial, {
      onSubmit: () => submit.click(), onCancel: () => { if (!hh.busy) onEnd(); }, searchUsers, onOpenJira: openConfluence, openLabel: OPEN,
      onChange: () => { submit.disabled = hh.busy || hh.editor.isEmpty(); updateEditing(); },
    });
    const ctl = el('div', 'controls'); ctl.append(submit, cancel);
    box.insertBefore(hh.theirs, box.firstChild);
    box.append(ctl, msgBox);
    submit.disabled = hh.editor.isEmpty();
    return hh;
  }
  function endBox(map, key) {
    const hh = map.get(key);
    if (!hh) return;
    hh.editor.destroy(); map.delete(key);
    drawComments(); updateEditing();
  }
  function startEdit(c) {
    if (edits.has(c.id)) return;
    const hh = makeBox(c.adf, 'Save', 'comment-edit', (x) => sendW(x, { type: 'editComment', id: c.id, kind: c.kind, adf: x.editor.toAdf(), base: hh.base, loaded: hh.loaded }), () => endBox(edits, c.id));
    hh.base = c.version; hh.loaded = c.adf; hh.ok = () => endBox(edits, c.id);
    edits.set(c.id, hh);
    drawComments(); hh.editor.view.focus(); updateEditing();
  }
  function startReply(c) {
    if (replies.has(c.id)) return;
    const hh = makeBox(null, 'Reply', 'comment-reply', (x) => sendW(x, { type: 'reply', parentId: c.id, kind: c.kind, adf: x.editor.toAdf() }), () => endBox(replies, c.id));
    hh.ok = () => endBox(replies, c.id);
    replies.set(c.id, hh);
    drawComments(); hh.editor.view.focus(); updateEditing();
  }

  function commentEl(c, reply) {
    const mine = !!(c.authorId && c.authorId === meId());
    const item = el('div', 'comment' + (reply ? ' reply' : '') + (mine ? ' mine' : ''));
    item.dataset.commentId = String(c.id);
    const head = el('div', 'comment-head');
    head.append(el('span', 'author', nameOf(c.authorId)), el('span', 'time', fmtTime(c.createdAt)));
    if (c.resolved) head.appendChild(el('span', 'resolved', 'Resolved'));
    item.appendChild(head);
    const editing = edits.get(c.id);
    if (editing) item.appendChild(editing.box);
    else {
      if (mine && canComment()) head.appendChild(button('edit', 'Edit', () => startEdit(c)));
      const b = el('div', 'comment-body');
      b.appendChild(c.adf ? E.renderAdf(c.adf, renderOpts()) : el('p', 'none', '(empty)'));
      item.appendChild(b);
    }
    if (!reply && canComment()) {
      const open = replies.get(c.id);
      if (open) item.appendChild(open.box);
      else item.appendChild(button('reply-btn', 'Reply', () => startReply(c)));
    }
    return item;
  }
  function rebaseEdits() {
    const all = [...(data.footer || []), ...(data.inline || [])].flatMap((c) => [c, ...(c.replies || [])]);
    for (const [id, hh] of edits) {
      if (!hh.rebaseNext) continue;
      hh.rebaseNext = false;
      const now = all.find((x) => x.id === id);
      if (!now) continue;
      hh.base = now.version; hh.loaded = now.adf;
      clear(hh.theirs);
      hh.theirs.append(el('summary', '', 'Confluence now has:'), now.adf ? E.renderAdf(now.adf, renderOpts()) : el('p', 'none', '(empty)'));
      hh.theirs.hidden = false; hh.theirs.open = true;
      say(hh.msg, "Reloaded. Your draft is kept; Confluence's current version is shown with it. Save to apply your draft.");
    }
  }
  const oldestFirst = (list) => [...(list || [])].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
  function drawComments() {
    if (!data) return;
    rebaseEdits();
    clear(commentsList);
    const footer = oldestFirst(data.footer); const inline = oldestFirst(data.inline);
    commentsTitle.textContent = `Comments (${footer.length})`;
    for (const c of footer) { commentsList.appendChild(commentEl(c, false)); for (const r of oldestFirst(c.replies)) commentsList.appendChild(commentEl(r, true)); }
    if (inline.length) {
      commentsList.appendChild(el('h2', 'comments-title', `Inline comments (${inline.length})`));
      for (const c of inline) {
        const group = el('div', 'inline-group');
        if (c.quote) group.appendChild(el('blockquote', 'quote', c.quote));
        group.appendChild(commentEl(c, false));
        for (const r of oldestFirst(c.replies)) group.appendChild(commentEl(r, true));
        commentsList.appendChild(group);
      }
    }
    newBox.hidden = !canComment();
  }

  // a new footer comment
  const commentBtn = button('comment-btn', 'Comment', () => sendComment());
  const newMsg = el('div', 'status-msg'); newMsg.hidden = true;
  const newHost = el('div', 'editor-host');
  const newH = {
    busy: false, lastSent: null, controls: () => [commentBtn], msg: newMsg, retry: () => sendW(newH, newH.lastSent),
    after: () => { commentBtn.disabled = newComment.editor.isEmpty(); },
    ok: () => { newComment.editor.destroy(); makeNewEditor(); updateEditing(); },
  };
  handlers.set('comment', newH);
  function makeNewEditor() {
    newComment.editor = E.createEditor(newHost, null, {
      onSubmit: () => sendComment(), searchUsers, onOpenJira: openConfluence, openLabel: OPEN,
      onChange: () => { commentBtn.disabled = newH.busy || newComment.editor.isEmpty(); updateEditing(); },
    });
    commentBtn.disabled = true;
  }
  function sendComment() { if (!newH.busy && !newComment.editor.isEmpty()) sendW(newH, { type: 'comment', adf: newComment.editor.toAdf() }); }
  newBox.append(newHost, commentBtn, newMsg);
  newBox.hidden = true;
  makeNewEditor();
  function scrollTo(id) {
    for (const item of commentsSec.querySelectorAll('.comment')) {
      const hit = item.dataset.commentId === String(id);
      item.classList.toggle('target', hit);
      if (hit && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'center' });
    }
  }

  // ---- render ----
  function drawPath(m) {
    clear(pathNav);
    pathNav.appendChild(el('span', 'space', (m.space && m.space.name) || (m.space && m.space.key) || ''));
    for (const p of m.path || []) {
      pathNav.appendChild(el('span', 'sep', '›'));
      pathNav.appendChild(button('crumb', p.title || '…', () => post({ type: 'openPage', url: p.url })));
    }
  }

  function render(m) {
    data = m;
    const page = m.page;
    vscode.setState({ pageId: page.id });
    banner.hidden = true;
    drawPath(m);
    titleText.textContent = page.title || '';
    const v = page.version || {};
    byline.textContent = `By ${nameOf(page.authorId)} · Updated ${fmtTime(v.createdAt)} by ${nameOf(v.authorId)}`;
    clear(body);
    body.appendChild(bodyOf(page.adf));
    h.savedVersion = null;
    const why = m.readOnlyReason;
    edit.hidden = !m.editable || !!h.editor;
    editInConfluence.hidden = !IN_CONFLUENCE.has(why);
    note.hidden = !why || IN_CONFLUENCE.has(why);
    note.textContent = note.hidden ? '' : why;
    if (!loadedOnce) { loadedOnce = true; edit.disabled = false; }
    // The draft keeps its base. Only the Reload on its own conflict moves the base to the version Confluence has now,
    // and shows that version beside the draft, so Sean never overwrites text he hasn't seen.
    if (h.rebaseNext) {
      h.rebaseNext = false;
      if (h.editor) {
        h.base = v.number;
        clear(theirsBody);
        theirsBody.append(el('h1', 'theirs-title', page.title || ''), bodyOf(page.adf));
        theirs.hidden = false; theirs.open = true;
        say(msg, "Reloaded. Your draft is kept; Confluence's current version is shown with it. Save to apply your draft.");
      }
    }
    drawComments();
  }

  // links in rendered Confluence text go to the host, which opens Confluence pages in jay and the rest in the browser
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (!a.closest('.ProseMirror[contenteditable="true"]')) post({ type: 'openPage', url: a.getAttribute('href') });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'render': render(m); break;
      case 'pending': onPending(String(m.op)); break;
      case 'result': onResult(String(m.op), m.result); break;
      // the stale banner's Reload re-bases nothing: if the page changed, the draft's save still conflicts
      case 'stale': showBanner('Updated in Confluence, ', reload); break;
      case 'waiting': showBanner(m.message || 'Waiting for sign-in…'); break;
      case 'loadError': h.rebaseNext = false; showBanner(m.message || "Couldn't load this page", reload); break;
      case 'scrollTo': scrollTo(m.commentId); break;
      case 'users': { const cb = waiting.get(m.requestId); if (cb) { waiting.delete(m.requestId); cb(m.users || []); } break; }
    }
  });

  post({ type: 'ready' });
})();
