'use strict';
// The jay sidebar: a webview view, because the built-in tree can't bold or pulse a row (design 101, "The sidebar").
const vscode = require('vscode');
const crypto = require('crypto');

class Sidebar {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.state = {};
    this.handlers = [];
    this.badge = 0;
    this.title = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sidebar.js'));
    const csp = view.webview.cspSource;
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') this.post();
      else for (const fn of this.handlers) fn(m);
    });
    this.applyBadge();
    if (this.title !== null) view.title = this.title;
    this.post();
  }

  /** New state. Unset keys keep their last value. */
  update(next) {
    Object.assign(this.state, next);
    this.post();
  }

  post() {
    if (this.view) this.view.webview.postMessage(Object.assign({}, this.state, { type: 'state' }));
  }

  /** A one-off message to the page (not part of the state). */
  reply(m) { if (this.view) this.view.webview.postMessage(m); }

  onMessage(fn) { this.handlers.push(fn); }

  setBadge(n) {
    this.badge = n;
    this.applyBadge();
  }

  applyBadge() {
    // 0 clears the badge as { value: 0 }: VS Code ignores an undefined badge on webview views
    if (this.view) this.view.badge = { value: this.badge || 0, tooltip: this.badge ? `${this.badge} new` : '' };
  }

  /** The view's title (the header above the page): Jira or Confluence, after the side shown. Kept until the view resolves. */
  setTitle(t) {
    this.title = t;
    if (this.view) this.view.title = t;
  }

  focusSearch() {
    if (!this.view) return;
    if (this.view.show) this.view.show(false);
    this.view.webview.postMessage({ type: 'focusSearch' });
  }
}

module.exports = { Sidebar };
