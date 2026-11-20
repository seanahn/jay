'use strict';
// Page tabs: each open Confluence page as a webview panel ('jay.page'), editable through pageWrites.js, mirrored to
// ~/.jay/pages/<SPACE>-<id>.confluence, and copied to current.confluence while it is in front in a focused window (design
// 102, "The page tab" and "How the agent knows the page in front"). The Confluence twin of ticket.js's TicketTab.
const crypto = require('crypto');
const { KEY_RE } = require('./ticket');
const { parsePageUrl } = require('./pageLinks');

const VIEW_TYPE = 'jay.page';
const ID_RE = /^\d+$/;
const NO_EDIT = "This sign-in can't edit Confluence";
const READ_ONLY = 'This page is read-only in jay: Edit in Confluence';
const WAITING = 'Waiting for sign-in…';
const messageOf = (e) => (e && Array.isArray(e.messages) && e.messages.length ? e.messages.join('; ') : (e && e.message) || 'Could not load this page');
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
// The op a write message's result is reported under.
const OP_OF = { save: () => 'page', comment: () => 'comment', reply: (m) => 'reply:' + m.parentId, editComment: (m) => 'comment:' + m.id };
const refuse = (kind, message) => ({ ok: false, kind, message, value: null });

/** Why a page can't be edited in jay, or null when it can. */
function readOnlyReason(page, access) {
  if (access !== 'full') return NO_EDIT;
  if (page.editor === 'v1' || page.adf === null) return 'legacy';
  if (page.subtype === 'live') return 'live';
  if (page.status && page.status !== 'current') return 'archived';   // archived (or any other non-current status)
  return null;
}
/** Every comment and reply, flat. */
const allComments = (list) => list.flatMap((c) => [c, ...(c.replies || [])]);

class PageTab {
  /** @param shell { webview, onDidDispose, onDidChangeViewState, reveal, setTitle(t), isActive(), isVisible(), dispose() } */
  constructor(owner, pageId, shell) {
    this.owner = owner; this.pageId = pageId; this.shell = shell;
    this.page = null; this.spaceKey = null; this.footer = []; this.inline = []; this.loaded = false;
    this.editing = false; this.reread = false; this.waiting = false; this.disposed = false; this.scrollTo = null;
    shell.webview.onDidReceiveMessage((m) => this.receive(m).catch((e) => owner.log(e)));
    shell.onDidChangeViewState(() => owner.viewChanged(this));
    shell.onDidDispose(() => owner.closed(this));
  }

  post(m) { if (!this.disposed) this.shell.webview.postMessage(m); }
  inFront() { return this.owner.front === this && this.shell.isActive() && this.owner.isFocused(); }
  reason() { return readOnlyReason(this.page, this.owner.access()); }

  /** Fetches the page and what goes with it; renders; mirrors. Throws if the page can't be read. */
  async load() {
    const got = await this.owner.fetchPage(this.pageId);
    if (this.disposed) return;
    const first = !this.loaded;
    const { page, space, path, names } = got;
    this.page = page; this.spaceKey = space.key; this.footer = got.footer; this.inline = got.inline;
    this.loaded = true; this.reread = false;
    this.shell.setTitle(page.title || page.id);
    const reason = this.reason();
    this.post({ type: 'render', page, path, space: { key: space.key, name: space.name }, names: Object.fromEntries(names), footer: got.footer, inline: got.inline,
      me: this.owner.me, editable: reason === null, readOnlyReason: reason, browseUrl: page.webUrl });
    if (this.scrollTo) { this.post({ type: 'scrollTo', commentId: this.scrollTo }); this.scrollTo = null; }
    const file = this.owner.mirror.write(got.view);
    // opening counts as shown; a re-render later only while Sean can see it
    if (first || (this.shell.isVisible() && this.owner.isFocused())) this.owner.onShown(this.pageId);
    if (this.inFront()) this.owner.mirror.setCurrent(file);
  }

