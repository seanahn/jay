// The jay sidebar: controls on top, the epic tree below. Everything is built with textContent only.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const d = document;
  const saved = vscode.getState() || { expanded: {} };
  if (!saved.expanded) saved.expanded = {};
  let state = { groups: [], events: {}, projects: [], quarters: [] };

  const el = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const post = (m) => vscode.postMessage(m);

  const account = el('div', 'account'); account.hidden = true;
  const error = el('div', 'error'); error.hidden = true;
  const signin = el('button', 'signin primary', 'Sign In'); signin.hidden = true;
  signin.addEventListener('click', () => post({ type: 'signIn' }));
  const note = el('div', 'note'); note.hidden = true;

  const controls = el('div', 'controls');
  // the project picker: a type-to-filter combobox (input + listbox); typed text lives in the input, which render never overwrites while it is open
  const picker = el('div', 'picker');
  const projectIn = el('input', 'project'); projectIn.type = 'text'; projectIn.placeholder = 'Pick a project'; projectIn.autocomplete = 'off';
  projectIn.setAttribute('role', 'combobox'); projectIn.setAttribute('aria-label', 'Project'); projectIn.setAttribute('aria-expanded', 'false');
  projectIn.setAttribute('aria-controls', 'project-list'); projectIn.setAttribute('aria-autocomplete', 'list');
  const projectList = el('div', 'project-list'); projectList.id = 'project-list'; projectList.setAttribute('role', 'listbox'); projectList.setAttribute('aria-label', 'Projects'); projectList.hidden = true;
  picker.append(projectIn, projectList);
  // the period picker: quarters, sprints or fix versions (state.quarters / state.quarter hold its choices and value)
  const quarterSel = el('select', 'quarter'); quarterSel.setAttribute('aria-label', 'Quarter');
  quarterSel.addEventListener('change', () => post({ type: 'setPeriod', id: quarterSel.value }));
  const periodNote = el('div', 'period-note'); periodNote.hidden = true;
  const PERIOD_LABELS = { quarter: 'Quarter', sprint: 'Sprint', fixVersion: 'Fix version' };
  const searchBox = el('input', 'search'); searchBox.type = 'text'; searchBox.placeholder = 'Search key or title'; searchBox.setAttribute('aria-label', 'Search key or title');
  controls.append(searchBox, picker, quarterSel, periodNote);

  const tree = el('div', 'tree'); tree.setAttribute('role', 'tree');
  d.body.append(account, error, signin, note, controls, tree);

  // Jira-wide search: asked after 3+ chars and a 400 ms pause; only the answer to the latest request is shown
  const SEARCH_MIN = 3, SEARCH_MS = 400;
  let reqId = 0, timer = null, found = null;   // found: { items } or { error } for id === reqId

  const query = () => searchBox.value.trim().toLowerCase();
  // a copy of KEY_RE in src/ticket.js (the page loads nothing from the host): keep the two the same
  const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

  const PICK_MAX = 50;
  let pickOpen = false, pickText = '', pickHi = null, pickKeys = [];   // pickText: the filter ('' on a fresh focus); pickHi: the highlighted key
  const projectLabel = (p) => (p.name ? `${p.key} — ${p.name}` : p.key);
  const currentLabel = () => { const p = (state.projects || []).find((x) => x.key === state.project); return p ? projectLabel(p) : state.project || ''; };
  function pickMatches() {
    const all = (state.projects || []).slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const q = pickText.trim().toLowerCase();
    if (!q) {
      const recent = [];
      for (const k of state.recentProjects || []) { const p = all.find((x) => x.key === k); if (p && !recent.includes(p)) recent.push(p); }
      return { recent, rest: all.filter((p) => !recent.includes(p)) };
    }
    const byKey = all.filter((p) => p.key.toLowerCase().startsWith(q));
    return { recent: [], rest: [...byKey, ...all.filter((p) => !byKey.includes(p) && String(p.name || '').toLowerCase().includes(q))] };
  }
  function renderPick() {
    projectIn.setAttribute('aria-expanded', String(pickOpen)); projectList.hidden = !pickOpen;
    if (!pickOpen) { projectList.replaceChildren(); pickKeys = []; projectIn.removeAttribute('aria-activedescendant'); return; }
    const { recent, rest } = pickMatches();
    const total = recent.length + rest.length;
    const shownRecent = recent.slice(0, PICK_MAX), shownRest = rest.slice(0, PICK_MAX - shownRecent.length);
    pickKeys = [...shownRecent, ...shownRest].map((p) => p.key);
    if (!pickKeys.includes(pickHi)) pickHi = pickKeys.length ? pickKeys[0] : null;
    const opt = (p) => {
      const o = el('div', 'option', projectLabel(p)); o.id = 'project-opt-' + p.key; o.dataset.key = p.key; o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(p.key === pickHi)); if (p.key === pickHi) o.classList.add('active');
      return o;
    };
    const out = [];
    if (shownRecent.length) { const h = el('div', 'section', 'Recent'); h.setAttribute('role', 'presentation'); out.push(h); out.push(...shownRecent.map(opt)); }
    if (shownRecent.length && shownRest.length) { const h = el('div', 'section', 'All projects'); h.setAttribute('role', 'presentation'); out.push(h); }
    out.push(...shownRest.map(opt));
    if (!pickKeys.length) { const e = el('div', 'empty', 'No matching projects'); e.setAttribute('role', 'presentation'); out.push(e); }
    if (total > shownRecent.length + shownRest.length) { const e = el('div', 'empty more', 'Type to narrow the list'); e.setAttribute('role', 'presentation'); out.push(e); }
    projectList.replaceChildren(...out);
    if (pickHi) projectIn.setAttribute('aria-activedescendant', 'project-opt-' + pickHi); else projectIn.removeAttribute('aria-activedescendant');
  }
  function pickClose() { pickOpen = false; pickText = ''; projectIn.value = currentLabel(); renderPick(); }
  function pickChoose(key) {
    if (!key) return;
    pickOpen = false; pickText = ''; const p = (state.projects || []).find((x) => x.key === key); projectIn.value = p ? projectLabel(p) : key; renderPick();
    post({ type: 'setProject', key });
  }
  projectIn.addEventListener('focus', () => { pickOpen = true; pickText = ''; pickHi = null; projectIn.select(); renderPick(); });
  projectIn.addEventListener('input', () => { pickOpen = true; pickText = projectIn.value; pickHi = null; renderPick(); });
  projectIn.addEventListener('blur', () => { if (pickOpen) pickClose(); });
  projectIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pickClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pickOpen) { pickOpen = true; pickText = ''; pickHi = null; renderPick(); return; }   // reopening shows row 1 without moving
      if (!pickKeys.length) return;
      const i = pickKeys.indexOf(pickHi), n = e.key === 'ArrowDown' ? Math.min(i + 1, pickKeys.length - 1) : Math.max(i - 1, 0);
      pickHi = pickKeys[n]; renderPick();
      const o = projectList.querySelector('.option.active'); if (o && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && pickOpen) { e.preventDefault(); pickChoose(pickHi); }
  });
  projectList.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box so a click is not preceded by a blur
  projectList.addEventListener('click', (e) => { const o = e.target.closest && e.target.closest('.option'); if (o) pickChoose(o.dataset.key); });

  function fill(sel, items, value, blank) {
    const opts = items.map((x) => { const o = el('option', '', x.label); o.value = x.value; return o; });
    if (blank) { const o = el('option', '', blank); o.value = ''; opts.unshift(o); }
    sel.replaceChildren(...opts);
    sel.value = value || '';
  }

  const hasMine = (n) => n.children.some((c) => c.mine || hasMine(c));
  const isOpen = (n) => (n.key in saved.expanded ? saved.expanded[n.key] : state.mode === 'mine' && hasMine(n));
  const matches = (n, q) => n.key.toLowerCase().includes(q) || String(n.summary).toLowerCase().includes(q);
  const subtreeHas = (n, q) => matches(n, q) || n.children.some((c) => subtreeHas(c, q));

  function allKeys(nodes, out) { for (const n of nodes) { out.add(n.key.toLowerCase()); allKeys(n.children, out); } return out; }

  const DEFAULT_COLUMNS = ['key', 'summary', 'status'];
  const columnList = () => (Array.isArray(state.columns) && state.columns.length ? state.columns : DEFAULT_COLUMNS);
  const orDash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
  function cellText(n, c) {
    switch (c) {
      case 'key': return state.project && n.key.startsWith(state.project + '-') ? n.key.slice(state.project.length + 1) : orDash(n.key);
      case 'summary': return orDash(n.summary);
      case 'assignee': return n.mine ? 'me' : orDash(n.who);
      case 'status': return n.status && n.status !== 'To Do' ? n.status : '';   // To Do stays empty
      case 'type': return orDash(n.type);
      case 'priority': return orDash(n.priority);
      case 'due': return orDash(n.due);
      case 'labels': return orDash(Array.isArray(n.labels) ? n.labels.join(', ') : '');
      case 'estimate': return orDash(n.estimate);
      default: return '';
    }
  }

  function tooltip(n) {
    const lines = [n.key + ' · ' + orDash(n.type), orDash(n.summary), 'Assignee: ' + (n.assignee || 'Unassigned'), 'Status: ' + orDash(n.statusName)];
    if (n.priority) lines.push('Priority: ' + n.priority);
    if (n.due) lines.push('Due: ' + n.due);
    if (n.estimate) lines.push('Estimate: ' + n.estimate);
    if (Array.isArray(n.labels) && n.labels.length) lines.push('Labels: ' + n.labels.join(', '));
    return lines.join('\n');
  }
  const OWNERS = ['me', 'other', 'none'];

  function rowFor(n, depth) {
    const ev = (state.events || {})[n.key] || {};
    const row = el('div', 'row depth' + Math.min(depth, 2));
    row.classList.add(n.mine ? 'mine' : 'other');
    if (n.done) row.classList.add('done');
    if (ev.bold) row.classList.add('bold');
    if (ev.mention) row.classList.add('pulse');
    if (ev.newEpic) row.classList.add('new');
    row.dataset.key = n.key; row.setAttribute('role', 'treeitem'); row.setAttribute('title', tooltip(n));
    const twisty = el('span', 'twisty', ''); twisty.dataset.toggle = n.key;
    row.append(twisty);
    for (const c of columnList()) row.append(el('span', 'col-' + c + (c === 'assignee' && n.mine ? ' me' : '') + (c === 'key' ? ' owner-' + (OWNERS.includes(n.owner) ? n.owner : 'none') : ''), cellText(n, c)));
    if (ev.newEpic) row.append(el('span', 'newmark', 'new'));
    return row;
  }

  function walk(nodes, depth, q, out) {
    for (const n of nodes) {
      if (q && !subtreeHas(n, q)) continue;
      const row = rowFor(n, depth);
      const kids = n.children.length > 0;
      const forced = !!q && n.children.some((c) => subtreeHas(c, q));   // search opens the ancestors of matches only
      const open = kids && (forced || isOpen(n));
      row.querySelector('.twisty').textContent = kids ? (open ? '⌄' : '›') : '';
      if (!kids) row.querySelector('.twisty').dataset.toggle = '';
      out.push(row);
      if (open) walk(n.children, depth + 1, q, out);
    }
  }

  function render() {
    const out = !state.signedIn;
    account.hidden = out || !state.account;
    const cur = state.mode === 'mine' ? 'mine' : 'all', other = cur === 'mine' ? 'all' : 'mine', label = (m) => (m === 'mine' ? 'Mine' : 'All');
    if (out || !/^Signed in as /.test(state.account || '')) account.textContent = out ? '' : state.account || '';
    else {
      const link = el('button', 'mode-other link', label(other)); link.type = 'button';
      const go = () => post({ type: 'setMode', mode: other });
      link.addEventListener('click', go);
      // Enter/Space post here and cancel the browser's own click, so one press never posts twice
      link.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      link.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
      account.replaceChildren(d.createTextNode(state.account + ' · '), el('span', 'mode-current', label(cur)), d.createTextNode(' | '), link);
    }
    error.hidden = !state.error; error.textContent = state.error || '';
    signin.hidden = !out;
    note.hidden = !state.note; note.textContent = state.note || '';
    controls.hidden = out; tree.hidden = out;
    if (out) { tree.replaceChildren(); return; }
    if (!pickOpen) projectIn.value = currentLabel(); else renderPick();   // while open, only the options refresh; the typed text stays
    fill(quarterSel, (state.quarters || []).map((x) => ({ value: x.id, label: x.label })), state.quarter);
    quarterSel.setAttribute('aria-label', PERIOD_LABELS[state.periodKind] || 'Quarter');
    periodNote.hidden = !state.periodNote; periodNote.textContent = state.periodNote || '';

    const q = query();
    const rows = [];
    if (!state.project) rows.push(el('div', 'empty', 'Pick a project'));
    else {
      const items = [];
      for (const g of state.groups || []) {
        const sub = [];
        walk(g.nodes, 0, q, sub);
        const titled = g.title && ((state.groups || []).length > 1 || g.id === 'noepic');
        if (sub.length) { if (titled) items.push(el('div', 'section', g.title)); items.push(...sub); }
      }
      rows.push(...items);
      if (!items.length) rows.push(el('div', 'empty', q ? 'No matches' : state.loading ? 'Loading…' : state.treeLoading ? 'Loading tickets…' : 'Nothing here'));
      const asKey = searchBox.value.trim().toUpperCase();
      if (KEY_RE.test(asKey) && !allKeys(state.groups.flatMap((g) => g.nodes), new Set()).has(asKey.toLowerCase())) {
        const r = el('div', 'row open-key', `Open ${asKey}`); r.dataset.open = asKey; rows.unshift(r);
      }
    }
    if (found) {
      rows.push(el('div', 'section', 'Jira results'));
      if (found.error) rows.push(el('div', 'empty', found.error));
      else {
        const shown = new Set(rows.filter((r) => r.dataset && r.dataset.key).map((r) => r.dataset.key));
        const extra = found.items.filter((i) => !shown.has(i.key));
        if (!extra.length) rows.push(el('div', 'empty', 'No other matches'));
        for (const i of extra) rows.push(rowFor({ ...i, mine: !!i.mine, done: false, children: [] }, 0));
      }
    }
    tree.replaceChildren(...rows);
  }

  function onSearchInput() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const q = searchBox.value.trim();
    if (q.length < SEARCH_MIN) { reqId++; found = null; return; }   // bumping the id drops any answer still on its way
    timer = setTimeout(() => { timer = null; found = null; post({ type: 'search', id: ++reqId, query: q }); render(); }, SEARCH_MS);
  }

  tree.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.toggle) {
      const n = findNode(t.dataset.toggle);
      if (n) { saved.expanded[n.key] = !isOpen(n); vscode.setState(saved); render(); }
      return;
    }
    const row = t.closest && t.closest('.row');
    if (!row) return;
    const key = row.dataset.open || row.dataset.key;
    if (key) post({ type: 'open', key });
  });
  function findNode(key) {
    const stack = (state.groups || []).flatMap((g) => g.nodes);
    while (stack.length) { const n = stack.pop(); if (n.key === key) return n; stack.push(...n.children); }
    return null;
  }

  searchBox.addEventListener('input', () => { onSearchInput(); render(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target === searchBox) { searchBox.value = ''; onSearchInput(); render(); } });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') { state = m; render(); }
    else if (m.type === 'searchResults') {
      if (m.id !== reqId) return;
      found = m.error ? { error: 'Jira search failed' } : { items: Array.isArray(m.items) ? m.items : [] };
      render();
    } else if (m.type === 'focusSearch') searchBox.focus();
  });
  post({ type: 'ready' });
})();
