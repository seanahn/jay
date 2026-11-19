'use strict';
// The sidebar page script, run in jsdom with a fake acquireVsCodeApi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'media', 'sidebar.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'media', 'sidebar.css'), 'utf8');

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window, posted = []; let saved;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s) => { saved = s; } });
  const timers = new Map(); let tn = 0, clock = 0;   // a clock the tests drive: advance(ms) runs what falls due
  w.setTimeout = (fn, ms) => { timers.set(++tn, { fn, at: clock + ms }); return tn; };
  w.clearTimeout = (id) => { timers.delete(id); };
  const advance = (ms) => { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); } };
  w.eval(SCRIPT);
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  return { w, d: w.document, posted, send, advance };
}
const node = (key, summary, o) => Object.assign({ key, summary, who: 'Ann', status: 'To Do', done: false, mine: false, kind: 'task', children: [] }, o);
const tree = () => [{ id: 'g', title: 'Epics', nodes: [
  node('DEMO-1', 'Alpha epic', { kind: 'epic', children: [
    node('DEMO-2', 'Build the widget', { children: [node('DEMO-3', 'Wire the flange', { mine: true, kind: 'subtask' })] }),
    node('DEMO-4', 'Paint it', { done: true, status: 'Done' })] }),
  node('DEMO-5', 'Beta epic', { kind: 'epic', children: [node('DEMO-6', 'Other work')] })] }];
const state = (o) => Object.assign({ type: 'state', signedIn: true, account: 'Signed in as Ann', projects: [{ key: 'DEMO', name: 'Demo' }, { key: 'OTH', name: 'Other' }],
  project: 'DEMO', quarters: [{ id: 'FY2027Q1', label: 'Q1 FY27' }, { id: 'any', label: 'Any quarter' }], quarter: 'FY2027Q1', mode: 'mine', groups: tree(), events: {}, note: null, error: null }, o);
const rows = (p) => [...p.d.querySelectorAll('.tree .row')];
const keys = (p) => rows(p).map((r) => r.dataset.key);
const search = (p, text) => { const i = p.d.querySelector('input.search'); i.value = text; i.dispatchEvent(new p.w.Event('input', { bubbles: true })); };

test('asks for state when ready', () => { assert.deepStrictEqual(page().posted[0], { type: 'ready' }); });

test('state renders groups with mine and other classes', () => {
  const p = page(); p.send(state());
  // Mine mode: epic DEMO-1 holds a mine item, so it is open down to the sub-task; Beta stays collapsed
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5']);
  const by = (k) => p.d.querySelector(`.row[data-key="${k}"]`);
  assert.ok(by('DEMO-3').classList.contains('mine'));
  assert.ok(by('DEMO-2').classList.contains('other'));
  assert.ok(by('DEMO-4').classList.contains('done'));
  assert.strictEqual(by('DEMO-3').querySelector('.col-assignee').textContent, 'me');
  assert.ok(by('DEMO-3').querySelector('.col-assignee').classList.contains('me'));
  assert.strictEqual(by('DEMO-2').querySelector('.col-assignee').textContent, 'Ann');
  assert.ok(!by('DEMO-2').querySelector('.col-assignee').classList.contains('me'));
  assert.strictEqual(by('DEMO-2').querySelector('.col-status').textContent, '', 'To Do shows no status');
  assert.strictEqual(by('DEMO-4').querySelector('.col-status').textContent, 'Done');
  assert.strictEqual(by('DEMO-3').querySelector('.col-summary').textContent, 'Wire the flange');
  assert.ok(/descriptionForeground/.test(CSS));
});

test('controls: mode, project and quarter post messages', () => {
  const p = page(); p.send(state());
  const sel = (c) => p.d.querySelector('select.' + c);
  assert.strictEqual(p.d.querySelector('input.project').value, 'DEMO — Demo'); assert.strictEqual(sel('quarter').value, 'FY2027Q1');
  sel('quarter').value = 'any'; sel('quarter').dispatchEvent(new p.w.Event('change'));
  p.d.querySelector('.account .mode-other').click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'setPeriod', id: 'any' }, { type: 'setMode', mode: 'all' }]);
});

