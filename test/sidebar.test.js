'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { install } = require('./vscodeStub');
const { ui } = install();
const { Sidebar } = require('../src/sidebar');
const vscode = require('vscode');

function boot() {
  const s = new Sidebar(vscode.Uri.file('/ext'));
  vscode.window.registerWebviewViewProvider('jay.sidebar', s);
  return { s, view: ui.resolveSidebar() };
}

test('html carries a CSP with a nonce and the two media files', () => {
  const { view } = boot();
  assert.match(view.webview.html, /script-src 'nonce-[^']+'/);
  assert.match(view.webview.html, /sidebar\.css/);
  assert.match(view.webview.html, /sidebar\.js/);
  assert.strictEqual(view.webview.options.enableScripts, true);
});

test('update posts the merged state; ready re-posts it', () => {
  const { s, view } = boot();
  s.update({ signedIn: true, project: 'DEMO' });
  s.update({ mode: 'mine' });
  const last = () => view.webview.posted[view.webview.posted.length - 1];
  assert.deepStrictEqual([last().type, last().signedIn, last().project, last().mode], ['state', true, 'DEMO', 'mine']);
  const n = view.webview.posted.length;
  view.webview._receive({ type: 'ready' });
  assert.strictEqual(view.webview.posted.length, n + 1);
  assert.strictEqual(last().project, 'DEMO');
});

test('page messages go to onMessage handlers', () => {
  const { s, view } = boot();
  const got = []; s.onMessage((m) => got.push(m));
  view.webview._receive({ type: 'setMode', mode: 'all' });
  view.webview._receive({ type: 'open', key: 'DEMO-1' });
  view.webview._receive(null);
  assert.deepStrictEqual(got, [{ type: 'setMode', mode: 'all' }, { type: 'open', key: 'DEMO-1' }]);
});

test('setBadge sets and clears the view badge', () => {
  const { s, view } = boot();
  s.setBadge(3);
  assert.deepStrictEqual(view.badge, { value: 3, tooltip: '3 new' });
  s.setBadge(0);
  assert.strictEqual(view.badge, undefined);
});

test('setBadge before the view exists is applied when it resolves', () => {
  const s = new Sidebar(vscode.Uri.file('/ext'));
  s.setBadge(2);
  vscode.window.registerWebviewViewProvider('jay.sidebar', s);
  assert.strictEqual(ui.resolveSidebar().badge.value, 2);
});

test('focusSearch shows the view and tells the page', () => {
  const { s, view } = boot();
  let shown = 0; view.show = () => { shown++; };
  s.focusSearch();
  assert.strictEqual(shown, 1);
  assert.deepStrictEqual(view.webview.posted.pop(), { type: 'focusSearch' });
});

test('setTitle sets the view title, also when set before the view resolves', () => {
  const s = new Sidebar(vscode.Uri.file('/ext'));
  s.setTitle('Confluence');
  vscode.window.registerWebviewViewProvider('jay.sidebar', s);
  const view = ui.resolveSidebar();
  assert.strictEqual(view.title, 'Confluence');
  s.setTitle('Jira');
  assert.strictEqual(view.title, 'Jira');
});
