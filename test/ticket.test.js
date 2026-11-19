'use strict';
// The ticket tab's host side: panels from the vscode stub, a scripted fake api and writer, a real mirror in a temp dir.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { install } = require('./vscodeStub');

const { vscode, ui } = install();
const { createTickets } = require('../src/ticket');
const { createMirror } = require('../src/mirror');
const { createWriter } = require('../src/writes');

const browseUrl = (k) => `https://example.atlassian.net/browse/${k}`;
const doc = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const ME = { accountId: 'acc-sean', displayName: 'Sean Example' };
const iss = (key, o = {}) => ({
  key, type: 'Task', isEpic: false, isSubtask: false, summary: `Summary ${key}`, status: { name: 'Open', category: 'new' },
  assignee: null, reporter: null, priority: null, duedate: null, labels: [], parentKey: null,
  created: '2026-11-02T13:21:00.000Z', updated: '2026-11-18T09:05:00.000Z', description: doc('Body'), ...o,
});
const settle = () => new Promise((r) => setTimeout(r, 15));

function fakeApi(issues) {
  const calls = [];
  const rec = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const api = {
    issue: rec('issue', (k) => { const i = issues.get(k); if (!i) { const e = new Error('Issue does not exist'); e.name = 'JiraError'; e.status = 404; throw e; } return JSON.parse(JSON.stringify(i)); }),
    comments: rec('comments', () => ({ comments: [{ id: '10', author: { accountId: 'acc-alex', displayName: 'Alex Kim' }, created: '2026-11-17T14:19:00.000Z', updated: '2026-11-17T14:19:00.000Z', body: doc('hi') }], total: 1 })),
    search: rec('search', (jql) => [...issues.values()].filter((i) => jql === `parent = ${i.parentKey}`)),
    transitions: rec('transitions', () => [{ id: '31', name: 'Done', to: { name: 'Done', category: 'done' }, hasScreen: false }]),
    assignable: rec('assignable', () => [ME]), users: rec('users', () => [ME]),
    priorities: rec('priorities', () => [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }]),
    // for the real writer: fields read from and written to the scripted issues
    field: rec('field', (k, name) => issues.get(k)[name]),
    setFields: rec('setFields', (k, fields) => { issues.set(k, Object.assign({}, issues.get(k), fields, { updated: new Date().toISOString() })); }),
    browseUrl,
  };
  return { api, calls, count: (n) => calls.filter((c) => c[0] === n).length };
}
function fakeWriter(result = { ok: true, value: null }) {
  const calls = [];
  const w = {};
  for (const n of ['saveText', 'addComment', 'editComment', 'setField', 'transition']) w[n] = async (...a) => { calls.push([n, ...a]); return result; };
  w.pending = () => false;
  return { writer: w, calls };
}
function fakeEvents() { const log = []; return { log, seen: (k) => log.push(['seen', k]), save: () => log.push(['save']) }; }

function setup({ issues = [iss('DEMO-1')], index = new Map(), writerResult, realWriter = false } = {}) {
  ui.panels.length = 0; ui.focused = true; ui.opened.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-ticket-'));
  const map = new Map(issues.map((i) => [i.key, i]));
  const f = fakeApi(map); const w = fakeWriter(writerResult); const events = fakeEvents();
  if (realWriter) w.writer = createWriter({ api: f.api, meId: ME.accountId });
  const mirror = createMirror({ dir, browseUrl });
  const tickets = createTickets({ vscode, api: f.api, writer: w.writer, mirror, events, getIndex: () => index, me: ME, extensionUri: vscode.Uri.file('/ext'), isFocused: () => ui.focused });
  return { dir, map, f, w, events, mirror, tickets, current: () => { try { return fs.readFileSync(path.join(dir, 'current.jira'), 'utf8'); } catch (_) { return null; } } };
}
async function opened(s, key = 'DEMO-1') {
  s.tickets.open(key);
  const panel = ui.panels[ui.panels.length - 1];
  panel.webview._receive({ type: 'ready' });
  await settle();
  return panel;
}
const posted = (panel, type) => panel.webview.posted.filter((m) => m.type === type);

