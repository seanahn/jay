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
  const PICK_MAX = 50;
  // a type-to-filter combobox (input + listbox), Recent first; typed text lives in the input, which a refresh never overwrites while it is open.
  // o: { noun, nouns, label, placeholder, items() -> [{ key, name }], recent() -> [key], current() -> key, choose(key) }
  function combobox(o) {
    const wrap = el('div', 'picker');
    const input = el('input', o.noun); input.type = 'text'; input.placeholder = o.placeholder; input.autocomplete = 'off';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', o.label); input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', o.noun + '-list'); input.setAttribute('aria-autocomplete', 'list');
    const list = el('div', o.noun + '-list'); list.id = o.noun + '-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', o.nouns[0].toUpperCase() + o.nouns.slice(1)); list.hidden = true;
    wrap.append(input, list);
    let open = false, text = '', hi = null, keys = [];   // text: the filter ('' on a fresh focus); hi: the highlighted key
    const labelOf = (p) => (p.name ? `${p.key} — ${p.name}` : p.key);
    const currentLabel = () => { const k = o.current(), p = (o.items() || []).find((x) => x.key === k); return p ? labelOf(p) : k || ''; };
    function matches() {
      const all = (o.items() || []).slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const q = text.trim().toLowerCase();
      if (!q) {
        const recent = [];
        for (const k of o.recent() || []) { const p = all.find((x) => x.key === k); if (p && !recent.includes(p)) recent.push(p); }
        return { recent, rest: all.filter((p) => !recent.includes(p)) };
      }
      const byKey = all.filter((p) => p.key.toLowerCase().startsWith(q));
      return { recent: [], rest: [...byKey, ...all.filter((p) => !byKey.includes(p) && String(p.name || '').toLowerCase().includes(q))] };
    }
    const info = (cls, t) => { const e = el('div', cls, t); e.setAttribute('role', 'presentation'); return e; };
    function paintList() {
      input.setAttribute('aria-expanded', String(open)); list.hidden = !open;
      if (!open) { list.replaceChildren(); keys = []; input.removeAttribute('aria-activedescendant'); return; }
      const { recent, rest } = matches();
      const total = recent.length + rest.length;
      const shownRecent = recent.slice(0, PICK_MAX), shownRest = rest.slice(0, PICK_MAX - shownRecent.length);
      keys = [...shownRecent, ...shownRest].map((p) => p.key);
      if (!keys.includes(hi)) hi = keys.length ? keys[0] : null;
      const opt = (p) => {
        const e = el('div', 'option', labelOf(p)); e.id = o.noun + '-opt-' + p.key; e.dataset.key = p.key; e.setAttribute('role', 'option');
        e.setAttribute('aria-selected', String(p.key === hi)); if (p.key === hi) e.classList.add('active');
        return e;
      };
      const out = [];
      if (shownRecent.length) { out.push(info('section', 'Recent')); out.push(...shownRecent.map(opt)); }
      if (shownRecent.length && shownRest.length) out.push(info('section', 'All ' + o.nouns));
      out.push(...shownRest.map(opt));
      if (!keys.length) out.push(info('empty', 'No matching ' + o.nouns));
      if (total > shownRecent.length + shownRest.length) out.push(info('empty more', 'Type to narrow the list'));
      list.replaceChildren(...out);
      if (hi) input.setAttribute('aria-activedescendant', o.noun + '-opt-' + hi); else input.removeAttribute('aria-activedescendant');
    }
    function close() { open = false; text = ''; input.value = currentLabel(); paintList(); }
    function choose(key) {
      if (!key) return;
      open = false; text = ''; const p = (o.items() || []).find((x) => x.key === key); input.value = p ? labelOf(p) : key; paintList();
      o.choose(key);
    }
    input.addEventListener('focus', () => { open = true; text = ''; hi = null; input.select(); paintList(); });
    input.addEventListener('input', () => { open = true; text = input.value; hi = null; paintList(); });
    input.addEventListener('blur', () => { if (open) close(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) { open = true; text = ''; hi = null; paintList(); return; }   // reopening shows row 1 without moving
        if (!keys.length) return;
        const i = keys.indexOf(hi), n = e.key === 'ArrowDown' ? Math.min(i + 1, keys.length - 1) : Math.max(i - 1, 0);
        hi = keys[n]; paintList();
        const a = list.querySelector('.option.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && open) { e.preventDefault(); choose(hi); }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box so a click is not preceded by a blur
    list.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('.option'); if (t) choose(t.dataset.key); });
    // refresh from state: while open, only the options refresh; the typed text stays
    return { el: wrap, input, refresh() { if (!open) input.value = currentLabel(); else paintList(); } };
  }

  // the project picker
  const projectBox = combobox({ noun: 'project', nouns: 'projects', label: 'Project', placeholder: 'Pick a project', items: () => state.projects, recent: () => state.recentProjects,
    current: () => state.project, choose: (key) => post({ type: 'setProject', key }) });
  // the period picker: quarters, sprints or fix versions (state.quarters / state.quarter hold its choices and value)
  const quarterSel = el('select', 'quarter'); quarterSel.setAttribute('aria-label', 'Quarter');
  quarterSel.addEventListener('change', () => post({ type: 'setPeriod', id: quarterSel.value }));
  const periodNote = el('div', 'period-note'); periodNote.hidden = true;
  const PERIOD_LABELS = { quarter: 'Quarter', sprint: 'Sprint', fixVersion: 'Fix version' };
  const searchBox = el('input', 'search'); searchBox.type = 'text'; searchBox.placeholder = 'Search key or title'; searchBox.setAttribute('aria-label', 'Search key or title');
  controls.append(searchBox, projectBox.el, quarterSel, periodNote);

  const tree = el('div', 'tree'); tree.setAttribute('role', 'tree');
  d.body.append(account, error, signin, note, controls, tree);

  // site-wide search (Jira's and Confluence's): asked after 3+ chars and a 400 ms pause; only the answer to the latest request is shown
  const SEARCH_MIN = 3, SEARCH_MS = 400;
  function searcher(box, type, failText, skip) {
    const s = { found: null, reqId: 0, timer: null };   // found: { items } or { error } for id === reqId
    s.input = () => {
      if (s.timer !== null) { clearTimeout(s.timer); s.timer = null; }
      const q = box.value.trim();
      if (q.length < SEARCH_MIN || (skip && skip(q))) { s.reqId++; s.found = null; return; }   // bumping the id drops any answer still on its way
      s.timer = setTimeout(() => { s.timer = null; s.found = null; post({ type, id: ++s.reqId, query: q }); paint(); }, SEARCH_MS);
    };
    s.answer = (m) => {
      if (m.id !== s.reqId) return;
      s.found = m.error ? { error: failText } : { items: Array.isArray(m.items) ? m.items : [] };
      paint();
    };
    return s;
  }
  const jiraSearch = searcher(searchBox, 'search', 'Jira search failed');

  const query = () => searchBox.value.trim().toLowerCase();
  // a copy of KEY_RE in src/ticket.js (the page loads nothing from the host): keep the two the same
  const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

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
  // "Label: rest" -> "Label:" when the colon ends the title or is followed by whitespace and the label is 1-60 chars
  function titleLabel(title) {
    const m = /^([^:]*:)(?=\s|$)/.exec(String(title || ''));
    return m && m[1].length > 1 && m[1].length <= 60 ? m[1] : '';
  }
  // a child title minus its parent's shared label (parent's FULL title); the full title if nothing would remain
  function stripLabel(title, parentTitle) {
    const label = titleLabel(parentTitle), t = String(title === undefined || title === null ? '' : title);
    if (!label || t.slice(0, label.length).toLowerCase() !== label.toLowerCase()) return t;
    return t.slice(label.length).replace(/^\s+/, '') || t;
  }
  function cellText(n, c, parentTitle) {
    switch (c) {
      case 'key': return state.project && n.key.startsWith(state.project + '-') ? n.key.slice(state.project.length + 1) : orDash(n.key);
      case 'summary': return orDash(parentTitle === undefined ? n.summary : stripLabel(n.summary, parentTitle));
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

  function rowFor(n, depth, parentTitle) {
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
    for (const c of columnList()) row.append(el('span', 'col-' + c + (c === 'assignee' && n.mine ? ' me' : '') + (c === 'key' ? ' owner-' + (OWNERS.includes(n.owner) ? n.owner : 'none') : ''), cellText(n, c, parentTitle)));
    if (ev.newEpic) row.append(el('span', 'newmark', 'new'));
    return row;
  }

  function walk(nodes, depth, q, out, parentTitle) {
    for (const n of nodes) {
      if (q && !subtreeHas(n, q)) continue;
      const row = rowFor(n, depth, parentTitle);
      const kids = n.children.length > 0;
      const forced = !!q && n.children.some((c) => subtreeHas(c, q));   // search opens the ancestors of matches only
      const open = kids && (forced || isOpen(n));
      row.querySelector('.twisty').textContent = kids ? (open ? '⌄' : '›') : '';
      if (!kids) row.querySelector('.twisty').dataset.toggle = '';
      out.push(row);
      if (open) walk(n.children, depth + 1, q, out, n.summary);
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
    projectBox.refresh();
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
    const found = jiraSearch.found;
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

  searchBox.addEventListener('input', () => { jiraSearch.input(); render(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target === searchBox) { searchBox.value = ''; jiraSearch.input(); render(); } });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') { state = m; paint(); }
    else if (m.type === 'searchResults') jiraSearch.answer(m);
    else if (m.type === 'confSearchResults') confSearch.answer(m);
    else if (m.type === 'focusSearch') (shownSide === 'confluence' ? confSearchBox : searchBox).focus();
  });
  // ---- the Confluence side (notes/102 "The sidebar"): the switch, then account, search, space box, Mentions, My pages and the page tree
  if (!saved.confExpanded) saved.confExpanded = {};
  const sideSwitch = el('div', 'side-switch'); sideSwitch.setAttribute('role', 'group'); sideSwitch.setAttribute('aria-label', 'Jira or Confluence');
  let shownSide = 'jira';
  const sideBtn = (side, label) => {
    const b = el('button', 'side-' + side, label); b.type = 'button';
    b.addEventListener('click', () => { if (shownSide !== side) post({ type: 'setSide', side }); });
    return b;
  };
  const jiraBtn = sideBtn('jira', 'Jira'), confBtn = sideBtn('confluence', 'Confluence');
  sideSwitch.append(jiraBtn, confBtn);
  const conf = () => state.conf || {};
  const confControls = el('div', 'controls conf-controls');
  const confSearchBox = el('input', 'search conf-search'); confSearchBox.type = 'text'; confSearchBox.placeholder = 'Search pages'; confSearchBox.setAttribute('aria-label', 'Search pages');
  const spaceBox = combobox({ noun: 'space', nouns: 'spaces', label: 'Space', placeholder: 'Pick a space', items: () => conf().spaces, recent: () => conf().recentSpaces,
    current: () => (conf().space ? conf().space.key : null), choose: (key) => post({ type: 'setSpace', key }) });
  confControls.append(confSearchBox, spaceBox.el);
  const confTree = el('div', 'tree conf-tree'); confTree.setAttribute('role', 'tree');
  // a page URL or short link: the host checks it against the site (parsePageUrl); this only decides whether to offer "Open this page"
  const PAGE_URL_RE = /^https:\/\/[^\s/]+\/wiki\/(spaces\/[^/\s]+\/pages\/|pages\/viewpage\.action\?|x\/)\S*$/i;
  const confSearch = searcher(confSearchBox, 'confSearch', 'Confluence search failed', (q) => PAGE_URL_RE.test(q));
  const asked = new Set();   // ids whose children were asked for from this page

  const citems = () => conf().items || {};
  const kidsOf = (it) => (it.children || []).map((id) => citems()[id]).filter(Boolean);
  const expandable = (it) => !it.childrenLoaded || (it.children || []).length > 0;
  const confOpen = (it) => !!saved.confExpanded[it.id] && (it.childrenLoaded || asked.has(it.id));
  const cHas = (it, q) => String(it.title).toLowerCase().includes(q) || kidsOf(it).some((k) => cHas(k, q));
  function pathOf(it) {
    const t = []; let p = citems()[it.parentId];
    while (p && t.length < 50) { t.unshift(String(p.title)); p = citems()[p.parentId]; }
    return t;
  }
  function pageRow(cls, id, title, extra, tip) {
    const r = el('div', 'row ' + cls); r.dataset.id = id; r.setAttribute('role', 'treeitem'); r.setAttribute('title', tip);
    r.append(el('span', 'twisty', ''), el('span', 'col-title', String(title)));
    if (extra !== undefined) r.append(el('span', 'col-space', String(extra)));
    return r;
  }
  const moreRow = (key, depth) => { const r = el('div', 'row more depth' + Math.min(depth, 2), 'More'); r.dataset.more = key; return r; };
  const quiet = (t) => el('div', 'empty', t);
  function sectionHead(name, label, open) {
    const h = el('div', 'section toggle'); h.dataset.section = name; h.setAttribute('role', 'button'); h.tabIndex = 0; h.setAttribute('aria-expanded', String(open));
    h.append(el('span', 'twisty', open ? '⌄' : '›'), d.createTextNode(label));
    return h;
  }
  function confWalk(ids, depth, q, out) {
    for (const id of ids || []) {
      const it = citems()[id];
      if (!it || (q && !cHas(it, q))) continue;
      const r = pageRow('page depth' + Math.min(depth, 2), it.id, it.title, undefined, [...pathOf(it), String(it.title)].join(' › ') + (it.kind && it.kind !== 'page' ? '\n' + it.kind : ''));
      r.dataset.kind = String(it.kind || '');
      const open = expandable(it) && ((!!q && kidsOf(it).some((k) => cHas(k, q))) || confOpen(it));
      if (expandable(it)) { const tw = r.querySelector('.twisty'); tw.textContent = open ? '⌄' : '›'; tw.dataset.toggle = it.id; }
      out.push(r);
      if (!open) continue;
      if (!it.childrenLoaded) { out.push(quiet('Loading…')); continue; }
      confWalk(it.children, depth + 1, q, out);
      if (it.hasMore && !q) out.push(moreRow(it.id, depth + 1));
    }
  }
  const when = (at) => { const t = at ? new Date(at) : null; return t && !isNaN(t) ? t.toLocaleString() : ''; };

  function renderConfluence() {
    const c = conf(), out = !state.signedIn;
    account.hidden = out || !c.account; account.textContent = out ? '' : c.account || '';
    error.hidden = !state.error; error.textContent = state.error || '';
    signin.hidden = !out;
    note.hidden = !c.note; note.textContent = c.note || '';
    controls.hidden = true; tree.hidden = true;
    confControls.hidden = out; confTree.hidden = out;
    if (out) { confTree.replaceChildren(); return; }
    spaceBox.refresh();
    const raw = confSearchBox.value.trim(), isUrl = PAGE_URL_RE.test(raw), q = isUrl ? '' : raw.toLowerCase();
    const rows = [];
    if (isUrl) { const r = el('div', 'row open-url', 'Open this page'); r.dataset.url = raw; rows.push(r); }
    const mentions = Array.isArray(c.mentions) ? c.mentions : [];
    if (mentions.length) {
      rows.push(el('div', 'section', 'Mentions'));
      for (const m of mentions) {
        const r = el('div', 'row mention pulse'); r.dataset.mention = m.id;
        r.setAttribute('title', [String(m.title), 'Mentioned by ' + String(m.byName || 'someone'), when(m.at)].filter(Boolean).join('\n'));
        r.append(el('span', 'twisty', ''), el('span', 'col-title', String(m.title)), el('span', 'col-by', String(m.byName || '')));
        rows.push(r);
      }
    }
    const open = c.open || { mine: false, tree: true }, mine = c.mine || { items: [] }, loading = c.loading || {};
    rows.push(sectionHead('mine', 'My pages', !!open.mine));
    if (open.mine) {
      for (const x of mine.items || []) rows.push(pageRow('my-page', x.id, x.title, x.spaceKey, String(x.title) + '\nSpace: ' + String(x.spaceKey)));
      if (!(mine.items || []).length) rows.push(quiet(loading.mine ? 'Loading…' : 'Nothing here'));
      else if (mine.hasMore) rows.push(moreRow('mine', 0));
    }
    if (!c.space) rows.push(quiet('Pick a space'));
    else {
      rows.push(sectionHead('tree', String(c.space.name || c.space.key), open.tree !== false));
      if (open.tree !== false) {
        const sub = [];
        confWalk(c.roots, 0, q, sub);
        if (c.rootsHasMore && !q) sub.push(moreRow('root', 0));
        rows.push(...sub);
        if (!sub.length) rows.push(quiet(q ? 'No matches' : loading.tree ? 'Loading…' : 'Nothing here'));
      }
    }
    const found = confSearch.found;
    if (found) {
      rows.push(el('div', 'section', 'Confluence results'));
      if (found.error) rows.push(quiet(found.error));
      else {
        const shown = new Set(rows.filter((r) => r.dataset.id).map((r) => r.dataset.id));
        const extra = found.items.filter((i) => !shown.has(String(i.id)));
        if (!extra.length) rows.push(quiet('No other matches'));
        for (const i of extra) rows.push(pageRow('result', i.id, i.title, i.spaceKey, String(i.title) + '\nSpace: ' + String(i.spaceKey)));
      }
    }
    confTree.replaceChildren(...rows);
  }

  function toggleConf(id) {
    const it = citems()[id];
    if (!it || !expandable(it)) return;
    const open = confOpen(it);
    if (!open && !it.childrenLoaded && !asked.has(it.id)) { asked.add(it.id); post({ type: 'expandPage', id: it.id }); }
    if (open && !it.childrenLoaded) asked.delete(it.id);   // collapsed before its children came: reopening asks again
    saved.confExpanded[it.id] = !open; vscode.setState(saved); paint();
  }
  confTree.addEventListener('click', (e) => {
    const t = e.target;
    const head = t.closest && t.closest('.section.toggle');
    if (head) { post({ type: 'toggleSection', name: head.dataset.section }); return; }
    if (t.dataset && t.dataset.toggle) { toggleConf(t.dataset.toggle); return; }
    const r = t.closest && t.closest('.row');
    if (!r) return;
    if (r.dataset.url) post({ type: 'openPage', url: r.dataset.url });
    else if (r.dataset.mention) post({ type: 'openMention', id: r.dataset.mention });
    else if (r.dataset.more === 'mine') post({ type: 'moreMine' });
    else if (r.dataset.more) post({ type: 'morePages', id: r.dataset.more === 'root' ? null : r.dataset.more });
    else if (r.dataset.kind === 'folder') toggleConf(r.dataset.id);   // folders have no tab
    else if (r.dataset.id) post({ type: 'openPage', id: r.dataset.id });
  });
  confTree.addEventListener('keydown', (e) => {
    const head = e.target.closest && e.target.closest('.section.toggle');
    if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); post({ type: 'toggleSection', name: head.dataset.section }); }
  });
  confSearchBox.addEventListener('input', () => { confSearch.input(); paint(); });
  confSearchBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { confSearchBox.value = ''; confSearch.input(); paint(); } });

  // Confluence off: always Jira, no switch, and the Confluence parts are not in the page at all
  function paint() {
    const on = !!state.confluenceEnabled;
    shownSide = on && state.side === 'confluence' ? 'confluence' : 'jira';
    if (on) {
      if (sideSwitch.parentNode !== d.body) d.body.prepend(sideSwitch);
      jiraBtn.setAttribute('aria-pressed', String(shownSide === 'jira')); confBtn.setAttribute('aria-pressed', String(shownSide === 'confluence'));
    } else sideSwitch.remove();
    if (shownSide === 'confluence') { if (confTree.parentNode !== d.body) d.body.append(confControls, confTree); renderConfluence(); }
    else { confControls.remove(); confTree.remove(); render(); }
  }
  post({ type: 'ready' });
})();
