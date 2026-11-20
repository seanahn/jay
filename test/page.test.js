'use strict';
// The page tab's host side: panels from the vscode stub, a scripted fake Confluence and writer, a real page mirror in a temp dir.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { install } = require('./vscodeStub');

const { vscode, ui } = install();
const { createPages, VIEW_TYPE } = require('../src/page');
const { createPageMirror } = require('../src/pageMirror');

const SITE = 'https://example.atlassian.net';
const doc = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const ME = { accountId: 'acc-ann', displayName: 'Ann Example' };
const pg = (o = {}) => ({
  id: '1001', spaceId: '2001', title: 'Demo Home', status: 'current', subtype: null,
  version: { number: 12, authorId: 'acc-bo', createdAt: '2026-11-01T10:00:00.000Z' }, authorId: 'acc-ann', createdAt: '2025-01-02T03:04:05.000Z',
  parentId: '1000', adf: doc('Hello from DEMO'), webUrl: `${SITE}/wiki/spaces/DEMO/pages/1001/Demo+Home`, tinyUrl: `${SITE}/wiki/x/AbCd`,
  ancestors: [{ id: '999' }, { id: '1000' }], editor: 'v2', ...o,
});
const comment = (id, who, t, o = {}) => ({ id, kind: 'footer', authorId: who, createdAt: '2026-11-02T10:00:00.000Z', version: 1, adf: doc(t), replies: [], ...o });
const settle = () => new Promise((r) => setTimeout(r, 15));
const httpError = (status, msg) => Object.assign(new Error(msg), { name: 'JiraError', status, messages: [msg] });

function fakeConfluence(pages) {
  const calls = [];
  const rec = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const c = {
    page: rec('page', (id) => { const p = pages.get(id); if (p instanceof Error) throw p; if (!p) throw httpError(404, 'Page not found'); return JSON.parse(JSON.stringify(p)); }),
    currentVersion: rec('currentVersion', (id) => pages.get(id).version.number),
    space: rec('space', () => ({ id: '2001', key: 'DEMO', name: 'Demo Space', type: 'global', homepageId: '999' })),
    titles: rec('titles', (ids) => new Map(ids.filter((i) => i === '999').map((i) => [i, 'Demo Space Home']))),
    children: rec('children', () => ({ items: [{ id: '1003', kind: 'page', title: 'Child page', position: 0 }], next: null })),
    footerComments: rec('footerComments', () => [comment('c1', 'acc-bo', 'Looks good', { replies: [comment('c2', 'acc-ann', 'Thanks')] })]),
    inlineComments: rec('inlineComments', () => [comment('i1', 'acc-bo', 'Typo?', { kind: 'inline', quote: 'Hello', resolved: false })]),
    users: rec('users', (ids) => new Map(ids.filter((i) => i === 'acc-ann' || i === 'acc-bo').map((i) => [i, { accountId: i, displayName: i === 'acc-ann' ? 'Ann Example' : 'Bo Sample' }]))),
  };
  return { c, calls, count: (n) => calls.filter((x) => x[0] === n).length };
}
function fakeWriter(result = { ok: true, kind: null, message: null, value: { version: 13 } }) {
  const calls = [];
  const w = { pending: () => false };
  for (const n of ['savePage', 'addComment', 'reply', 'editComment']) w[n] = async (...a) => { calls.push([n, ...a]); return result; };
  return { writer: w, calls };
}

function setup({ pages = [pg()], access = 'full', writerResult } = {}) {
  ui.panels.length = 0; ui.focused = true; ui.opened.length = 0; ui.executed.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-page-'));
  const map = new Map(pages.map((p) => [p.id, p]));
  const f = fakeConfluence(map); const w = fakeWriter(writerResult);
  const shown = []; const searched = [];
  const mirror = createPageMirror({ dir });
  const pagesApi = createPages({
    vscode, extensionUri: vscode.Uri.file('/ext'), confluence: f.c, writer: w.writer, mirror, me: ME,
    onShown: (id) => shown.push(id), searchUsers: async (q) => { searched.push(q); return [{ accountId: 'acc-bo', displayName: 'Bo Sample' }]; },
    access: () => access, isFocused: () => ui.focused, siteUrl: () => SITE,
  });
  const file = path.join(dir, 'pages', 'DEMO-1001.confluence');
  return { dir, map, f, w, shown, searched, mirror, pages: pagesApi, file, current: () => { try { return fs.readFileSync(path.join(dir, 'current.confluence'), 'utf8'); } catch (_) { return null; } } };
}
async function opened(s, id = '1001', o) {
  const ok = await s.pages.open(id, o);
  assert.strictEqual(ok, true);
  const panel = ui.panels[ui.panels.length - 1];
  panel.webview._receive({ type: 'ready' });
  await settle();
  return panel;
}
const posted = (panel, type) => panel.webview.posted.filter((m) => m.type === type);
const bump = (s, o = {}) => s.map.set('1001', pg({ version: { number: 13, authorId: 'acc-bo', createdAt: '2026-11-03T10:00:00.000Z' }, ...o }));