test('open fetches, renders, writes the file, records seen and sets current when focused', async () => {
  const epic = iss('DEMO-5', { type: 'Epic', isEpic: true, summary: 'The epic' });
  const s = setup({ issues: [iss('DEMO-1', { parentKey: 'DEMO-5', summary: 'Fix the <b>thing</b>' }), epic, iss('DEMO-2', { parentKey: 'DEMO-5' })] });
  const panel = await opened(s);
  assert.strictEqual(panel.viewType, 'jay.ticket');
  assert.strictEqual(panel.title, 'DEMO-1');
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  assert.match(panel.webview.html, /prosemirror\.js/);
  assert.ok(s.f.count('issue') >= 1 && s.f.count('comments') === 1);
  const [r] = posted(panel, 'render');
  assert.strictEqual(r.issue.key, 'DEMO-1');
  assert.strictEqual(r.total, 1);
  assert.deepStrictEqual(r.path, [{ key: 'DEMO-5', summary: 'The epic' }]);
  assert.deepStrictEqual(r.me, ME);
  assert.deepStrictEqual(r.priorities.map((p) => p.id), ['2', '3']);
  assert.strictEqual(r.browseUrl, browseUrl('DEMO-1'));
  const file = path.join(s.dir, 'issues', 'DEMO-1.jira');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Sibling DEMO-2/);
  assert.deepStrictEqual(s.events.log.slice(0, 2), [['seen', 'DEMO-1'], ['save']]);
  assert.strictEqual(s.current(), text);
  assert.strictEqual(s.tickets.frontFile(), file);
});

test('open of a missing key shows error and records no seen', async () => {
  const s = setup({ issues: [] });
  const panel = await opened(s, 'DEMO-404');
  assert.strictEqual(posted(panel, 'loadError').length, 1);
  assert.match(posted(panel, 'loadError')[0].message, /does not exist/);
  assert.strictEqual(posted(panel, 'render').length, 0);
  assert.deepStrictEqual(s.events.log, []);
  assert.ok(!fs.existsSync(path.join(s.dir, 'issues', 'DEMO-404.jira')));
  assert.strictEqual(s.current(), null);
});

test('second open focuses the existing tab without fetching', async () => {
  const s = setup();
  const panel = await opened(s);
  const before = s.f.calls.length;
  panel._setView(true, false);
  s.tickets.open('DEMO-1');
  await settle();
  assert.strictEqual(ui.panels.length, 1);
  assert.strictEqual(panel.revealed, 1);
  assert.strictEqual(s.f.calls.length, before);
});

test('refreshVisible re-renders on change, posts stale while editing', async () => {
  const s = setup();
  const panel = await opened(s);
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 1, 'unchanged: no re-render');
  s.map.set('DEMO-1', iss('DEMO-1', { updated: '2026-11-18T10:00:00.000Z', summary: 'Renamed' }));
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 2);
  assert.strictEqual(posted(panel, 'render')[1].issue.summary, 'Renamed');
  assert.match(fs.readFileSync(path.join(s.dir, 'issues', 'DEMO-1.jira'), 'utf8'), /Renamed/);
  panel.webview._receive({ type: 'editing', on: true });
  s.map.set('DEMO-1', iss('DEMO-1', { updated: '2026-11-18T11:00:00.000Z', summary: 'Again' }));
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 2, 'editing: no re-render');
  assert.strictEqual(posted(panel, 'stale').length, 1);
});

