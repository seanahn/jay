'use strict';
// A ticket tab's page: header, fields, description and comments, each editable in place (design 101, "The ticket tab").
// Every write goes to the host as a message; the host answers `pending` then `result` for that op. A draft is never
// cleared on a failure. No Jira text is parsed as HTML: textContent here, ProseMirror's serializer in ticketEditor.js.
(function () {
  const vscode = acquireVsCodeApi();
  const E = window.jayEditor;
  const el = E.el;
  const post = (m) => vscode.postMessage(m);

  let data = null;          // the last render message
  let lastEditing = false;
  let nextRequest = 1;
  const waiting = new Map(); // requestId -> callback(users)

  function searchUsers(query, assignable, cb) {
    const requestId = nextRequest++;
    waiting.set(requestId, cb);
    post({ type: 'searchUsers', requestId, query, assignable });
    return requestId;
  }
  const openJira = () => post({ type: 'openExternal' });
  const reload = () => post({ type: 'reload' });
  /** A "Jira now has:" block, shown open beside a kept draft after a conflict Reload (Sean can fold it). */
  function theirsBlock() {
    const d = el('details', 'jira-now'); d.hidden = true;
    const body = el('div', 'body');
    d.append(el('summary', '', 'Jira now has:'), body);
    return { el: d, show(node) { clear(body); body.appendChild(node); d.hidden = false; d.open = true; }, hide() { clear(body); d.hidden = true; d.open = false; } };
  }
  const meId = () => (data && data.me ? data.me.accountId : null);
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
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  // ---- status messages next to a control ----
  /** Shows text (and an optional action button) in a .status-msg element. */
  function say(box, text, action) {
    clear(box);
    box.hidden = !text;
    box.dataset.kind = action ? action.cls : '';
    if (!text) return;
    box.appendChild(el('span', 'text', text));
    if (action) box.appendChild(button(action.cls, action.label, action.run));
  }

  // ---- ops: one handler per kind of write ----
  // handler: { controls(): [elements], msg(): element, ok(value), retry(), after() }
  const handlers = new Map();
  function handlerFor(op) {
    if (handlers.has(op)) return handlers.get(op);
    if (op.startsWith('comment:')) return commentEdits.get(op.slice(8)) || null;
    return null;
  }
  function onPending(op) {
    const h = handlerFor(op);
    if (!h) return;
    h.busy = true;
    for (const c of h.controls()) c.disabled = true;
  }
  function onResult(op, r) {
    const h = handlerFor(op);
    if (!h) return;
    h.busy = false;
    if (loadedOnce) for (const c of h.controls()) c.disabled = false;
    if (h.after) h.after();
    if (r && !r.ok && h.reset) h.reset();
    if (!r) return;
    if (r.kind === 'busy') { say(h.msg(), r.message || 'Another change to this ticket is still being saved'); return; }
    if (r.ok) { say(h.msg(), ''); h.ok(r.value); return; }
    if (r.kind === 'conflict') say(h.msg(), r.message || 'Changed in Jira since you opened it', { cls: 'reload', label: 'Reload', run: () => { h.rebaseNext = true; reload(); } });
    else if (r.kind === 'failed') say(h.msg(), r.message || 'Failed', { cls: 'retry', label: 'Retry', run: () => h.retry() });
    else say(h.msg(), r.message || 'Jira rejected the change');
  }
  /** Sends a write and remembers it, so Retry resends exactly the same thing. The op counts as pending from here, so a
   * second click or Enter before the host's `pending` arrives sends nothing; the host always answers with a result. */
  function send(h, m) {
    if (h.busy) return;
    h.lastSent = m; h.busy = true;
    for (const c of h.controls()) c.disabled = true;
    post(m);
  }

  function updateEditing() {
    const on = !!(title.editing || desc.editor || commentEdits.size || (newComment.editor && !newComment.editor.isEmpty()));
    if (on !== lastEditing) { lastEditing = on; post({ type: 'editing', on }); }
  }

  // ---- skeleton ----
  const banner = el('div', 'banner'); banner.hidden = true;
  const header = el('header', 'header');
  const pathNav = el('nav', 'path');
  const headline = el('div', 'headline');
  const keyEl = el('span', 'key'); const typeEl = el('span', 'type');
  const openLink = button('open-jira-link', 'Open in Jira', openJira);
  headline.append(keyEl, typeEl, openLink);
  const titleBox = el('div', 'title');
  header.append(pathNav, headline, titleBox);
  const fields = el('section', 'fields');
  const descSec = el('section', 'description');
  const commentsSec = el('section', 'comments');
  const pagesSec = el('section', 'pages-section'); pagesSec.hidden = true;
  document.body.append(banner, header, fields, descSec, pagesSec, commentsSec);

  function showBanner(text, reload) {
    clear(banner);
    banner.hidden = false;
    banner.appendChild(el('span', 'text', text));
    if (reload) banner.appendChild(button('reload', 'Reload', reload));
  }

  // ---- title (plain text: Jira's summary has no formatting) ----
  const title = { editing: false };
  const titleView = el('div', 'title-view');
  const titleText = el('h1', 'title-text');
  const titleEditBtn = button('edit', 'Edit', () => startTitle()); titleEditBtn.disabled = true;
  titleView.append(titleText, titleEditBtn);
  const titleEdit = el('div', 'title-edit'); titleEdit.hidden = true;
  const titleInput = el('input', 'title-input'); titleInput.type = 'text';
  const titleSave = button('save', 'Save', () => saveTitle());
  const titleCancel = button('cancel', 'Cancel', () => endTitle());
  const titleMsg = el('div', 'status-msg'); titleMsg.hidden = true;
  const titleTheirs = theirsBlock();
  titleEdit.append(titleInput, titleSave, titleCancel, titleMsg, titleTheirs.el);
  titleBox.append(titleView, titleEdit);
  const titleEmpty = () => !titleInput.value.trim();
  titleInput.addEventListener('input', () => { titleSave.disabled = !!titleH.busy || titleEmpty(); });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTitle(); } else if (e.key === 'Escape') { e.preventDefault(); endTitle(); }
  });
  function startTitle() {
    if (!data || title.editing) return;
    title.editing = true; titleH.base = data.issue.summary; titleInput.value = data.issue.summary || ''; titleSave.disabled = titleEmpty();
    titleView.hidden = true; titleEdit.hidden = false; titleInput.focus(); updateEditing();
  }
  function endTitle() { titleTheirs.hide(); titleH.rebaseNext = false; title.editing = false; titleView.hidden = false; titleEdit.hidden = true; say(titleMsg, ''); updateEditing(); }
  function saveTitle() {
    const v = titleInput.value.trim();
    if (!v || title.busy) return;
    send(titleH, { type: 'save', field: 'summary', value: v, base: titleH.base });
  }
  const titleH = { controls: () => [titleSave, titleCancel, titleInput], msg: () => titleMsg, ok: endTitle, retry: () => send(titleH, titleH.lastSent), after: () => { titleSave.disabled = titleEmpty(); },
    theirs: titleTheirs, current: (m) => m.issue.summary, editing: () => title.editing, show: (v) => el('span', 'text', v || '') };
  handlers.set('summary', titleH);
  Object.defineProperty(title, 'busy', { get: () => titleH.busy });

  // ---- fields ----
  const fieldMsg = el('div', 'status-msg'); fieldMsg.hidden = true;
  const row = (label, ...kids) => { const r = el('div', 'field'); r.append(el('span', 'label', label), ...kids); fields.appendChild(r); return r; };

  const statusSel = el('select', 'status');
  const needsScreen = el('span', 'needs-screen'); needsScreen.hidden = true;
  needsScreen.append(el('span', 'text', 'Needs more fields: '), button('open-jira', 'Open in Jira', openJira));
  row('Status', statusSel, needsScreen);
  let transitions = [];
  function drawStatus() {
    clear(statusSel);
    const cur = el('option', '', (data && data.issue.status && data.issue.status.name) || '—'); cur.value = '';
    statusSel.appendChild(cur);
    for (const t of transitions) {
      const to = t.to && t.to.name;
      const o = el('option', '', to && to !== t.name ? `${t.name} → ${to}` : t.name); o.value = t.id;
      statusSel.appendChild(o);
    }
    statusSel.value = '';
  }
  /** A <select> that commits on a mouse pick or Enter, never on each arrow-key step; `onBlur` runs if keys moved it. */
  function explicitPicks(sel, commit, onBlur) {
    let kbd = false;
    sel.addEventListener('keydown', (e) => {
      // Space, F4 and Alt+Arrow open the popup: a pick made there arrives as a plain change and commits
      const opens = e.key === ' ' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'));
      if (e.key === 'Enter') { e.preventDefault(); kbd = false; commit(); } else if (opens) kbd = false;
      else if (!['Tab', 'Shift', 'Escape', 'Alt'].includes(e.key)) kbd = true;
    });
    sel.addEventListener('mousedown', () => { kbd = false; });
    sel.addEventListener('change', () => { if (!kbd) commit(); });
    sel.addEventListener('blur', () => { if (kbd) { kbd = false; onBlur(); } });
  }
  explicitPicks(statusSel, () => {
    const t = transitions.find((x) => x.id === statusSel.value);
    statusSel.value = '';
    if (!t || fieldH.transition.busy) return;
    if (t.hasScreen) { needsScreen.hidden = false; return; }
    needsScreen.hidden = true;
    send(fieldH.transition, { type: 'transition', id: t.id });
  }, () => { statusSel.value = ''; });

  const assigneeName = el('span', 'assignee-name');
  const assignMe = button('assign-me', 'Assign to me', () => send(fieldH.assignee, { type: 'assignMe' }));
  const assigneeSearch = el('input', 'assignee-search'); assigneeSearch.type = 'search'; assigneeSearch.placeholder = 'Assign to…';
  const assigneeResults = el('div', 'assignee-results');
  row('Assignee', assigneeName, assignMe, assigneeSearch, assigneeResults);
  let assigneeRequest = 0;
  assigneeSearch.addEventListener('input', () => {
    const q = assigneeSearch.value.trim();
    clear(assigneeResults);
    if (!q) { assigneeRequest = 0; return; }
    const id = searchUsers(q, true, (users) => {
      if (id !== assigneeRequest) return;
      clear(assigneeResults);
      for (const u of (users || []).filter((x) => x && x.accountId)) {
        assigneeResults.appendChild(button('', u.displayName || u.accountId, () => {
          assigneeSearch.value = ''; clear(assigneeResults);
          send(fieldH.assignee, { type: 'set', field: 'assignee', value: u.accountId });
        }));
      }
      if (!assigneeResults.firstChild) assigneeResults.appendChild(el('span', 'none', 'No one found'));
    });
    assigneeRequest = id;
  });

  const prioritySel = el('select', 'priority');
  row('Priority', prioritySel);
  function commitPriority() {
    const cur = data && data.issue.priority ? data.issue.priority.id : '';
    if (!data || fieldH.priority.busy || !prioritySel.value || prioritySel.value === cur) return;
    send(fieldH.priority, { type: 'set', field: 'priority', value: prioritySel.value });
  }
  explicitPicks(prioritySel, commitPriority, commitPriority);

  const dueInput = el('input', 'duedate'); dueInput.type = 'date';
  row('Due', dueInput);
  // committed on blur or Enter only: typing a year fires change for every valid intermediate date
  function commitDue() {
    if (!data || fieldH.duedate.busy) return;
    const v = dueInput.value || null;
    if (v === (data.issue.duedate || null)) return;
    send(fieldH.duedate, { type: 'set', field: 'duedate', value: v });
  }
  dueInput.addEventListener('blur', () => { if (document.hasFocus()) commitDue(); });
  dueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitDue(); } });

  const labelsInput = el('input', 'labels'); labelsInput.type = 'text'; labelsInput.placeholder = 'label, label';
  row('Labels', labelsInput);
  const parseLabels = (s) => [...new Set(String(s).split(',').map((x) => x.trim()).filter(Boolean))];
  function sendLabels() {
    if (!data || fieldH.labels.busy) return;
    const v = parseLabels(labelsInput.value);
    const cur = data.issue.labels || [];
    if (v.length === cur.length && v.every((x, i) => x === cur[i])) return;
    send(fieldH.labels, { type: 'set', field: 'labels', value: v });
  }
  // a blur because the whole webview lost focus is not a commit
  labelsInput.addEventListener('blur', () => { if (document.hasFocus()) sendLabels(); });
  labelsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendLabels(); } });
  fields.appendChild(fieldMsg);

  const fieldH = {};
  const fieldControls = { transition: [statusSel], assignee: [assignMe, assigneeSearch], priority: [prioritySel], duedate: [dueInput], labels: [labelsInput] };
  for (const [op, controls] of Object.entries(fieldControls)) {
    for (const c of controls) c.disabled = true;   // until the first render
    const h = { controls: () => controls, msg: () => fieldMsg, ok: () => {}, retry: () => send(h, h.lastSent), reset: () => resetField(op) };
    fieldH[op] = h; handlers.set(op, h);
  }

  /** Puts a picker back to what Jira has, after a write that didn't happen. */
  function resetField(op) {
    if (!data) return;
    const issue = data.issue;
    if (op === 'transition') statusSel.value = '';
    else if (op === 'assignee') { assigneeSearch.value = ''; clear(assigneeResults); }
    else if (op === 'priority') prioritySel.value = issue.priority ? issue.priority.id : '';
    else if (op === 'duedate') dueInput.value = issue.duedate || '';
    else if (op === 'labels') labelsInput.value = (issue.labels || []).join(', ');
  }

  function drawFields(issue) {
    drawStatus();
    assigneeName.textContent = issue.assignee ? issue.assignee.displayName || '' : 'Unassigned';
    assignMe.hidden = !!issue.assignee && issue.assignee.accountId === meId();
    const ps = (data.priorities || []).slice();
    if (issue.priority && !ps.some((p) => p.id === issue.priority.id)) ps.push(issue.priority);
    if (document.activeElement !== prioritySel) {
      clear(prioritySel);
      if (!issue.priority) { const o = el('option', '', '—'); o.value = ''; prioritySel.appendChild(o); }
      for (const p of ps) { const o = el('option', '', p.name); o.value = p.id; prioritySel.appendChild(o); }
      prioritySel.value = issue.priority ? issue.priority.id : '';
    }
    if (document.activeElement !== dueInput) dueInput.value = issue.duedate || '';
    if (document.activeElement !== labelsInput) labelsInput.value = (issue.labels || []).join(', ');
  }

  // ---- description ----
  const desc = { editor: null };
  descSec.appendChild(el('h2', '', 'Description'));
  const descBody = el('div', 'body');
  const descEditHost = el('div', 'editor-host');
  const descEdit = button('edit', 'Edit', () => startDesc()); descEdit.disabled = true;
  const descSave = button('save', 'Save', () => saveDesc());
  const descCancel = button('cancel', 'Cancel', () => endDesc());
  const descControls = el('div', 'controls'); descControls.append(descSave, descCancel); descControls.hidden = true;
  const descMsg = el('div', 'status-msg'); descMsg.hidden = true;
  const descTheirs = theirsBlock();
  descSec.append(descEdit, descBody, descTheirs.el, descEditHost, descControls, descMsg);
  function startDesc() {
    if (desc.editor || !data) return;
    descH.base = data.issue.description == null ? null : data.issue.description;
    desc.editor = E.createEditor(descEditHost, data.issue.description, { onSubmit: saveDesc, onCancel: () => { if (!descH.busy) endDesc(); }, searchUsers: (q, cb) => searchUsers(q, false, cb), onOpenJira: openJira });
    descBody.hidden = true; descEdit.hidden = true; descControls.hidden = false;
    desc.editor.view.focus();
    updateEditing();
  }
  function endDesc() {
    if (!desc.editor) return;
    descTheirs.hide(); descH.rebaseNext = false;
    desc.editor.destroy(); desc.editor = null;
    descBody.hidden = false; descEdit.hidden = false; descControls.hidden = true; say(descMsg, '');
    updateEditing();
  }
  function saveDesc() { if (desc.editor && !descH.busy) send(descH, { type: 'save', field: 'description', value: desc.editor.toAdf(), base: descH.base }); }
  const descH = { controls: () => [descSave, descCancel], msg: () => descMsg, ok: endDesc, retry: () => send(descH, descH.lastSent),
    theirs: descTheirs, editing: () => !!desc.editor, current: (m) => (m.issue.description == null ? null : m.issue.description),
    show: (v) => (v ? E.renderAdf(v, { meId: meId(), onOpenJira: openJira }) : el('p', 'none', 'No description')) };
  handlers.set('description', descH);

  // ---- comments ----
  commentsSec.appendChild(el('h2', 'comments-title', 'Comments'));
  const commentsList = el('div', 'comments-list');
  const newBox = el('div', 'new-comment');
  commentsSec.append(commentsList, newBox);
  const commentEdits = new Map();   // comment id -> handler with .editor and .box (the element holding the editor)

  function startComment(c) {
    if (commentEdits.has(c.id)) return;
    const box = el('div', 'comment-edit');
    const save = button('save', 'Save', () => { if (!h.busy) send(h, { type: 'editComment', id: c.id, adf: h.editor.toAdf(), base: h.base }); });
    const cancel = button('cancel', 'Cancel', () => end());
    const msg = el('div', 'status-msg'); msg.hidden = true;
    const theirs = theirsBlock();
    const h = {
      theirs, editing: () => commentEdits.has(c.id), show: (v) => E.renderAdf(v, { meId: meId(), onOpenJira: openJira }),
      current: (m) => { const x = (m.comments || []).find((y) => y.id === c.id); return x ? x.body : undefined; },
      box, base: c.body, controls: () => [save, cancel], msg: () => msg, retry: () => send(h, h.lastSent), ok: () => end(),
      after: () => { save.disabled = h.editor.isEmpty(); },
    };
    const end = () => { if (!commentEdits.has(c.id)) return; h.editor.destroy(); commentEdits.delete(c.id); drawComments(); updateEditing(); };
    h.editor = E.createEditor(box, c.body, {
      onSubmit: () => save.click(), onCancel: () => { if (!h.busy) end(); }, onOpenJira: openJira, searchUsers: (q, cb) => searchUsers(q, false, cb),
      onChange: () => { save.disabled = h.busy || h.editor.isEmpty(); },
    });
    const controls = el('div', 'controls'); controls.append(save, cancel);
    box.insertBefore(theirs.el, box.firstChild);
    box.append(controls, msg);
    commentEdits.set(c.id, h);
    drawComments();
    h.editor.view.focus();
    updateEditing();
  }

  function commentEl(c) {
    const mine = !!(c.author && c.author.accountId === meId());
    const item = el('div', 'comment' + (mine ? ' mine' : ''));
    const head = el('div', 'comment-head');
    head.append(el('span', 'author', (c.author && c.author.displayName) || 'Unknown'), el('span', 'time', fmtTime(c.created)));
    if (c.updated && c.updated !== c.created) head.appendChild(el('span', 'edited', '(edited)'));
    item.appendChild(head);
    const editing = commentEdits.get(c.id);
    if (editing) item.appendChild(editing.box);
    else {
      if (mine) head.appendChild(button('edit', 'Edit', () => startComment(c)));
      const body = el('div', 'body');
      body.appendChild(E.renderAdf(c.body, { meId: meId(), onOpenJira: openJira }));
      item.appendChild(body);
    }
    return item;
  }

  function drawComments() {
    if (!data) return;
    const cs = data.comments || [];
    clear(commentsList);
    const shown = cs.length < data.total ? `Comments (newest ${cs.length} of ${data.total})` : `Comments (${cs.length})`;
    commentsSec.querySelector('.comments-title').textContent = shown;
    const seen = new Set();
    for (const c of cs) { seen.add(c.id); commentsList.appendChild(commentEl(c)); }
    // a comment being edited that is no longer in the list keeps its draft
    for (const [id, h] of commentEdits) if (!seen.has(id)) { const item = el('div', 'comment mine'); item.appendChild(h.box); commentsList.appendChild(item); }
  }

  const newComment = { editor: null };
  const commentBtn = button('comment-btn', 'Comment', () => sendComment());
  const newMsg = el('div', 'status-msg'); newMsg.hidden = true;
  function makeNewEditor() {
    newComment.editor = E.createEditor(newHost, null, {
      onSubmit: () => sendComment(), onOpenJira: openJira, searchUsers: (q, cb) => searchUsers(q, false, cb),
      onChange: () => { commentBtn.disabled = !!newH.busy || newComment.editor.isEmpty(); updateEditing(); },
    });
    commentBtn.disabled = true;
  }
  const newHost = el('div', 'editor-host');
  newBox.append(newHost, commentBtn, newMsg);
  function sendComment() { if (!newH.busy && !newComment.editor.isEmpty()) send(newH, { type: 'comment', adf: newComment.editor.toAdf() }); }
  const newH = {
    controls: () => [commentBtn], msg: () => newMsg, retry: () => send(newH, newH.lastSent),
    after: () => { commentBtn.disabled = newComment.editor.isEmpty(); },
    ok: () => { newComment.editor.destroy(); makeNewEditor(); updateEditing(); },
  };
  handlers.set('comment', newH);
  makeNewEditor();

  // ---- Confluence pages the ticket references (host sends { url, title }; text only) ----
  function drawPages(list) {
    clear(pagesSec);
    pagesSec.hidden = !(list && list.length);
    if (pagesSec.hidden) return;
    pagesSec.appendChild(el('h2', '', 'Confluence pages'));
    const ul = el('ul', 'page-links');
    for (const pg of list) {
      const li = el('li');
      li.appendChild(button('page-link', String(pg.title || pg.url), () => post({ type: 'openPage', url: pg.url })));
      ul.appendChild(li);
    }
    pagesSec.appendChild(ul);
  }

  // ---- render ----
  function drawPath(path) {
    clear(pathNav);
    (path || []).forEach((p, i) => {
      if (i) pathNav.appendChild(el('span', 'sep', '›'));
      pathNav.appendChild(button('crumb', `${p.key} ${p.summary || ''}`.trim(), () => post({ type: 'open', key: p.key })));
    });
  }

  let loadedOnce = false;
  const textHandlers = () => [titleH, descH, ...commentEdits.values()];

  function render(m) {
    data = m;
    const issue = m.issue;
    vscode.setState({ key: issue.key });
    banner.hidden = true;
    drawPath(m.path);
    keyEl.textContent = issue.key;
    typeEl.textContent = issue.type || '';
    titleText.textContent = issue.summary || '';
    drawFields(issue);
    clear(descBody);
    if (issue.description) descBody.appendChild(E.renderAdf(issue.description, { meId: meId(), onOpenJira: openJira }));
    else descBody.appendChild(el('p', 'none', 'No description'));
    if (!loadedOnce) {
      loadedOnce = true;
      titleEditBtn.disabled = false; descEdit.disabled = false;
      for (const [op, controls] of Object.entries(fieldControls)) if (!fieldH[op].busy) for (const c of controls) c.disabled = false;
    }
    // Drafts keep the base they started from. Only the Reload on a draft's own conflict moves its base to what Jira has
    // now, and shows Sean that version beside his draft, so he never overwrites text he hasn't seen.
    for (const h of textHandlers()) {
      if (!h.rebaseNext) continue;
      h.rebaseNext = false;
      const v = h.current(m);
      if (!h.editing() || v === undefined) continue;
      h.base = v;
      h.theirs.show(h.show(v));
      say(h.msg(), "Reloaded. Your draft is kept; Jira's current version is shown with it. Save to apply your draft.");
    }
    drawPages(m.pages);
    drawComments();
    post({ type: 'getTransitions' });
  }

  // links in rendered Jira text open through the host
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (!a.closest('.ProseMirror[contenteditable="true"]')) post({ type: 'openExternal', url: a.getAttribute('href') });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'render': render(m); break;
      case 'pending': onPending(String(m.op)); break;
      case 'result': onResult(String(m.op), m.result); break;
      // the stale banner's Reload re-bases nothing: a field that changed still conflicts when its draft is saved
      case 'stale': showBanner('This ticket changed in Jira since it was loaded. Your edits are kept.', reload); break;
      case 'waiting': showBanner(m.message || 'Waiting for sign-in…'); break;
      case 'loadError':
        for (const h of textHandlers()) h.rebaseNext = false;
        showBanner(m.message || "Couldn't load this ticket", reload);
        break;
      case 'transitions': transitions = Array.isArray(m.list) ? m.list : []; drawStatus(); break;
      case 'users': { const cb = waiting.get(m.requestId); if (cb) { waiting.delete(m.requestId); cb(m.users || []); } break; }
    }
  });

  post({ type: 'ready' });
})();