const acct = (p) => p.d.querySelector('.account');
test('account line: current mode bold, the other a link, no old switch row', () => {
  const p = page(); p.send(state({ account: 'Signed in as ann@example.com (API token)' }));
  const a = acct(p);
  assert.strictEqual(a.textContent, 'Signed in as ann@example.com (API token) · Mine | All');
  const cur = a.querySelector('.mode-current'), other = a.querySelector('.mode-other');
  assert.strictEqual(cur.tagName, 'SPAN'); assert.strictEqual(cur.textContent, 'Mine'); assert.notStrictEqual(cur.tagName, 'BUTTON');
  assert.strictEqual(other.textContent, 'All'); assert.ok(other.tagName === 'BUTTON' || other.getAttribute('role') === 'button');
  assert.strictEqual(p.d.querySelector('.modes'), null); assert.strictEqual(p.d.querySelector('button.mode-mine'), null); assert.strictEqual(p.d.querySelector('button.mode-all'), null);
  assert.ok(/textLink-foreground/.test(CSS)); assert.strictEqual(a.querySelector('[style]'), null);
  p.send(state({ mode: 'all' }));
  assert.strictEqual(acct(p).textContent, 'Signed in as Ann · All | Mine');
  assert.strictEqual(acct(p).querySelector('.mode-current').textContent, 'All'); assert.strictEqual(acct(p).querySelector('.mode-other').textContent, 'Mine');
});

test('account line: clicking the link posts setMode once; Enter on it posts too', () => {
  const p = page(); p.send(state());
  p.d.querySelector('.account .mode-other').click();
  assert.deepStrictEqual(p.posted.slice(1), [{ type: 'setMode', mode: 'all' }]);
  p.send(state({ mode: 'all' }));
  const l = p.d.querySelector('.account .mode-other'); l.focus();
  assert.strictEqual(p.d.activeElement, l);
  l.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepStrictEqual(p.posted.slice(2), [{ type: 'setMode', mode: 'mine' }]);
});

test('account line: signed out or Signing in shows no Mine/All', () => {
  const p = page();
  p.send(state({ signedIn: false })); assert.ok(!/Mine|All/.test(p.d.body.textContent.replace('Sign In', '')));
  p.send(state({ account: 'Signing in…' }));
  assert.strictEqual(acct(p).textContent, 'Signing in…'); assert.strictEqual(acct(p).querySelector('.mode-other'), null);
});

test('clicking a row opens its key; clicking the twisty toggles instead', () => {
  const p = page(); p.send(state());
  p.d.querySelector('.row[data-key="DEMO-2"] .col-summary').click();
  assert.deepStrictEqual(p.posted.pop(), { type: 'open', key: 'DEMO-2' });
  const n = p.posted.length;
  p.d.querySelector('.row[data-key="DEMO-5"] .twisty').click();
  assert.strictEqual(p.posted.length, n);
  assert.deepStrictEqual(keys(p).slice(-2), ['DEMO-5', 'DEMO-6']);
});

test('search keeps ancestors of matches', () => {
  const p = page(); p.send(state({ mode: 'all' }));
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-5']);
  search(p, 'flange');
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  search(p, 'demo-6');
  assert.deepStrictEqual(keys(p), ['DEMO-5', 'DEMO-6']);
  search(p, '');
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-5'], 'saved toggles untouched by search');
});

test('unknown key offers Open KEY', () => {
  const p = page(); p.send(state());
  search(p, 'demo-123');
  const r = p.d.querySelector('.row.open-key');
  assert.strictEqual(r.textContent, 'Open DEMO-123');
  r.click();
  assert.deepStrictEqual(p.posted.pop(), { type: 'open', key: 'DEMO-123' });
  search(p, 'DEMO-3');
  assert.strictEqual(p.d.querySelector('.row.open-key'), null, 'a key in the tree gets no Open row');
});