test('save message goes through writer and re-renders on ok', async () => {
  const s = setup({ writerResult: { ok: true, value: doc('New') } });
  const panel = await opened(s);
  s.map.set('DEMO-1', iss('DEMO-1', { updated: '2026-11-18T10:00:00.000Z', description: doc('New') }));
  panel.webview._receive({ type: 'save', field: 'description', value: doc('New'), base: doc('Body') });
  await settle();
  assert.deepStrictEqual(s.w.calls[0], ['saveText', 'DEMO-1', 'description', doc('New'), doc('Body')]);
  assert.deepStrictEqual(posted(panel, 'pending'), [{ type: 'pending', op: 'description' }]);
  assert.deepStrictEqual(posted(panel, 'result'), [{ type: 'result', op: 'description', result: { ok: true, value: doc('New') } }]);
  const renders = posted(panel, 'render');
  assert.strictEqual(renders.length, 2);
  assert.deepStrictEqual(renders[1].issue.description, doc('New'));
  assert.match(s.current(), /New/);
});

test('a failed save posts the result and does not re-render', async () => {
  const s = setup({ writerResult: { ok: false, kind: 'conflict', message: 'Changed in Jira since you opened it' } });
  const panel = await opened(s);
  panel.webview._receive({ type: 'save', field: 'summary', value: 'Mine', base: 'Summary DEMO-1' });
  await settle();
  assert.strictEqual(posted(panel, 'result')[0].result.kind, 'conflict');
  assert.strictEqual(posted(panel, 'render').length, 1);
});

test('assignMe sets assignee to me', async () => {
  const s = setup();
  const panel = await opened(s);
  panel.webview._receive({ type: 'assignMe' });
  await settle();
  assert.deepStrictEqual(s.w.calls[0], ['setField', 'DEMO-1', 'assignee', 'acc-sean']);
  assert.deepStrictEqual(posted(panel, 'pending'), [{ type: 'pending', op: 'assignee' }]);
});

test('transitions, user search, comments and pickers go to the right calls', async () => {
  const s = setup();
  const panel = await opened(s);
  panel.webview._receive({ type: 'getTransitions' });
  panel.webview._receive({ type: 'searchUsers', requestId: 7, query: 'se', assignable: true });
  panel.webview._receive({ type: 'searchUsers', requestId: 8, query: 'se', assignable: false });
  await settle();
  assert.strictEqual(posted(panel, 'transitions')[0].list[0].id, '31');
  assert.deepStrictEqual(posted(panel, 'users').map((m) => m.requestId), [7, 8]);
  assert.deepStrictEqual(s.f.calls.filter((c) => c[0] === 'assignable' || c[0] === 'users'), [['assignable', 'DEMO-1', 'se'], ['users', 'se']]);
  panel.webview._receive({ type: 'transition', id: '31' }); await settle();
  panel.webview._receive({ type: 'set', field: 'labels', value: ['a', 'b'] }); await settle();
  panel.webview._receive({ type: 'comment', adf: doc('c') }); await settle();
  panel.webview._receive({ type: 'editComment', id: '10', adf: doc('d'), base: doc('hi') }); await settle();
  assert.deepStrictEqual(s.w.calls, [
    ['transition', 'DEMO-1', '31'], ['setField', 'DEMO-1', 'labels', ['a', 'b']],
    ['addComment', 'DEMO-1', doc('c')], ['editComment', 'DEMO-1', '10', doc('d'), doc('hi')],
  ]);
  panel.webview._receive({ type: 'openExternal' }); await settle();
  assert.deepStrictEqual(ui.opened, [browseUrl('DEMO-1')]);
});

