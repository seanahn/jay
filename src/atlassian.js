'use strict';
// jay.ticketView "atlassian": a click opens the ticket in the Atlassian extension's issue page (atlassian.atlascode), a soft
// dependency with jay's own tab as the fallback. jay still mirrors the ticket for the agent, and follows that page's editor tab
// to know when it is the ticket in front (design 101, "Which view opens a ticket").
const { KEY_RE } = require('./ticket');

const EXTENSION = 'atlassian.atlascode';
const COMMAND = 'atlascode.jira.showIssueForKey';
const REFRESH_MS = 30000;
// After the command, how long Atlassian's page has to title its tab with the key. It fetches the issue again before it retitles.
const WATCH_MS = 15000;
// The title Atlassian's issue page keeps until an issue loads (atlascode 4.0.33): a page stuck on it after the watch failed.
const UNLOADED_TITLE = 'Jira Issue';
const RESTART = 'workbench.action.restartExtensionHost';
const RESTART_LABEL = 'Restart extensions';
const FIRST_GROUP = 'workbench.action.focusFirstEditorGroup';
const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
// VS Code prefixes a webview's type (e.g. "mainThreadWebview-react"); the Atlassian issue panel's own type is "react"
const isAtlassianInput = (input) => !!input && typeof input.viewType === 'string' && input.viewType.endsWith('react');
const isJayInput = (input) => !!input && typeof input.viewType === 'string' && input.viewType.endsWith('jay.ticket');
const passOn = (e) => e && (e.name === 'Offline' || e.status === 429 || e.status === 503);

/**
 * @param o.vscode, o.tickets (createTickets), o.mirror (createMirror)
 * @param o.view()       the jay.ticketView setting
 * @param o.markSeen(key) marks the ticket seen and saves
 * @param o.isFocused(), o.log(e), o.now(), o.timers ({ set, clear }; real timers by default)
 */
function createAtlassianView(o) {
  const { vscode, tickets, mirror } = o;
  const timers = o.timers || realTimers;
  const tracked = new Set();      // keys opened in the Atlassian view in this window
  const shown = new Set();        // tracked keys whose Atlassian tab has been seen open
  const fetchedAt = new Map();    // key -> when it was last fetched for this view
  let front = null;               // the tracked key most recently in front (null once jay's tab is)
  let told = false;               // the fallback message is shown once per window session
  let gen = 0;                    // moves on at clear(): loads from before a sign-out are dropped
  // Atlassian's page failed for a ticket jay could load ("Site previously failed authentication": its Jira client is marked
  // failed until its sign-in changes or it restarts): clicks go to jay's view until jay.useAtlassianView, or a restart
  let broken = false;
  let toldLost = false;            // that notice, once per window session
  const watches = new Map();       // key -> { timer, tab, loaded: Promise<boolean> }

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

  const isUnloaded = (t) => !!t && isAtlassianInput(t.input) && t.label === UNLOADED_TITLE;
  const isOpen = (t) => allTabs().includes(t);
  /** Whether an Atlassian tab is titled with key: its page loaded the issue. */
  const titled = (key) => allTabs().some((t) => atlassianKeyOf(t) === key);

  function unwatch(key) { const w = watches.get(key); if (w) { timers.clear(w.timer); watches.delete(key); } }

  /**
   * After the command resolved for key: the Atlassian tab it left untitled (`tab`) gets WATCH_MS to be titled with key. Still
   * untitled then, while jay's own load (`loaded`) succeeded, is Atlassian's failure; if jay's load failed too, Atlassian isn't
   * blamed (offline, throttled, not found) and nothing changes.
   */
  function watch(key, tab, loaded) {
    unwatch(key);
    if (titled(key) || !tab) return;
    const w = { tab, loaded };
    w.timer = timers.set(async () => {
      if (watches.get(key) !== w) return;
      watches.delete(key);
      const g0 = gen;
      const ok = await loaded;
      if (g0 !== gen || titled(key) || !ok || !isOpen(tab) || !isUnloaded(tab)) return;
      lost(key, tab);
    }, WATCH_MS);
    watches.set(key, w);
  }

  function lost(key, tab) {
    o.log(`jay.ticketView: the Atlassian page for ${key} stayed "${UNLOADED_TITLE}" while jay loaded it; opened it in jay's view`);
    broken = true;
    tracked.delete(key); shown.delete(key); fetchedAt.delete(key); if (front === key) front = null;
    Promise.resolve().then(() => vscode.window.tabGroups.close(tab)).catch(o.log);
    tickets.open(key);
    if (toldLost) return;
    toldLost = true;
    Promise.resolve(vscode.window.showInformationMessage(`The Atlassian extension lost its Jira sign-in, so ${key} opened in jay's view.`, RESTART_LABEL, 'Not now'))
      .then((pick) => { if (pick === RESTART_LABEL) return vscode.commands.executeCommand(RESTART); return undefined; })
      .catch(o.log);
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
    for (const key of [...watches.keys()]) if (titled(key)) unwatch(key);
  }

  /** A click in the tree, in Jira results or on "Open KEY". */
  function open(key) {
    if (o.view() !== 'atlassian' || broken) { tickets.open(key); return Promise.resolve(); }
    const ext = vscode.extensions && vscode.extensions.getExtension(EXTENSION);
    if (!ext) { fallback(key, "the Atlassian extension isn't installed"); return Promise.resolve(); }
    const fresh = !tracked.has(key);
    const stamped = fetchedAt.get(key);
    // tracked and stamped first: the page's tab appears while the command runs, and the click's own fetch follows
    tracked.add(key); fetchedAt.set(key, o.now()); front = key;
    const before = new Set(allTabs());
    // Atlassian's command opens its page in the active group and takes no column: focus the first group, as jay's tab uses
    return Promise.resolve()
      .then(() => vscode.commands.executeCommand(FIRST_GROUP)).catch(o.log)
      .then(() => vscode.commands.executeCommand(COMMAND, key)).then(
      () => {
        // the tab the click opened: a new untitled Atlassian tab, else the active one if untitled
        const t = allTabs().find((x) => !before.has(x) && isUnloaded(x)) || (isUnloaded(activeTab()) ? activeTab() : null);
        const loaded = load(key, true).then(() => true, (e) => { o.log(e); return false; });
        watch(key, t, loaded);
        return loaded.then(() => undefined);
      },
      (e) => {
        if (fresh) { tracked.delete(key); shown.delete(key); fetchedAt.delete(key); if (front === key) front = null; }
        else if (stamped !== undefined) fetchedAt.set(key, stamped);
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
    clear() { gen++; tracked.clear(); shown.clear(); fetchedAt.clear(); front = null; for (const k of [...watches.keys()]) unwatch(k); },
    /** jay.useAtlassianView: Sean signed in again in the Atlassian extension; clicks go to its page again. */
    useAgain() { broken = false; },
    dispose() { for (const s of subs) s.dispose(); for (const k of [...watches.keys()]) unwatch(k); },
  };
}

module.exports = { createAtlassianView, EXTENSION, COMMAND };