test('a summary with markup renders as text', () => {
  const p = page();
  const g = [{ id: 'g', title: 'T', nodes: [node('DEMO-9', '<img src=x onerror=alert(1)><b>hi</b>', { kind: 'epic' })] }];
  p.send(state({ groups: g, mode: 'all' }));
  assert.strictEqual(p.d.querySelector('.row .col-summary').textContent, '<img src=x onerror=alert(1)><b>hi</b>');
  assert.strictEqual(p.d.querySelector('.tree img'), null);
  assert.strictEqual(p.d.querySelector('.tree b'), null);
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(SCRIPT));
});

test('expand state survives an update', () => {
  const p = page(); p.send(state({ mode: 'all' }));
  p.d.querySelector('.row[data-key="DEMO-1"] .twisty').click();
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-2', 'DEMO-4', 'DEMO-5']);
  p.send(state({ mode: 'all' }));
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-2', 'DEMO-4', 'DEMO-5']);
  // a user collapse of a default-open epic also sticks
  p.send(state());
  assert.ok(keys(p).includes('DEMO-3'));
  p.d.querySelector('.row[data-key="DEMO-1"] .twisty').click();
  p.send(state());
  assert.deepStrictEqual(keys(p), ['DEMO-1', 'DEMO-5']);
});

test('pulse and bold classes from events', () => {
  const p = page();
  p.send(state({ mode: 'all', events: { 'DEMO-1': { bold: true, mention: true }, 'DEMO-5': { newEpic: true, bold: true } } }));
  const e1 = p.d.querySelector('.row[data-key="DEMO-1"]'), e5 = p.d.querySelector('.row[data-key="DEMO-5"]');
  assert.ok(e1.classList.contains('pulse') && e1.classList.contains('bold'));
  assert.ok(e5.classList.contains('new') && e5.classList.contains('bold') && !e5.classList.contains('pulse'));
  assert.strictEqual(e5.querySelector('.newmark').textContent, 'new');
  assert.strictEqual(e1.querySelector('.newmark'), null);
  assert.ok(/\.row\.pulse[^{]*\{[^}]*animation:\s*pulse/.test(CSS));
  assert.ok(/prefers-reduced-motion: reduce\)[\s\S]*\.row\.pulse[^{]*\{[^}]*animation:\s*none/.test(CSS));
});

test('signed out shows error and Sign In', () => {
  const p = page(); p.send(state({ signedIn: false, error: 'API token rejected: jay: Sign In again', groups: [] }));
  assert.strictEqual(p.d.querySelector('.error').textContent, 'API token rejected: jay: Sign In again');
  p.d.querySelector('button.signin').click();
  assert.deepStrictEqual(p.posted.pop(), { type: 'signIn' });
  assert.strictEqual(p.d.querySelector('.tree .row'), null);
});

test('no project chosen asks to pick one; note shows', () => {
  const p = page(); p.send(state({ project: null, groups: [], note: 'Offline, retrying' }));
  assert.ok(p.d.querySelector('.tree').textContent.includes('Pick a project'));
  assert.strictEqual(p.d.querySelector('.note').textContent, 'Offline, retrying');
});

const searches = (p) => p.posted.filter((m) => m.type === 'search');
const results = (p, id, items, query = 'widget') => p.send({ type: 'searchResults', id, query, items });
const item = (key, summary, o) => Object.assign({ key, summary, who: 'Bo', status: 'In Progress', mine: false }, o);
const jiraRows = (p) => {   // the rows after the "Jira results" heading
  const kids = [...p.d.querySelector('.tree').children]; const at = kids.findIndex((k) => k.textContent === 'Jira results');
  return at < 0 ? [] : kids.slice(at + 1).filter((k) => k.classList.contains('row'));
};

test('search waits 400 ms of quiet and then asks once', () => {
  const p = page(); p.send(state());
  search(p, 'wid'); p.advance(399);
  assert.strictEqual(searches(p).length, 0);
  search(p, 'widg'); p.advance(399);   // typing again resets the pause
  assert.strictEqual(searches(p).length, 0);
  p.advance(1);
  assert.deepStrictEqual(searches(p), [{ type: 'search', id: 1, query: 'widg' }]);
  p.advance(5000);
  assert.strictEqual(searches(p).length, 1);
  search(p, 'widget'); p.advance(400);
  assert.deepStrictEqual(searches(p).map((m) => m.id), [1, 2]);
});

test('under 3 characters sends nothing and clears the results', () => {
  const p = page(); p.send(state());
  search(p, 'ab'); p.advance(1000);
  assert.strictEqual(searches(p).length, 0);
  search(p, 'widget'); p.advance(400); results(p, searches(p)[0].id, [item('OTH-7', 'Widget thing')]);
  assert.ok(p.d.querySelector('.tree').textContent.includes('Jira results'));
  search(p, ' w '); p.advance(1000);
  assert.strictEqual(p.d.querySelector('.tree').textContent.includes('Jira results'), false);
  assert.strictEqual(searches(p).length, 1);
  search(p, 'widget'); p.advance(400); search(p, 'wi'); p.advance(1000);   // pending ask is cancelled
  assert.strictEqual(searches(p).length, 2);
});

test('results show under a heading as flat rows, text only, minus keys already in the tree', () => {
  const p = page(); p.send(state({ mode: 'all' }));
  search(p, 'widget'); p.advance(400);
  results(p, 1, [item('DEMO-1', 'Alpha epic'), item('OTH-7', '<img src=x onerror=alert(1)><b>hi</b>', { mine: true }), item('OTH-8', 'Plain', { who: '-', status: null })]);
  assert.strictEqual(p.d.querySelector('.tree .section').textContent, 'Jira results');
  const rs = jiraRows(p);
  assert.deepStrictEqual(rs.map((r) => r.dataset.key), ['OTH-7', 'OTH-8'], 'DEMO-1 is already in the tree');
  assert.strictEqual(rs[0].querySelector('.col-summary').textContent, '<img src=x onerror=alert(1)><b>hi</b>');
  assert.strictEqual(p.d.querySelector('.tree img'), null);
  assert.strictEqual(p.d.querySelector('.tree b'), null);
  assert.ok(rs[0].classList.contains('mine') && rs[1].classList.contains('other'));
  assert.strictEqual(rs[0].querySelector('.col-assignee').textContent, 'me');
  assert.strictEqual(rs[0].querySelector('.col-status').textContent, 'In Progress');
  assert.strictEqual(rs[1].querySelector('.col-assignee').textContent, '-');
  assert.strictEqual(rs[1].querySelector('.col-status').textContent, '', 'no status: the cell stays empty');
});

test('an answer to an older request is ignored', () => {
  const p = page(); p.send(state());
  search(p, 'widget'); p.advance(400);
  search(p, 'widgets'); p.advance(400);
  results(p, 1, [item('OTH-1', 'Old')]);
  assert.strictEqual(jiraRows(p).length, 0);
  results(p, 2, [item('OTH-2', 'New')]);
  assert.deepStrictEqual(jiraRows(p).map((r) => r.dataset.key), ['OTH-2']);
  search(p, 'x'); results(p, 2, [item('OTH-3', 'Late')]);   // cleared: a late answer must not come back
  assert.strictEqual(jiraRows(p).length, 0);
});

test('a failed search shows one quiet line', () => {
  const p = page(); p.send(state());
  search(p, 'widget'); p.advance(400);
  p.send({ type: 'searchResults', id: 1, query: 'widget', error: 'Jira search failed' });
  assert.strictEqual(p.d.querySelector('.tree .empty:last-child').textContent, 'Jira search failed');
  assert.strictEqual(p.d.querySelector('.error').hidden, true);
});

test('clicking a Jira result opens it', () => {
  const p = page(); p.send(state());
  search(p, 'widget'); p.advance(400); results(p, 1, [item('OTH-7', 'Widget thing')]);
  p.d.querySelector('.row[data-key="OTH-7"] .col-summary').click();
  assert.deepStrictEqual(p.posted.pop(), { type: 'open', key: 'OTH-7' });
});

test('columns: one span per column in the given order, "-" for empties, textContent only', () => {
  const p = page();
  const n = node('DEMO-2', '<b>x</b>', { who: '-', status: 'To Do', type: 'Task', priority: null, due: '2027-03-31', labels: ['a', 'b'], estimate: null, mine: true });
  p.send(state({ mode: 'all', columns: ['estimate', 'key', 'summary', 'due', 'labels', 'priority', 'status', 'assignee', 'type'], groups: [{ id: 'g', title: 'T', nodes: [n] }] }));
  const row = p.d.querySelector('.row[data-key="DEMO-2"]');
  const cells = [...row.children].filter((c) => /^col-/.test(c.className));
  assert.deepStrictEqual(cells.map((c) => c.className), ['col-estimate', 'col-key', 'col-summary', 'col-due', 'col-labels', 'col-priority', 'col-status', 'col-assignee me', 'col-type']);
  assert.deepStrictEqual(cells.map((c) => c.textContent), ['-', '2', '<b>x</b>', '2027-03-31', 'a, b', '-', '', 'me', 'Task']);
  assert.strictEqual(row.querySelector('b'), null);
  assert.ok(row.classList.contains('mine'));
});

test('columns: a narrower list renders only those cells; search rows use the same columns', () => {
  const p = page(); p.send(state({ mode: 'all', columns: ['key', 'summary', 'priority'] }));
  const first = p.d.querySelector('.tree .row');
  assert.deepStrictEqual([...first.children].filter((c) => /^col-/.test(c.className)).map((c) => c.className), ['col-key', 'col-summary', 'col-priority']);
  search(p, 'widget'); p.advance(400);
  results(p, 1, [item('OTH-7', 'Plain', { priority: 'High', type: 'Bug', labels: [], estimate: '1d' })]);
  const [r] = jiraRows(p);
  assert.deepStrictEqual([...r.children].filter((c) => /^col-/.test(c.className)).map((c) => c.textContent), ['OTH-7', 'Plain', 'High']);
});

test('columns: a state without columns uses the default four', () => {
  const p = page(); p.send(state());
  const first = p.d.querySelector('.tree .row');
  assert.deepStrictEqual([...first.children].filter((c) => /^col-/.test(c.className)).map((c) => c.className), ['col-key', 'col-summary', 'col-assignee', 'col-status']);
});

test('period picker: sprint choices, a picker note, and the aria label follows the mode', () => {
  const p = page();
  p.send(state({ periodKind: 'sprint', quarters: [{ id: '7', label: 'Sprint 7' }, { id: 'any', label: 'Any sprint' }], quarter: '7' }));
  const sel = p.d.querySelector('select.quarter');
  assert.deepStrictEqual([...sel.options].map((o) => o.textContent), ['Sprint 7', 'Any sprint']);
  assert.strictEqual(sel.value, '7'); assert.strictEqual(sel.getAttribute('aria-label'), 'Sprint');
  const pn = p.d.querySelector('.period-note');
  assert.strictEqual(pn.hidden, true);
  p.send(state({ periodNote: 'Sprints not available with this sign-in' }));
  assert.strictEqual(pn.hidden, false); assert.strictEqual(pn.textContent, 'Sprints not available with this sign-in');
  assert.strictEqual(sel.getAttribute('aria-label'), 'Quarter');
  p.send(state({ periodKind: 'fixVersion' }));
  assert.strictEqual(sel.getAttribute('aria-label'), 'Fix version');
});

test('a lone "No epic" group still shows its heading', () => {
  const p = page();
  p.send(state({ groups: [{ id: 'noepic', title: 'No epic', nodes: [node('DEMO-9', 'Loose task', { mine: true })] }] }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.tree .section')].map((e) => e.textContent), ['No epic']);
  p.send(state({ groups: [{ id: 'mine', title: null, nodes: [node('DEMO-1', 'Epic', { kind: 'epic', mine: true })] }, { id: 'noepic', title: 'No epic', nodes: [node('DEMO-9', 'Loose', { mine: true })] }] }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.tree .section')].map((e) => e.textContent), ['No epic']);
});

test('loading shows "Loading…" instead of "Nothing here"', () => {
  const p = page();
  p.send(state({ groups: [], loading: true }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.tree .empty')].map((e) => e.textContent), ['Loading…']);
  p.send(state({ groups: [], loading: false }));
  assert.deepStrictEqual([...p.d.querySelectorAll('.tree .empty')].map((e) => e.textContent), ['Nothing here']);
});

test('treeLoading shows "Loading tickets…" until a load completes; "Nothing here" only after one found nothing', () => {
  const p = page();
  const empties = () => [...p.d.querySelectorAll('.tree .empty')].map((e) => e.textContent);
  p.send(state({ groups: [], treeLoading: true }));
  assert.deepStrictEqual(empties(), ['Loading tickets…']);
  p.send(state({ groups: [], treeLoading: true, loading: true }));
  assert.deepStrictEqual(empties(), ['Loading…'], 'one loading line, not two');
  p.send(state({ groups: [], treeLoading: false, loading: false }));
  assert.deepStrictEqual(empties(), ['Nothing here']);
  p.send(state({ treeLoading: true }));
  assert.deepStrictEqual(keys(p).length > 0 && empties(), [], 'groups on screen: no loading line');
});

// ---- the project picker
const many = (n) => Array.from({ length: n }, (_, i) => ({ key: 'P' + String(i).padStart(3, '0'), name: 'Proj ' + i }));
const box = (p) => p.d.querySelector('input.project');
const list = (p) => p.d.querySelector('.project-list');
const opts = (p) => [...p.d.querySelectorAll('.project-list [role=option]')].map((o) => o.dataset.key);
const typeIn = (p, text) => { const i = box(p); i.focus(); i.value = text; i.dispatchEvent(new p.w.Event('input', { bubbles: true })); };
const keydown = (p, key) => box(p).dispatchEvent(new p.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const projs = [{ key: 'ALPHA', name: 'Zed team' }, { key: 'BETA', name: 'Alpha works' }, { key: 'GAMMA', name: 'Gamma' }, { key: 'AL2', name: 'Other' }];

test('picker: combobox/listbox roles and current label', () => {
  const p = page(); p.send(state({ projects: projs, project: 'GAMMA' }));
  assert.strictEqual(box(p).getAttribute('role'), 'combobox'); assert.strictEqual(box(p).getAttribute('aria-expanded'), 'false');
  assert.strictEqual(box(p).getAttribute('aria-controls'), list(p).id); assert.strictEqual(list(p).getAttribute('role'), 'listbox');
  assert.strictEqual(box(p).value, 'GAMMA — Gamma');
  box(p).focus(); assert.strictEqual(box(p).getAttribute('aria-expanded'), 'true');
});

test('picker: key prefix before name match, case-insensitive, trimmed', () => {
  const p = page(); p.send(state({ projects: projs }));
  typeIn(p, '  al ');
  assert.deepStrictEqual(opts(p), ['AL2', 'ALPHA', 'BETA']);
  typeIn(p, 'GAM'); assert.deepStrictEqual(opts(p), ['GAMMA']);
});

test('picker: empty shows Recent (existing keys, in order) then others by key', () => {
  const p = page(); p.send(state({ projects: projs, recentProjects: ['GAMMA', 'GONE', 'BETA'] }));
  box(p).focus();
  assert.deepStrictEqual(opts(p), ['GAMMA', 'BETA', 'AL2', 'ALPHA']);
  assert.strictEqual(list(p).querySelector('.section').textContent, 'Recent');
});

test('picker: 50-row cap with a narrow line', () => {
  const p = page(); p.send(state({ projects: many(60) }));
  box(p).focus();
  assert.strictEqual(opts(p).length, 50);
  assert.ok(/narrow/i.test(list(p).querySelector('.more').textContent));
  typeIn(p, 'P05'); assert.strictEqual(list(p).querySelector('.more'), null);
});

test('picker: arrows and Enter post setProject once', () => {
  const p = page(); p.send(state({ projects: projs }));
  box(p).focus(); keydown(p, 'ArrowDown'); keydown(p, 'ArrowDown'); keydown(p, 'ArrowUp'); keydown(p, 'ArrowDown');
  assert.strictEqual(p.d.querySelector('.option.active').dataset.key, 'BETA');
  assert.strictEqual(p.d.querySelector('.option.active').getAttribute('aria-selected'), 'true');
  keydown(p, 'Enter'); box(p).dispatchEvent(new p.w.Event('blur'));
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'setProject'), [{ type: 'setProject', key: 'BETA' }]);
  assert.strictEqual(list(p).hidden, true);
});

test('picker: click posts', () => {
  const p = page(); p.send(state({ projects: projs }));
  box(p).focus(); p.d.querySelector('.option[data-key="GAMMA"]').click();
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'setProject'), [{ type: 'setProject', key: 'GAMMA' }]);
});

test('picker: Escape and blur restore the text and post nothing', () => {
  const p = page(); p.send(state({ projects: projs, project: 'GAMMA' }));
  typeIn(p, 'zzz'); keydown(p, 'Escape');
  assert.strictEqual(box(p).value, 'GAMMA — Gamma'); assert.strictEqual(list(p).hidden, true);
  typeIn(p, 'AL'); box(p).dispatchEvent(new p.w.Event('blur'));
  assert.strictEqual(box(p).value, 'GAMMA — Gamma'); assert.strictEqual(list(p).hidden, true);
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'setProject'), []);
});

test('picker: a state update while typing keeps the typed text and the open list', () => {
  const p = page(); p.send(state({ projects: projs }));
  typeIn(p, 'gam');
  p.send(state({ projects: [...projs, { key: 'GAM2', name: 'More' }] }));
  assert.strictEqual(box(p).value, 'gam'); assert.strictEqual(list(p).hidden, false);
  assert.deepStrictEqual(opts(p), ['GAM2', 'GAMMA']);
});

test('picker: names render as text only', () => {
  const p = page(); p.send(state({ projects: [{ key: 'XSS', name: '<img src=x onerror=1>' }] }));
  box(p).focus();
  assert.strictEqual(list(p).querySelector('img'), null);
  assert.strictEqual(list(p).querySelector('.option').textContent, 'XSS — <img src=x onerror=1>');
});

test('picker: key-prefix matches come before name matches even when the name match sorts first by key', () => {
  const p = page(); p.send(state({ projects: [{ key: 'AAA', name: 'Balloon' }, { key: 'BAL', name: 'x' }] }));
  typeIn(p, 'bal');
  assert.deepStrictEqual(opts(p), ['BAL', 'AAA']);
});

test('picker: ArrowDown on a closed list reopens it on row 1 without moving', () => {
  const p = page(); p.send(state({ projects: projs }));
  box(p).focus(); keydown(p, 'Escape'); assert.strictEqual(list(p).hidden, true);
  keydown(p, 'ArrowDown');
  assert.strictEqual(list(p).hidden, false);
  assert.strictEqual(p.d.querySelector('.option.active').dataset.key, 'AL2');
});

test('picker: info lines inside the listbox are presentation', () => {
  const p = page(); p.send(state({ projects: many(60) }));
  box(p).focus();
  assert.strictEqual(list(p).querySelector('.more').getAttribute('role'), 'presentation');
  typeIn(p, 'nomatch-zzz');
  assert.strictEqual(list(p).querySelector('.empty').getAttribute('role'), 'presentation');
});

test('picker: Recent goes away once text is typed; recent is not repeated under All projects; header shows', () => {
  const p = page(); p.send(state({ projects: projs, recentProjects: ['GAMMA'] }));
  box(p).focus();
  const heads = () => [...list(p).querySelectorAll('.section')].map((h) => h.textContent);
  assert.deepStrictEqual(heads(), ['Recent', 'All projects']);
  assert.deepStrictEqual(opts(p).filter((k) => k === 'GAMMA').length, 1);
  typeIn(p, 'a');
  assert.deepStrictEqual(heads(), []);
});

test("assignee cell: 'me' in green when mine, first name otherwise, '-' when unassigned (tree and search rows)", () => {
  const p = page(); p.send(state({ groups: [{ id: 'g', title: null, nodes: [
    node('DEMO-7', 'Mine one', { mine: true, who: 'Cy' }), node('DEMO-8', 'Nobody', { who: null })] }] }));
  const cell = (k) => p.d.querySelector(`.row[data-key="${k}"] .col-assignee`);
  assert.strictEqual(cell('DEMO-7').textContent, 'me'); assert.ok(cell('DEMO-7').classList.contains('me'));
  assert.strictEqual(cell('DEMO-8').textContent, '-'); assert.ok(!cell('DEMO-8').classList.contains('me'));
  search(p, 'widget'); p.advance(400);
  results(p, 1, [item('DEMO-20', 'Mine hit', { mine: true }), item('DEMO-21', 'Other hit'), item('DEMO-22', 'Nobody hit', { who: null })]);
  const [a, b, c] = jiraRows(p).map((r) => r.querySelector('.col-assignee'));
  assert.strictEqual(a.textContent, 'me'); assert.ok(a.classList.contains('me'));
  assert.strictEqual(b.textContent, 'Bo'); assert.ok(!b.classList.contains('me'));
  assert.strictEqual(c.textContent, '-');
});

test('the CSS paints .col-assignee.me with --vscode-charts-green', () => {
  assert.ok(/\.col-assignee\.me\s*\{[^}]*var\(--vscode-charts-green\)/.test(CSS));
});

test('key cell shows only the number in the selected project, the full key elsewhere', () => {
  const p = page(); p.send(state());
  search(p, 'widget'); p.advance(400);
  results(p, 1, [node('OTH-77', 'Elsewhere'), node('DEMO-90', 'Same project')]);
  assert.strictEqual(p.d.querySelector('.row[data-key="DEMO-2"] .col-key').textContent, '2');
  const j = jiraRows(p);
  assert.strictEqual(j.find((r) => r.dataset.key === 'OTH-77').querySelector('.col-key').textContent, 'OTH-77');
  assert.strictEqual(j.find((r) => r.dataset.key === 'DEMO-90').querySelector('.col-key').textContent, '90');
});

test('every row has a tooltip with the full key and summary', () => {
  const p = page(); p.send(state());
  assert.strictEqual(p.d.querySelector('.row[data-key="DEMO-2"]').getAttribute('title'), 'DEMO-2 Build the widget');
  search(p, 'widget'); p.advance(400);
  results(p, 1, [node('OTH-77', 'Elsewhere')]);
  assert.strictEqual(jiraRows(p)[0].getAttribute('title'), 'OTH-77 Elsewhere');
});

test('clicking a row with a short key still posts the full key', () => {
  const p = page(); p.send(state());
  p.d.querySelector('.row[data-key="DEMO-2"] .col-summary').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
  assert.deepStrictEqual(p.posted.filter((m) => m.type === 'open'), [{ type: 'open', key: 'DEMO-2' }]);
});

test('the CSS indents 8px per tree level', () => {
  assert.ok(/\.row\.depth1\s*\{[^}]*padding-left:\s*8px/.test(CSS));
  assert.ok(/\.row\.depth2\s*\{[^}]*padding-left:\s*16px/.test(CSS));
});