test('open creates one panel titled with the page, renders it and writes the agent file', async () => {
  const s = setup();
  const panel = await opened(s);
  assert.strictEqual(panel.viewType, VIEW_TYPE);
  assert.strictEqual(VIEW_TYPE, 'jay.page');
  assert.strictEqual(panel.title, 'Demo Home');
  assert.strictEqual(panel.options.retainContextWhenHidden, true);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  assert.match(panel.webview.html, /page\.js/);
  const [r] = posted(panel, 'render');
  assert.strictEqual(r.page.id, '1001');
  assert.deepStrictEqual(r.space, { key: 'DEMO', name: 'Demo Space' });
  assert.deepStrictEqual(r.path, [
    { id: '999', title: 'Demo Space Home', url: `${SITE}/wiki/spaces/DEMO/pages/999` },
    { id: '1000', title: '…', url: `${SITE}/wiki/spaces/DEMO/pages/1000` },
  ]);
  assert.deepStrictEqual(r.names, { 'acc-ann': 'Ann Example', 'acc-bo': 'Bo Sample' });
  assert.deepStrictEqual(r.footer.map((c) => c.id), ['c1']);
  assert.deepStrictEqual(r.inline.map((c) => c.id), ['i1']);
  assert.deepStrictEqual(r.me, ME);
  assert.strictEqual(r.editable, true);
  assert.strictEqual(r.readOnlyReason, null);
  assert.strictEqual(r.browseUrl, pg().webUrl);
  const text = fs.readFileSync(s.file, 'utf8');
  assert.match(text, /Confluence page 1001: Demo Home/);
  assert.match(text, /Path: Demo Space Home › …/);
  assert.match(text, /Child page \(1003\)/);
  assert.match(text, /Bo Sample:\n  Looks good/);
  assert.strictEqual(s.current(), text);
  assert.strictEqual(s.pages.frontFile(), s.file);
  assert.deepStrictEqual(s.shown, ['1001']);
  assert.ok(s.pages.has('1001'));
  // again: the same tab, revealed, nothing fetched
  const before = s.f.calls.length;
  panel._setView(true, false);
  assert.strictEqual(await s.pages.open('1001'), true);
  assert.strictEqual(ui.panels.length, 1);
  assert.strictEqual(panel.revealed, 1);
  assert.strictEqual(s.f.calls.length, before);
});

test('a 404 or 403 posts loadError and writes no file', async () => {
  for (const [status, msg] of [[404, 'Page not found'], [403, 'Not permitted']]) {
    const s = setup();
    s.map.set('1001', httpError(status, msg));
    const panel = await opened(s);
    assert.deepStrictEqual(posted(panel, 'loadError').map((m) => m.message), [msg]);
    assert.strictEqual(posted(panel, 'render').length, 0);
    assert.ok(!fs.existsSync(s.file));
    assert.strictEqual(s.current(), null);
    assert.deepStrictEqual(s.shown, []);
    assert.strictEqual(s.pages.frontFile(), null);
    panel.dispose();
  }
});

test('the 30 s refresh: unchanged posts nothing, new while editing posts stale, new while not editing re-renders', async () => {
  const s = setup();
  const panel = await opened(s);
  const n = panel.webview.posted.length;
  await s.pages.refreshVisible();
  assert.strictEqual(panel.webview.posted.length, n, 'unchanged: nothing posted');
  assert.strictEqual(s.f.count('page'), 1, 'only the version number was read');
  panel.webview._receive({ type: 'editing', on: true });
  bump(s, { title: 'Renamed' });
  await s.pages.refreshVisible();
  assert.strictEqual(posted(panel, 'stale').length, 1);
  assert.strictEqual(posted(panel, 'render').length, 1, 'editing: no re-render');
  panel.webview._receive({ type: 'editing', on: false });
  await s.pages.refreshVisible();
  assert.strictEqual(posted(panel, 'render').length, 2);
  assert.strictEqual(posted(panel, 'render')[1].page.title, 'Renamed');
  assert.strictEqual(panel.title, 'Renamed');
  assert.match(fs.readFileSync(s.file, 'utf8'), /Renamed/);
});

