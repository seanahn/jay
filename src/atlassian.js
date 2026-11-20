'use strict';
// jay.ticketView "atlassian": a click opens the ticket in the Atlassian extension's issue page (atlassian.atlascode), a soft
// dependency with jay's own tab as the fallback. jay still mirrors the ticket for the agent, and follows that page's editor tab
// to know when it is the ticket in front (design 101, "Which view opens a ticket").
const { KEY_RE } = require('./ticket');

const EXTENSION = 'atlassian.atlascode';
const COMMAND = 'atlascode.jira.showIssueForKey';
const REFRESH_MS = 30000;
// VS Code prefixes a webview's type (e.g. "mainThreadWebview-react"); the Atlassian issue panel's own type is "react"
const isAtlassianInput = (input) => !!input && typeof input.viewType === 'string' && input.viewType.endsWith('react');
const isJayInput = (input) => !!input && typeof input.viewType === 'string' && input.viewType.endsWith('jay.ticket');
const passOn = (e) => e && (e.name === 'Offline' || e.status === 429 || e.status === 503);

/**
 * @param o.vscode, o.tickets (createTickets), o.mirror (createMirror)
 * @param o.view()       the jay.ticketView setting
 * @param o.markSeen(key) marks the ticket seen and saves
 * @param o.isFocused(), o.log(e), o.now()
 */
function createAtlassianView(o) {
  const { vscode, tickets, mirror } = o;
  const tracked = new Set();      // keys opened in the Atlassian view in this window
  const shown = new Set();        // tracked keys whose Atlassian tab has been seen open
  const fetchedAt = new Map();    // key -> when it was last fetched for this view
  let front = null;               // the tracked key most recently in front (null once jay's tab is)
  let told = false;               // the fallback message is shown once per window session
  let gen = 0;                    // moves on at clear(): loads from before a sign-out are dropped

  const groups = () => (vscode.window.tabGroups && vscode.window.tabGroups.all) || [];
  const allTabs = () => groups().flatMap((g) => g.tabs || []);
  const atlassianKeyOf = (t) => (t && isAtlassianInput(t.input) && KEY_RE.test(String(t.label)) ? t.label : null);
  const trackedKeyOf = (t) => { const k = atlassianKeyOf(t); return k && tracked.has(k) ? k : null; };
  const activeTab = () => { const g = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup; return (g && g.activeTab) || null; };
  /** Whether key's Atlassian tab is on screen: the active tab of some editor group. */
  const showing = (key) => groups().some((g) => g.activeTab && trackedKeyOf(g.activeTab) === key);

  function fallback(key, reason) {
    o.log(`jay.ticketView: ${reason}; opened ${key} in jay's view`);
    if (!told) { told = true; Promise.resolve(vscode.window.showInformationMessage(`Opened in jay's view: ${reason}`)).catch(() => {}); }
    tickets.open(key);
  }

  /** Fetches and mirrors key; on a click (or in front, focused) marks it seen and makes it current.jira. Throws if it can't be read. */
  async function load(key, clicked) {
    const g0 = gen;
    const { file } = await tickets.loadAndMirror(key);
    if (g0 !== gen) { mirror.closed(key); return; }
    // closed while loading, with no jay tab for it: the file goes, as at the close
    if (!tracked.has(key) && !tickets.has(key)) { mirror.closed(key); return; }
    const inFront = clicked || (front === key && showing(key));
    if (!inFront) return;
    if (clicked || o.isFocused()) o.markSeen(key);
    if (file && o.isFocused()) mirror.setCurrent(file);
  }

  function refreshIfDue(key) {
    const at = fetchedAt.get(key);
    if (at !== undefined && o.now() - at < REFRESH_MS) return Promise.resolve();
    fetchedAt.set(key, o.now());
    return load(key, false);
  }

  function toFront(key) {
    front = key;
    if (o.isFocused()) {
      const file = mirror.pathFor(key);
      if (file) { mirror.setCurrent(file); o.markSeen(key); }
    }
    refreshIfDue(key).catch(o.log);
  }

  function drop(key) {
    tracked.delete(key); shown.delete(key); fetchedAt.delete(key);
    if (front === key) front = null;
    if (!tickets.has(key)) mirror.closed(key);
  }

  function tabsChanged() {
    const open = new Set(allTabs().map(trackedKeyOf).filter(Boolean));
    for (const k of open) shown.add(k);
    // a tracked key whose Atlassian tab was open and no longer is: closed
    for (const k of [...shown]) if (!open.has(k)) drop(k);
    const t = activeTab();
    const k = trackedKeyOf(t);
    if (k) toFront(k);
    else if (t && isJayInput(t.input)) front = null;
  }

  /** A click in the tree, in Jira results or on "Open KEY". */
  function open(key) {
    if (o.view() !== 'atlassian') { tickets.open(key); return Promise.resolve(); }
    const ext = vscode.extensions && vscode.extensions.getExtension(EXTENSION);
    if (!ext) { fallback(key, "the Atlassian extension isn't installed"); return Promise.resolve(); }
    const fresh = !tracked.has(key);
    const before = fetchedAt.get(key);
    // tracked and stamped first: the page's tab appears while the command runs, and the click's own fetch follows
    tracked.add(key); fetchedAt.set(key, o.now()); front = key;
    return Promise.resolve().then(() => vscode.commands.executeCommand(COMMAND, key)).then(
      () => load(key, true).catch(o.log),
      (e) => {
        if (fresh) { tracked.delete(key); shown.delete(key); fetchedAt.delete(key); if (front === key) front = null; }
        else if (before !== undefined) fetchedAt.set(key, before);
        fallback(key, (e && e.message) || 'its command failed');
      });
  }

  const subs = [];
  const tg = vscode.window.tabGroups;
  if (tg && tg.onDidChangeTabs) subs.push(tg.onDidChangeTabs(tabsChanged));
  if (tg && tg.onDidChangeTabGroups) subs.push(tg.onDidChangeTabGroups(tabsChanged));
  subs.push(vscode.window.onDidChangeWindowState((w) => { const k = trackedKeyOf(activeTab()); if (w.focused && k) toFront(k); }));

  return {
    open,
    /** The tab poll: re-fetches the Atlassian tab in front (at most once per 30 s). Offline and throttling go back to the poller. */
    async refreshFront() {
      if (!front || !showing(front)) return;
      try { await refreshIfDue(front); } catch (e) { if (passOn(e)) throw e; o.log(e); }
    },
    /** The file of the Atlassian tab in front, while it is on screen; null otherwise (jay's own tab decides then). */
    frontFile() { return front && showing(front) ? mirror.pathFor(front) : null; },
    /** Whether key's Atlassian tab is still open: closing jay's tab for the same key keeps the file then. */
    keeps: (key) => tracked.has(key) && allTabs().some((t) => trackedKeyOf(t) === key),
    /** Signing out: forget every tracked key. */
    clear() { gen++; tracked.clear(); shown.clear(); fetchedAt.clear(); front = null; },
    dispose() { for (const s of subs) s.dispose(); },
  };
}

module.exports = { createAtlassianView, EXTENSION, COMMAND };