test('a re-render with new content counts as seen only while visible in the focused window', async () => {
  const s = setup();
  const panel = await opened(s);
  const seen = () => s.events.log.filter((e) => e[0] === 'seen').length;
  assert.strictEqual(seen(), 1, 'opening and rendering counts');
  let n = 1;
  const moveOn = () => s.map.set('DEMO-1', iss('DEMO-1', { updated: `2026-11-18T1${n++}:00:00.000Z` }));
  // visible, window unfocused: re-rendered, not seen
  ui.focused = false; moveOn();
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 2);
  assert.strictEqual(seen(), 1, 'unfocused window: not seen');
  // focused window, tab not visible (a reload of a tab in the background): not seen
  ui.focused = true; panel.visible = false; moveOn();
  panel.webview._receive({ type: 'reload' }); await settle();
  assert.strictEqual(posted(panel, 'render').length, 3);
  assert.strictEqual(seen(), 1, 'not visible: not seen');
  // visible in the focused window: seen
  panel.visible = true; moveOn();
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 4);
  assert.strictEqual(seen(), 2);
});

test('dispose removes the issue file', async () => {
  const s = setup();
  const panel = await opened(s);
  const file = path.join(s.dir, 'issues', 'DEMO-1.jira');
  assert.ok(fs.existsSync(file));
  panel.dispose();
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(s.tickets.frontFile(), null);
});

test('not in front in a focused window: current.jira not written', async () => {
  const s = setup();
  ui.focused = false;
  const panel = await opened(s);
  assert.ok(fs.existsSync(path.join(s.dir, 'issues', 'DEMO-1.jira')));
  assert.strictEqual(s.current(), null);
  assert.deepStrictEqual(s.events.log, [['seen', 'DEMO-1'], ['save']], 'the render itself counts as seen');
  ui.setFocus(true);
  assert.match(s.current(), /DEMO-1/, 'focusing the window with the tab in front writes it');
  // a tab behind another one: its re-render does not take current.jira
  s.map.set('DEMO-2', iss('DEMO-2'));
  const p2 = await opened(s, 'DEMO-2');
  assert.match(s.current(), /DEMO-2:/);
  panel._setView(false, false);
  s.map.set('DEMO-1', iss('DEMO-1', { updated: '2026-11-18T10:00:00.000Z' }));
  panel.visible = true;   // visible in a split, but not the active one
  await s.tickets.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 2);
  assert.match(s.current(), /DEMO-2:/);
  void p2;
});

test('refreshVisible rethrows offline and throttling, so the tab poller backs off; logs the rest', async () => {
  const s = setup();
  await opened(s);
  const fail = (e) => { s.f.api.issue = async () => { throw e; }; };
  const err = (name, status) => Object.assign(new Error(name), { name, status });
  for (const e of [err('Offline'), err('JiraError', 429), err('JiraError', 503)]) { fail(e); await assert.rejects(s.tickets.refreshVisible(), (x) => x === e); }
  fail(err('JiraError', 500));
  await s.tickets.refreshVisible();
});

test('serializer restores a tab from its saved state', async () => {
  const s = setup();
  const panel = vscode.window.createWebviewPanel('jay.ticket', 'DEMO-1', 1, {});
  await ui.serializer.deserializeWebviewPanel(panel, { key: 'DEMO-1' });
  panel.webview._receive({ type: 'ready' }); await settle();
  assert.strictEqual(posted(panel, 'render').length, 1);
  s.tickets.disposeAll();
  assert.ok(panel.disposed);
});

test('a draft keeps its own base: another write landing first does not re-base it', async () => {
  const s = setup({ realWriter: true });
  const panel = await opened(s);
  // Sean opens the description editor (base: Body); meanwhile a colleague rewrites it, and Sean changes the priority
  s.map.set('DEMO-1', Object.assign({}, s.map.get('DEMO-1'), { description: doc('Theirs') }));
  panel.webview._receive({ type: 'set', field: 'priority', value: '2' }); await settle();
  assert.strictEqual(posted(panel, 'result')[0].result.ok, true);
  assert.deepStrictEqual(posted(panel, 'render').pop().issue.description, doc('Theirs'), 'the host re-read after the write');
  panel.webview._receive({ type: 'save', field: 'description', value: doc('Mine'), base: doc('Body') }); await settle();
  assert.strictEqual(posted(panel, 'result')[1].result.kind, 'conflict');
  assert.strictEqual(s.f.count('setFields'), 1, 'only the priority was sent');
  assert.deepStrictEqual(s.map.get('DEMO-1').description, doc('Theirs'));
});