test('refreshVisible rethrows offline and throttling for the poller; logs the rest', async () => {
  const s = setup();
  await opened(s);
  const err = (name, status) => Object.assign(new Error(name), { name, status });
  for (const e of [err('Offline'), err('JiraError', 429), err('JiraError', 503)]) {
    s.f.c.currentVersion = async () => { throw e; };
    await assert.rejects(s.pages.refreshVisible(), (x) => x === e);
  }
  s.f.c.currentVersion = async () => { throw err('JiraError', 500); };
  await s.pages.refreshVisible();
});

test('save with base 12 calls savePage, posts pending then result, then reloads on ok', async () => {
  const s = setup();
  const panel = await opened(s);
  bump(s, { title: 'New title', adf: doc('New body') });
  panel.webview._receive({ type: 'save', title: 'New title', adf: doc('New body'), base: 12 });
  await settle();
  assert.deepStrictEqual(s.w.calls, [['savePage', '1001', { title: 'New title', adf: doc('New body'), baseVersion: 12 }]]);
  const ops = panel.webview.posted.filter((m) => m.type === 'pending' || m.type === 'result');
  assert.deepStrictEqual(ops.map((m) => [m.type, m.op]), [['pending', 'page'], ['result', 'page']]);
  assert.strictEqual(ops[1].result.ok, true);
  const renders = posted(panel, 'render');
  assert.strictEqual(renders.length, 2);
  assert.strictEqual(renders[1].page.version.number, 13);
  assert.match(s.current(), /New body/);
});

test('a conflict is posted and nothing is re-read', async () => {
  const s = setup({ writerResult: { ok: false, kind: 'conflict', message: 'Changed in Confluence since you opened it', value: null } });
  const panel = await opened(s);
  panel.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 });
  await settle();
  assert.strictEqual(posted(panel, 'result')[0].result.kind, 'conflict');
  assert.strictEqual(posted(panel, 'render').length, 1);
});

test('no write when this sign-in cannot edit Confluence', async () => {
  const s = setup({ access: 'read' });
  const panel = await opened(s);
  const [r] = posted(panel, 'render');
  assert.deepStrictEqual([r.editable, r.readOnlyReason], [false, "This sign-in can't edit Confluence"]);
  panel.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 });
  panel.webview._receive({ type: 'comment', adf: doc('c') });
  await settle();
  assert.deepStrictEqual(posted(panel, 'result').map((m) => [m.op, m.result.ok, m.result.kind, m.result.message]), [
    ['page', false, 'rejected', "This sign-in can't edit Confluence"], ['comment', false, 'rejected', "This sign-in can't edit Confluence"]]);
  assert.deepStrictEqual(s.w.calls, []);
});

test('legacy, unconvertible, live and archived pages render read-only and refuse a save', async () => {
  for (const [o, reason] of [[{ editor: 'v1' }, 'legacy'], [{ adf: null }, 'legacy'], [{ subtype: 'live' }, 'live'], [{ status: 'archived' }, 'archived']]) {
    const s = setup({ pages: [pg(o)] });
    const panel = await opened(s);
    const [r] = posted(panel, 'render');
    assert.deepStrictEqual([r.editable, r.readOnlyReason], [false, reason], JSON.stringify(o));
    panel.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 });
    await settle();
    assert.deepStrictEqual(posted(panel, 'result').map((m) => [m.op, m.result.kind]), [['page', 'rejected']]);
    assert.deepStrictEqual(s.w.calls, []);
    panel.dispose();
  }
});

