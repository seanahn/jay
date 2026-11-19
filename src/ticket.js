'use strict';
// Ticket tabs: each open Jira ticket as a webview panel ('jay.ticket'), editable through writes.js, mirrored to
// ~/.jay/issues/<KEY>.jira, and copied to current.jira while it is in front in a focused window (design 101, "The ticket
// tab" and "How the agent knows the ticket in front"). The shell is a webview panel (Task 2 decision); everything else goes
// through one TicketTab, given { webview, onDidDispose, onDidChangeViewState, reveal } and the panel's view state.
const crypto = require('crypto');
const { chainOf } = require('./tree');

const VIEW_TYPE = 'jay.ticket';
// A Jira issue key: the one pattern jay uses (the host here and in extension.js; media/sidebar.js keeps a copy)
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const TEXT_FIELDS = new Set(['summary', 'description']);
const SET_FIELDS = new Set(['assignee', 'priority', 'duedate', 'labels']);
const MAX_PARENTS = 10;
const messageOf = (e) => (e && Array.isArray(e.messages) && e.messages.length ? e.messages.join('; ') : (e && e.message) || 'Could not load this ticket');
// The op a write message's result is reported under.
const OP_OF = {
  save: (m) => String(m.field), comment: () => 'comment', editComment: (m) => 'comment:' + m.id, set: (m) => String(m.field),
  assignMe: () => 'assignee', transition: () => 'transition',
};
const WAITING = 'Waiting for sign-in…';
const crumb = (i) => ({ key: i.key, summary: i.summary });

class TicketTab {
  /** @param shell { webview, onDidDispose, onDidChangeViewState, reveal, isActive(), isVisible(), dispose() } */
  constructor(owner, key, shell) {
    this.owner = owner; this.key = key; this.shell = shell;
    this.issue = null; this.comments = []; this.total = 0; this.loaded = false;
    this.editing = false; this.reread = false; this.transitionList = []; this.waiting = false;
    this.disposed = false;
    shell.webview.onDidReceiveMessage((m) => this.receive(m).catch((e) => owner.log(e)));
    shell.onDidChangeViewState(() => owner.viewChanged(this));
    shell.onDidDispose(() => owner.closed(this));
  }

  post(m) { if (!this.disposed) this.shell.webview.postMessage(m); }
  inFront() { return this.owner.front === this && this.shell.isActive() && this.owner.isFocused(); }

  /** Fetches the ticket, its newest comments and its neighbours; renders; mirrors. Throws if the ticket can't be read. */
  async load() {
    const { api } = this.owner;
    const issue = await api.issue(this.key);
    const { comments, total } = await api.comments(this.key);
    const chain = await this.owner.chainFor(issue);
    const priorities = await this.owner.priorities();
    if (this.disposed) return;
    const first = !this.loaded;
    this.issue = issue; this.comments = comments || []; this.total = total == null ? this.comments.length : total;
    this.loaded = true; this.reread = false;
    this.post({ type: 'render', issue, comments: this.comments, total: this.total, path: chain.path.map(crumb), me: this.owner.me, priorities, browseUrl: api.browseUrl(this.key) });
    const file = this.owner.mirror.write(issue, this.comments, this.total, chain);
    // opening counts as seen; new content later only while Sean can see it: the tab visible in the focused window
    if (first || (this.shell.isVisible() && this.owner.isFocused())) this.owner.markSeen(this.key);
    if (this.inFront()) this.owner.mirror.setCurrent(file);
  }

  async show() {
    this.waiting = false;
    try { await this.load(); } catch (e) {
      this.owner.log(e);
      // no sign-in yet (a tab restored at startup) or not any more: the tab loads by itself once there is one
      if (e && e.name === 'SignInNeeded') { this.waiting = true; this.post({ type: 'waiting', message: WAITING }); return; }
      this.post({ type: 'loadError', message: messageOf(e) });
    }
  }

  /** The 30 s poll: re-render if the ticket moved on, or tell an editing page that it is stale. */
  async refresh() {
    if (!this.loaded || this.disposed) return;
    const fresh = await this.owner.api.issue(this.key);
    if (fresh.updated === this.issue.updated) return;
    if (this.editing) { this.post({ type: 'stale' }); return; }
    await this.load();
  }