test('a save without its base is refused', async () => {
  const s = setup();
  const panel = await opened(s);
  panel.webview._receive({ type: 'save', field: 'description', value: doc('x') }); await settle();
  assert.strictEqual(posted(panel, 'result')[0].result.kind, 'rejected');
  assert.strictEqual(s.w.calls.length, 0);
});

test('after a failed read-back the next write re-reads and sends nothing', async () => {
  const s = setup();
  const panel = await opened(s);
  const real = s.f.api.issue;
  s.f.api.issue = async () => { throw Object.assign(new Error('Offline'), { name: 'Offline' }); };
  panel.webview._receive({ type: 'set', field: 'labels', value: ['a'] }); await settle();
  s.f.api.issue = real;
  panel.webview._receive({ type: 'save', field: 'summary', value: 'New', base: 'Summary DEMO-1' }); await settle();
  assert.strictEqual(s.w.calls.length, 1, 'only the labels write was sent');
  const last = posted(panel, 'result').pop();
  assert.deepStrictEqual([last.op, last.result.ok, last.result.kind], ['summary', false, 'failed']);
  assert.strictEqual(posted(panel, 'render').length, 2, 're-read and re-rendered');
  panel.webview._receive({ type: 'save', field: 'summary', value: 'New', base: 'Summary DEMO-1' }); await settle();
  assert.strictEqual(s.w.calls.length, 2, 'Sean saving again sends it');
});

test('openExternal opens only https links', async () => {
  const s = setup();
  const panel = await opened(s);
  for (const url of ['javascript:alert(1)', 'http://x', 42, null]) panel.webview._receive({ type: 'openExternal', url });
  await settle();
  assert.deepStrictEqual(ui.opened, []);
  panel.webview._receive({ type: 'openExternal', url: 'https://example.com/a' }); await settle();
  assert.deepStrictEqual(ui.opened, ['https://example.com/a']);
});

test('a write before the tab has loaded is answered, not dropped', async () => {
  const s = setup();
  s.tickets.open('DEMO-1');
  const panel = ui.panels[ui.panels.length - 1];
  panel.webview._receive({ type: 'assignMe' });
  panel.webview._receive({ type: 'editComment', id: '10', adf: doc('x'), base: doc('hi') });
  await settle();
  assert.deepStrictEqual(posted(panel, 'result').map((m) => [m.op, m.result.kind, m.result.message]), [['assignee', 'failed', 'Not loaded yet'], ['comment:10', 'failed', 'Not loaded yet']]);
  assert.strictEqual(s.w.calls.length, 0);
});

test('one ticket key pattern: exported by ticket.js, used by the host, copied into the sidebar page', async () => {
  const { KEY_RE } = require('../src/ticket');
  assert.ok(KEY_RE instanceof RegExp);
  assert.strictEqual(KEY_RE.source, String.raw`^[A-Z][A-Z0-9_]+-\d+$`);
  for (const k of ['DEMO-1', 'AB_2-34', 'A1-9']) assert.ok(KEY_RE.test(k), k);
  for (const k of ['A-1', 'demo-1', 'DEMO-', '1A-2', 'DEMO-1 ']) assert.ok(!KEY_RE.test(k), k);
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.ok(!/KEY_RE\s*=\s*\//.test(src('src/extension.js')), 'the host defines no key pattern of its own');
  assert.ok(src('media/sidebar.js').includes('const KEY_RE = /' + KEY_RE.source + '/;'), 'the sidebar page has the same copy');
  // a tab's link to a one-letter "key" is not a key
  const s = setup();
  const panel = await opened(s);
  const n = ui.panels.length;
  panel.webview._receive({ type: 'open', key: 'A-1' }); await settle();
  assert.strictEqual(ui.panels.length, n);
});