test('a save without a numeric base, or before the tab has loaded, is answered and not sent', async () => {
  const s = setup();
  await s.pages.open('1001');
  const early = ui.panels[0];
  early.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 });
  early.webview._receive({ type: 'editComment', id: 'c2', kind: 'footer', adf: doc('x'), base: 1, loaded: doc('Thanks') });
  await settle();
  assert.deepStrictEqual(posted(early, 'result').map((m) => [m.op, m.result.message]), [['page', 'Not loaded yet'], ['comment:c2', 'Not loaded yet']]);
  early.webview._receive({ type: 'ready' }); await settle();
  early.webview._receive({ type: 'save', title: 'T', adf: doc('x') });
  early.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: '12' });
  early.webview._receive({ type: 'save', title: '  ', adf: doc('x'), base: 12 });
  early.webview._receive({ type: 'comment', adf: 'not adf' });
  await settle();
  assert.deepStrictEqual(posted(early, 'result').slice(2).map((m) => [m.op, m.result.kind]), [['page', 'rejected'], ['page', 'rejected'], ['page', 'rejected'], ['comment', 'rejected']]);
  assert.deepStrictEqual(s.w.calls, []);
});

test('comments, replies and comment edits go to the writer under their ops', async () => {
  const s = setup();
  const panel = await opened(s);
  panel.webview._receive({ type: 'comment', adf: doc('c') }); await settle();
  panel.webview._receive({ type: 'reply', parentId: 'i1', kind: 'inline', adf: doc('r') }); await settle();
  panel.webview._receive({ type: 'editComment', id: 'c2', kind: 'footer', adf: doc('e'), base: 1, loaded: doc('Thanks') }); await settle();
  panel.webview._receive({ type: 'editComment', id: 'nope', kind: 'footer', adf: doc('e'), base: 1, loaded: doc('x') }); await settle();
  assert.deepStrictEqual(s.w.calls, [
    ['addComment', '1001', doc('c')], ['reply', '1001', 'i1', 'inline', doc('r')], ['editComment', '1001', 'c2', 'footer', doc('e'), 1, doc('Thanks')]]);
  assert.deepStrictEqual(posted(panel, 'pending').map((m) => m.op), ['comment', 'reply:i1', 'comment:c2']);
  assert.deepStrictEqual(posted(panel, 'result').pop(), { type: 'result', op: 'comment:nope', result: { ok: false, kind: 'rejected', message: 'That comment is no longer loaded; reload', value: null } });
});

test('after a failed read-back the next write re-reads and sends nothing', async () => {
  const s = setup();
  const panel = await opened(s);
  const real = s.f.c.page;
  s.f.c.page = async () => { throw Object.assign(new Error('Offline'), { name: 'Offline' }); };
  panel.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 }); await settle();
  s.f.c.page = real;
  panel.webview._receive({ type: 'save', title: 'T', adf: doc('x'), base: 12 }); await settle();
  assert.strictEqual(s.w.calls.length, 1);
  assert.deepStrictEqual([posted(panel, 'result').pop().result.kind], ['failed']);
  assert.strictEqual(posted(panel, 'render').length, 2, 're-read and re-rendered');
});

test('links: Confluence pages open in jay with their comment, other https links in the browser, Jira keys as tickets', async () => {
  const s = setup({ pages: [pg(), pg({ id: '1002', title: 'Other' })] });
  const panel = await opened(s);
  panel.webview._receive({ type: 'openPage', url: `${SITE}/wiki/spaces/DEMO/pages/1002/Other?focusedCommentId=77` }); await settle();
  assert.strictEqual(ui.panels.length, 2);
  const other = ui.panels[1];
  other.webview._receive({ type: 'ready' }); await settle();
  assert.strictEqual(posted(other, 'render')[0].page.id, '1002');
  assert.deepStrictEqual(posted(other, 'scrollTo'), [{ type: 'scrollTo', commentId: '77' }]);
  for (const url of ['https://example.com/a', 'javascript:alert(1)', 'http://x', 42]) panel.webview._receive({ type: 'openPage', url });
  panel.webview._receive({ type: 'openExternal', url: 'file:///etc/passwd' });
  panel.webview._receive({ type: 'openExternal' });
  await settle();
  assert.deepStrictEqual(ui.opened, ['https://example.com/a', pg().webUrl]);
  panel.webview._receive({ type: 'open', key: 'DEMO-7' });
  panel.webview._receive({ type: 'open', key: 'not a key' });
  await settle();
  assert.deepStrictEqual(ui.executed, [['jay.openTicket', 'DEMO-7']]);
  // an open tab asked for a comment scrolls to it
  await s.pages.open('1001', { commentId: 'c1' }); await settle();
  assert.deepStrictEqual(posted(panel, 'scrollTo'), [{ type: 'scrollTo', commentId: 'c1' }]);
});