  async show() {
    this.waiting = false;
    try { await this.load(); } catch (e) {
      this.owner.log(e);
      if (e && e.name === 'SignInNeeded') { this.waiting = true; this.post({ type: 'waiting', message: WAITING }); return; }
      this.post({ type: 'loadError', message: messageOf(e) });
    }
  }

  /** The 30 s poll: the version number only; the whole page when it moved on, or `stale` to an editing page. */
  async refresh() {
    if (!this.loaded || this.disposed) return;
    const n = await this.owner.confluence.currentVersion(this.pageId);
    if (n === this.page.version.number) return;
    if (this.editing) { this.post({ type: 'stale' }); return; }
    await this.load();
  }

  /** One write: pending, the writer's Result, then (on ok) a re-read and re-render. */
  async write(op, fn) {
    // the last read-back failed: re-read instead of sending, and let Sean decide again on what he now sees
    if (this.reread) {
      let message = 'The page was re-read first; not sent. Try again.';
      try { await this.load(); } catch (e) { this.owner.log(e); message = "Couldn't re-read the page — not sent"; }
      this.post({ type: 'result', op, result: refuse('failed', message) });
      return;
    }
    this.post({ type: 'pending', op });
    let result;
    try { result = await fn(); } catch (e) { this.owner.log(e); result = refuse('failed', messageOf(e)); }
    this.post({ type: 'result', op, result });
    if (!result.ok) return;
    try { await this.load(); } catch (e) { this.owner.log(e); this.reread = true; }
  }

  async openUrl(url) {
    if (!isHttps(url)) return;
    await this.owner.vscode.env.openExternal(this.owner.vscode.Uri.parse(url));
  }

  async receive(m) {
    if (!m || typeof m.type !== 'string') return;
    const { owner, pageId } = this;
    switch (m.type) {
      case 'ready': case 'reload': return this.show();
      case 'editing': this.editing = !!m.on; return;
      case 'open': if (KEY_RE.test(String(m.key))) await owner.vscode.commands.executeCommand('jay.openTicket', String(m.key)); return;
      case 'openExternal':
        if (m.url !== undefined) return this.openUrl(m.url);
        return this.page ? this.openUrl(this.page.webUrl) : undefined;
      case 'openPage': {
        const hit = typeof m.url === 'string' ? parsePageUrl(m.url, owner.siteUrl()) : null;
        if (hit) { await owner.open(hit.pageId, { commentId: hit.commentId }); return; }
        return this.openUrl(m.url);
      }
      case 'searchUsers': {
        let users = [];
        try { users = await owner.searchUsers(String(m.query || '')); } catch (e) { owner.log(e); }
        this.post({ type: 'users', requestId: m.requestId, users });
        return;
      }
    }
    const opOf = OP_OF[m.type];
    if (!opOf) return;
    const op = opOf(m);
    const answer = (kind, message) => this.post({ type: 'result', op, result: refuse(kind, message) });
    // No write before the tab has loaded; the page counts an op as pending once sent, so it always gets an answer.
    if (!this.loaded) return answer('failed', 'Not loaded yet');
    if (owner.access() !== 'full') return answer('rejected', NO_EDIT);
    if (!m.adf || typeof m.adf !== 'object' || Array.isArray(m.adf)) return answer('rejected', 'Nothing to save');
    const { writer } = owner;
    switch (m.type) {
      // The conflict base is the version the draft started from, sent by the page; never the host's latest read.
      case 'save': {
        if (this.reason() !== null) return answer('rejected', READ_ONLY);
        if (!Number.isInteger(m.base)) return answer('rejected', 'Missing the version the edit started from; reload');
        if (typeof m.title !== 'string' || !m.title.trim()) return answer('rejected', 'A page needs a title');
        return this.write(op, () => writer.savePage(pageId, { title: m.title.trim(), adf: m.adf, baseVersion: m.base }));
      }
      case 'comment': return this.write(op, () => writer.addComment(pageId, m.adf));
      case 'reply': {
        const kind = m.kind === 'inline' ? 'inline' : 'footer';
        if (!(kind === 'inline' ? this.inline : this.footer).some((c) => c.id === m.parentId)) return answer('rejected', 'That comment is no longer loaded; reload');
        return this.write(op, () => writer.reply(pageId, m.parentId, kind, m.adf));
      }
      case 'editComment': {
        const kind = m.kind === 'inline' ? 'inline' : 'footer';
        if (!Number.isInteger(m.base) || !('loaded' in m)) return answer('rejected', 'Missing the version the edit started from; reload');
        if (!allComments(kind === 'inline' ? this.inline : this.footer).some((c) => c.id === m.id)) return answer('rejected', 'That comment is no longer loaded; reload');
        return this.write(op, () => writer.editComment(pageId, m.id, kind, m.adf, m.base, m.loaded));
      }
    }
  }
}