  /** One write: pending, the writer's Result, then (on ok) a re-fetch and re-render. */
  async write(op, fn) {
    // the last read-back failed: re-read instead of sending, and let Sean decide again on what he now sees
    if (this.reread) {
      let message = 'The ticket was re-read first; not sent. Try again.';
      try { await this.load(); } catch (e) { this.owner.log(e); message = "Couldn't re-read the ticket — not sent"; }
      this.post({ type: 'result', op, result: { ok: false, kind: 'failed', message } });
      return;
    }
    this.post({ type: 'pending', op });
    let result;
    try { result = await fn(); } catch (e) { this.owner.log(e); result = { ok: false, kind: 'failed', message: messageOf(e) }; }
    this.post({ type: 'result', op, result });
    if (!result.ok) return;
    try { await this.load(); } catch (e) { this.owner.log(e); this.reread = true; }
  }

  async receive(m) {
    if (!m || typeof m.type !== 'string') return;
    const { api, writer, me } = this.owner;
    const key = this.key;
    switch (m.type) {
      case 'ready': case 'reload': return this.show();
      case 'editing': this.editing = !!m.on; return;
      case 'open': if (KEY_RE.test(String(m.key))) this.owner.open(String(m.key)); return;
      case 'openExternal': {
        if (m.url !== undefined && !(typeof m.url === 'string' && /^https:\/\//i.test(m.url))) return;   // only https links
        const url = m.url === undefined ? api.browseUrl(key) : m.url;
        await this.owner.vscode.env.openExternal(this.owner.vscode.Uri.parse(url));
        return;
      }
      case 'getTransitions': {
        try { this.transitionList = await api.transitions(key); this.post({ type: 'transitions', list: this.transitionList }); }
        catch (e) { this.owner.log(e); this.post({ type: 'transitions', list: [], error: messageOf(e) }); }
        return;
      }
      case 'searchUsers': {
        const q = String(m.query || '');
        let users = [];
        try { users = m.assignable ? await api.assignable(key, q) : await api.users(q); } catch (e) { this.owner.log(e); }
        this.post({ type: 'users', requestId: m.requestId, users });
        return;
      }
    }
    // No write before the tab has loaded; the page counts an op as pending once sent, so it always gets an answer.
    if (!this.loaded) {
      const op = OP_OF[m.type] && OP_OF[m.type](m);
      if (op) this.post({ type: 'result', op, result: { ok: false, kind: 'failed', message: 'Not loaded yet' } });
      return;
    }
    switch (m.type) {
      // The conflict base is what the draft started from, sent by the page; never the host's latest read.
      case 'save':
        if (!TEXT_FIELDS.has(m.field)) return;
        if (!('base' in m)) { this.post({ type: 'result', op: m.field, result: { ok: false, kind: 'rejected', message: 'Missing the value the edit started from; reload' } }); return; }
        return this.write(m.field, () => writer.saveText(key, m.field, m.value, m.base));
      case 'comment': return this.write('comment', () => writer.addComment(key, m.adf));
      case 'editComment': {
        if (!('base' in m)) { this.post({ type: 'result', op: 'comment:' + m.id, result: { ok: false, kind: 'rejected', message: 'Missing the value the edit started from; reload' } }); return; }
        if (!this.comments.some((x) => x.id === m.id)) { this.post({ type: 'result', op: 'comment:' + m.id, result: { ok: false, kind: 'rejected', message: 'That comment is no longer loaded; reload' } }); return; }
        return this.write('comment:' + m.id, () => writer.editComment(key, m.id, m.adf, m.base));
      }
      case 'set':
        if (!SET_FIELDS.has(m.field)) return;
        return this.write(m.field, () => writer.setField(key, m.field, m.value));
      case 'assignMe': return this.write('assignee', () => writer.setField(key, 'assignee', me.accountId));
      case 'transition': {
        const tr = this.transitionList.find((x) => x.id === m.id);
        if (tr && tr.hasScreen) { this.post({ type: 'result', op: 'transition', result: { ok: false, kind: 'rejected', message: 'Needs more fields: Open in Jira' } }); return; }
        return this.write('transition', () => writer.transition(key, m.id));
      }
    }
  }
}

/**
 * @param o.vscode, o.api, o.writer, o.mirror, o.events  see src/api.js, writes.js, mirror.js, events.js
 * @param o.getIndex()   the loader's issues by key (may be empty)
 * @param o.me           { accountId, displayName }
 * @param o.isFocused()  whether this window has focus
 */
function createTickets(o) {
  const { vscode, extensionUri } = o;
  const tabs = new Map();
  let prioritiesP = null;
  const owner = {
    vscode, api: o.api, writer: o.writer, mirror: o.mirror, me: o.me, front: null,
    isFocused: () => (o.isFocused ? o.isFocused() : vscode.window.state.focused),
    log: o.log || (() => {}),
    open,
    markSeen(key) { o.events.seen(key); o.events.save(); },
    priorities() {
      if (!prioritiesP) prioritiesP = o.api.priorities().catch((e) => { owner.log(e); prioritiesP = null; return []; });
      return prioritiesP;
    },
    /** The chain from the loader's index, filled in with extra reads where the index doesn't have it. */
    async chainFor(issue) {
      const index = (o.getIndex && o.getIndex()) || new Map();
      const map = new Map(index);
      const known = index.has(issue.key);
      map.set(issue.key, issue);
      const tolerate = async (fn) => { try { return await fn(); } catch (e) { owner.log(e); return null; } };
      for (let p = issue.parentKey, n = 0; p && n < MAX_PARENTS; n++) {
        if (!map.has(p)) { const got = await tolerate(() => o.api.issue(p)); if (!got) break; map.set(p, got); }
        p = map.get(p).parentKey;
      }
      if (!known) {
        const add = (list) => { for (const i of list || []) if (!map.has(i.key)) map.set(i.key, i); };
        const kids = await tolerate(() => o.api.search(`parent = ${issue.key}`));
        add(kids);
        if (issue.isEpic && kids && kids.length) add(await tolerate(() => o.api.search(`parent in (${kids.map((k) => k.key).join(', ')})`)));
        if (issue.parentKey) add(await tolerate(() => o.api.search(`parent = ${issue.parentKey}`)));
      }
      return chainOf(issue.key, map);
    },
    viewChanged(tab) {
      if (!tab.shell.isActive()) return;
      owner.front = tab;
      if (tab.loaded && owner.isFocused()) toFront(tab);
    },
    closed(tab) {
      tab.disposed = true;
      if (tabs.get(tab.key) === tab) tabs.delete(tab.key);
      if (owner.front === tab) owner.front = null;
      o.mirror.closed(tab.key);
    },
  };

  function toFront(tab) {
    owner.markSeen(tab.key);
    const file = o.mirror.pathFor(tab.key);
    if (file) o.mirror.setCurrent(file);
  }

  function html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const src = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const csp = webview.cspSource;
    const scripts = ['prosemirror.js', 'adfPm.js', 'ticketEditor.js', 'ticket.js'].map((f) => `<script nonce="${nonce}" src="${src(f)}"></script>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; img-src ${csp} data:; font-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${src('ticket.css')}"></head><body>${scripts}</body></html>`;
  }

  function attach(panel, key) {
    panel.title = key;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
    const tab = new TicketTab(owner, key, {
      webview: panel.webview, onDidDispose: panel.onDidDispose, onDidChangeViewState: panel.onDidChangeViewState,
      reveal: () => panel.reveal(), isActive: () => !!panel.active, isVisible: () => !!panel.visible, dispose: () => panel.dispose(),
    });
    tabs.set(key, tab);
    owner.front = tab;
    panel.webview.html = html(panel.webview);
    return tab;
  }

  function open(key) {
    const have = tabs.get(key);
    if (have) { have.shell.reveal(); return have; }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, key, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    return attach(panel, key);
  }

  const registration = vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state) {
      const key = state && String(state.key);
      if (!key || !KEY_RE.test(key) || tabs.has(key)) { panel.dispose(); return; }
      attach(panel, key);
    },
  });
  const focusSub = vscode.window.onDidChangeWindowState((s) => {
    const tab = owner.front;
    if (s.focused && tab && tab.loaded && tab.shell.isActive()) toFront(tab);
  });

  return {
    open: (key) => { open(key); },
    async refreshVisible() {
      for (const tab of [...tabs.values()]) {
        if (!tab.shell.isVisible()) continue;
        // offline and throttling go back to the tab poller, which backs off; the rest is logged
        try { await tab.refresh(); } catch (e) { if (e && (e.name === 'Offline' || e.status === 429 || e.status === 503)) throw e; owner.log(e); }
      }
    },
    /** The file of the jay tab most recently in front in this window, while it is open and on screen. */
    frontFile() {
      const t = owner.front;
      if (!t || t.disposed || !t.loaded || !t.shell.isVisible()) return null;
      return o.mirror.pathFor(t.key);
    },
    /** Loads the tabs that were waiting for a sign-in. */
    resumeWaiting() { for (const tab of [...tabs.values()]) if (tab.waiting && !tab.disposed) tab.show(); },
    disposeAll() { for (const tab of [...tabs.values()]) tab.shell.dispose(); },
    dispose() { registration.dispose(); focusSub.dispose(); },
  };
}

module.exports = { createTickets, VIEW_TYPE, KEY_RE };