test('open refuses what is not a page id, and works only with a Confluence sign-in', async () => {
  const s = setup({ access: 'none' });
  assert.strictEqual(await s.pages.open('1001'), false);
  const t = setup();
  assert.strictEqual(await t.pages.open('../1001'), false);
  assert.strictEqual(ui.panels.length, 0);
});

test('searchUsers answers with users and the request id', async () => {
  const s = setup();
  const panel = await opened(s);
  panel.webview._receive({ type: 'searchUsers', query: 'bo', requestId: 4 }); await settle();
  assert.deepStrictEqual(s.searched, ['bo']);
  assert.deepStrictEqual(posted(panel, 'users'), [{ type: 'users', requestId: 4, users: [{ accountId: 'acc-bo', displayName: 'Bo Sample' }] }]);
});

test('current.confluence and onShown follow the tab in front of the focused window; closing removes the file', async () => {
  const s = setup({ pages: [pg(), pg({ id: '1002', title: 'Other' })] });
  ui.focused = false;
  const panel = await opened(s);
  assert.ok(fs.existsSync(s.file));
  assert.strictEqual(s.current(), null, 'unfocused: not current');
  assert.deepStrictEqual(s.shown, ['1001'], 'loading counts as shown');
  ui.setFocus(true);
  assert.match(s.current(), /page 1001/);
  assert.deepStrictEqual(s.shown, ['1001', '1001']);
  const other = await opened(s, '1002');
  assert.match(s.current(), /page 1002/);
  panel._setView(true, true);
  assert.match(s.current(), /page 1001/);
  assert.deepStrictEqual(s.shown.slice(-1), ['1001']);
  panel.dispose();
  assert.ok(!fs.existsSync(s.file));
  assert.strictEqual(s.pages.has('1001'), false);
  void other;
});

test('a tab waiting for sign-in loads on resumeWaiting; the serializer restores tabs', async () => {
  const s = setup();
  s.map.set('1001', Object.assign(new Error('sign in'), { name: 'SignInNeeded' }));
  const panel = await opened(s);
  assert.strictEqual(posted(panel, 'waiting').length, 1);
  s.map.set('1001', pg());
  s.pages.resumeWaiting(); await settle();
  assert.strictEqual(posted(panel, 'render').length, 1);
  s.pages.disposeAll();
  assert.ok(panel.disposed);
  const restored = vscode.window.createWebviewPanel('jay.page', 'Demo Home', 1, {});
  await ui.serializer.deserializeWebviewPanel(restored, { pageId: '1001' });
  restored.webview._receive({ type: 'ready' }); await settle();
  assert.strictEqual(posted(restored, 'render').length, 1);
  const bad = vscode.window.createWebviewPanel('jay.page', 'x', 1, {});
  await ui.serializer.deserializeWebviewPanel(bad, { pageId: 'x/../1' });
  assert.ok(bad.disposed);
  s.pages.dispose();
});

test('the agent file says newest 50 of 60 when footerComments saw 60', async () => {
  const s = setup();
  s.f.c.footerComments = async () => Object.assign(Array.from({ length: 50 }, (_, i) => comment('c' + i, 'acc-bo', 'n' + i)), { total: 60 });
  await opened(s);
  assert.ok(fs.readFileSync(s.file, 'utf8').includes('## Comments (newest 50 of 60)\n'));
});

test("unavailable(): waiting tabs get a loadError with the Confluence-unavailable copy; loaded tabs are left alone", async () => {
  const s = setup({ pages: [pg(), pg({ id: '1002', title: 'Other' })] });
  const loaded = await opened(s, '1002');
  s.map.set('1001', Object.assign(new Error('sign in'), { name: 'SignInNeeded' }));
  const waiting = await opened(s);
  assert.strictEqual(posted(waiting, 'waiting').length, 1);
  s.pages.unavailable("Confluence isn't available with this sign-in");
  assert.deepStrictEqual(posted(waiting, 'loadError').map((m) => m.message), ["Confluence isn't available with this sign-in"]);
  assert.strictEqual(posted(loaded, 'loadError').length, 0);
  s.map.set('1001', pg());
  s.pages.resumeWaiting(); await settle();
  assert.strictEqual(posted(waiting, 'render').length, 1, 'Confluence coming back (a later probe) still loads it');
  s.pages.disposeAll(); s.pages.dispose();
});