/**
 * @param o.vscode, o.extensionUri
 * @param o.confluence, o.writer, o.mirror   see src/confluence.js, pageWrites.js, pageMirror.js
 * @param o.onShown(pageId)   a page tab loaded, or came to the front in the focused window
 * @param o.searchUsers(query) → Promise<[{ accountId, displayName }]>   for @-mentions
 * @param o.me           { accountId, displayName }
 * @param o.access()     'full' | 'read' | 'none': what this sign-in may do in Confluence
 * @param o.isFocused()  whether this window has focus
 * @param o.siteUrl()    the site, for telling Confluence links from others
 */
function createPages(o) {
  const { vscode, extensionUri } = o;
  const tabs = new Map();
  const owner = {
    vscode, confluence: o.confluence, writer: o.writer, mirror: o.mirror, me: o.me, front: null,
    access: () => o.access(), siteUrl: () => o.siteUrl(), searchUsers: (q) => o.searchUsers(q),
    isFocused: () => (o.isFocused ? o.isFocused() : vscode.window.state.focused),
    log: o.log || (() => {}),
    onShown: (id) => { if (o.onShown) o.onShown(id); },
    open,
    /** The page, its space, path, first children, comments and names, as a tab shows and mirrors them. */
    async fetchPage(id) {
      const c = o.confluence;
      const page = await c.page(id);
      const tolerate = async (fn, d) => { try { return await fn(); } catch (e) { owner.log(e); return d; } };
      const ids = page.ancestors.map((a) => a.id);
      const [space, titles, kids, footer, inline] = await Promise.all([
        c.space(page.spaceId), ids.length ? tolerate(() => c.titles(ids), new Map()) : new Map(),
        tolerate(() => c.children(page.id, 'page'), { items: [] }), c.footerComments(id), c.inlineComments(id)]);
      const who = [page.authorId, page.version && page.version.authorId, ...allComments(footer).map((x) => x.authorId), ...allComments(inline).map((x) => x.authorId)];
      const users = await tolerate(() => c.users([...new Set(who.filter(Boolean))]), new Map());
      const names = new Map([...users].map(([k, u]) => [k, u.displayName]));
      const site = o.siteUrl();
      const path = ids.map((a) => ({ id: a, title: titles.get(a) || '…', url: `${site}/wiki/spaces/${encodeURIComponent(space.key)}/pages/${a}` }));
      const children = kids.items.map((k) => ({ id: k.id, title: k.title }));
      const view = { page, spaceKey: space.key, spaceName: space.name, path, children, footer, inline, names,
        footerTotal: Number.isInteger(footer.total) ? footer.total : footer.length,
        authorName: names.get(page.authorId), editorName: page.version ? names.get(page.version.authorId) : undefined };
      return { page, space, path, names, footer, inline, view };
    },
    viewChanged(tab) {
      if (!tab.shell.isActive()) return;
      owner.front = tab;
      if (tab.loaded && owner.isFocused()) toFront(tab);
    },
    closed(tab) {
      tab.disposed = true;
      if (tabs.get(tab.pageId) === tab) tabs.delete(tab.pageId);
      if (owner.front === tab) owner.front = null;
      if (tab.spaceKey) o.mirror.closed(tab.spaceKey, tab.pageId);
    },
  };

  function toFront(tab) {
    owner.onShown(tab.pageId);
    const file = o.mirror.pathFor(tab.spaceKey, tab.pageId);
    if (file) o.mirror.setCurrent(file);
  }

  function html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const src = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const csp = webview.cspSource;
    const scripts = ['prosemirror.js', 'adfPm.js', 'ticketEditor.js', 'page.js'].map((f) => `<script nonce="${nonce}" src="${src(f)}"></script>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; img-src ${csp} data:; font-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${src('ticket.css')}"><link rel="stylesheet" href="${src('page.css')}"></head><body>${scripts}</body></html>`;
  }

  function attach(panel, pageId) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
    const tab = new PageTab(owner, pageId, {
      webview: panel.webview, onDidDispose: panel.onDidDispose, onDidChangeViewState: panel.onDidChangeViewState,
      reveal: () => panel.reveal(), setTitle: (t) => { panel.title = t; },
      isActive: () => !!panel.active, isVisible: () => !!panel.visible, dispose: () => panel.dispose(),
    });
    tabs.set(pageId, tab);
    owner.front = tab;
    panel.webview.html = html(panel.webview);
    return tab;
  }

  /** Opens (or focuses) the page's tab, scrolled to commentId when given. False when jay can't: no Confluence, or not a page id. */
  async function open(pageId, { commentId } = {}) {
    const id = String(pageId);
    if (!ID_RE.test(id) || o.access() === 'none') return false;
    const have = tabs.get(id);
    if (have) {
      have.shell.reveal();
      if (commentId) { if (have.loaded) have.post({ type: 'scrollTo', commentId: String(commentId) }); else have.scrollTo = String(commentId); }
      return true;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Confluence page', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const tab = attach(panel, id);
    if (commentId) tab.scrollTo = String(commentId);
    return true;
  }

  const registration = vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state) {
      const id = state && String(state.pageId);
      if (!id || !ID_RE.test(id) || tabs.has(id)) { panel.dispose(); return; }
      attach(panel, id);
    },
  });
  const focusSub = vscode.window.onDidChangeWindowState((s) => {
    const tab = owner.front;
    if (s.focused && tab && tab.loaded && tab.shell.isActive()) toFront(tab);
  });

  return {
    open,
    /** Whether jay has a tab open for the page. */
    has: (pageId) => tabs.has(String(pageId)),
    async refreshVisible() {
      for (const tab of [...tabs.values()]) {
        if (!tab.shell.isVisible()) continue;
        // offline and throttling go back to the tab poller, which backs off; the rest is logged
        try { await tab.refresh(); } catch (e) { if (e && (e.name === 'Offline' || e.status === 429 || e.status === 503)) throw e; owner.log(e); }
      }
    },
    /** The file of the page tab most recently in front in this window, while it is open and on screen. */
    frontFile() {
      const t = owner.front;
      if (!t || t.disposed || !t.loaded || !t.shell.isVisible()) return null;
      return o.mirror.pathFor(t.spaceKey, t.pageId);
    },
    /** Loads the tabs that were waiting for a sign-in. */
    resumeWaiting() { for (const tab of [...tabs.values()]) if (tab.waiting && !tab.disposed) tab.show(); },
    /** Confluence is not available with this sign-in: the waiting tabs say so; they still load if it comes back (resumeWaiting). */
    unavailable(message) { for (const tab of [...tabs.values()]) if (tab.waiting && !tab.disposed) tab.post({ type: 'loadError', message }); },
    disposeAll() { for (const tab of [...tabs.values()]) tab.shell.dispose(); },
    dispose() { registration.dispose(); focusSub.dispose(); },
  };
}

module.exports = { createPages, VIEW_TYPE, readOnlyReason };
