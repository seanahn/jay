'use strict';
// jay: Jira Cloud in VS Code. Wires sign-in, the three pollers, the sidebar and the ticket tabs (design 101, "Signing in",
// "Polling", "Settings", "What catches Sean's eye", "How the agent knows the ticket in front").
const vscode = require('vscode');
const os = require('os'); const path = require('path');
const { SignInNeeded, createApiTokenAuth, createFileAuth, runCommand } = require('./auth');
const { createHttp } = require('./http');
const { createApi, FIELDS } = require('./api');
const { createPeriods } = require('./periods');
const { createLoader, viewKeyOf } = require('./loader');
const { buildTree, firstName, columnsOf } = require('./tree');
const { createEvents } = require('./events');
const { createMirror } = require('./mirror');
const { createWriter } = require('./writes');
const { createTickets, KEY_RE } = require('./ticket');
const { Sidebar } = require('./sidebar');
const { createPoller } = require('./poller');

const TREE_MS = 60000;
const TAB_MS = 30000;
const MINE_MS = 300000;
const MINE_FIRST_MIN = 6;
const MINE_MAX_MIN = 7 * 24 * 60;
const WITH_DESCRIPTION = FIELDS + ',description';   // the polls that feed events read it, for description mentions
const NOTE_POLLS = ['tree', 'mine'];   // whose offline or throttle note the sidebar shows
const OFFLINE = 'Offline, retrying';
const MODES = new Set(['mine', 'all']);
const SIGNED_OUT = 'jay.signedOut';   // set by Sign Out, cleared by Sign In: a token file alone doesn't sign jay back in
// { fingerprint, accountId, displayName, emailAddress, projects: [{ key, name }] }: who the last sign-in was, and its project
// list (shown at once at the next startup); the list lives inside, so it is never taken for another sign-in's
const LAST_SESSION = 'jay.lastSession';
const LEGACY_PROJECTS = 'jay.lastProjects';   // the list as an older jay kept it, beside the session: ignored, deleted at Sign Out
const PATTERNS = require('../package.json').contributes.configuration.properties['jay.quarter.patterns'].default;
const WRITES = ['saveText', 'addComment', 'editComment', 'setField', 'transition'];
const SEARCH_MAX = 20;
const COLUMN_NAMES = ['key', 'summary', 'assignee', 'status', 'type', 'priority', 'due', 'labels', 'estimate'];
const DEFAULT_COLUMNS = ['key', 'summary', 'assignee', 'status'];
const SEARCH_FAILED = 'Jira search failed';
const NOT_SIGNED_IN = { ok: false, kind: 'failed', message: 'Not signed in' };

function signInText(reason, kind, file) {
  if (kind === 'envFile' || reason === 'envFile') return `Update the Jira API token in ${file}`;
  if (kind === 'tokenFile') return 'Sign in again with the tool that writes the token file';
  return reason === 'none' || !kind ? 'Sign in to Jira' : 'API token rejected: jay: Sign In again';
}
function signInFailure(e) {
  if (e instanceof SignInNeeded) return 'the email or API token was rejected';
  if (e && e.name === 'Offline') return "couldn't reach the site";
  if (e && e.name === 'Timeout') return 'the site did not answer in time';
  return (e && e.message) || 'unknown error';
}
// text ~ takes Lucene syntax: its special characters are backslash-escaped, then the result is escaped as a JQL string
const luceneEscape = (q) => q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
const jqlString = (v) => v.replace(/[\\"]/g, '\\$&');
const changedSince = (prev, next) => [...next.index.values()].filter((i) => !prev.index.has(i.key) || prev.index.get(i.key).updated !== i.updated);

let current = null;

/**
 * @param deps for tests: fetch, home (for ~/.jay and ~ in the token-file path), now, run (the refresh command), timers
 * @returns the running extension: dispose() and its state, for tests
 */
function activate(context, deps = {}) {
  const out = vscode.window.createOutputChannel('jay');
  const home = deps.home || os.homedir();
  const jayDir = path.join(home, '.jay');
  const now = deps.now || Date.now;
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const run = deps.run || runCommand;
  const secrets = context.secrets; const store = context.globalState;
  const cfg = (k, d) => vscode.workspace.getConfiguration('jay').get(k, d);
  // Where the token goes and what jay runs: from the user's settings only (the remote's, in a remote window), never a repo's
  // workspace or folder settings. No machine scope in package.json: remote windows would ignore the local value.
  const userCfg = (k, d) => {
    const i = vscode.workspace.getConfiguration('jay').inspect(k) || {};
    const v = i.globalValue !== undefined ? i.globalValue : i.defaultValue;
    return v === undefined ? d : v;
  };
  const isFocused = () => vscode.window.state.focused;
  const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p);
  const userOut = () => !!store.get(SIGNED_OUT);
  // SignInNeeded from anywhere (a tab, a poll) stops polling; everything else goes to the output channel
  const log = (e) => { if (e instanceof SignInNeeded) needSignIn(e.reason); else out.appendLine(`[${new Date().toISOString()}] ${e && e.stack ? e.stack : e}`); };

  // gen moves on at every restart, sign-out and SignInNeeded: results of polls from an older one are dropped
  // notes: per poller, { offline, throttle }; account: the accountId last signed in, to notice a different one
  // session: the myself() call of this sign-in; projectsLoad: its project list, which nothing waits for (projectsLoaded once it came).
  // fingerprint: which sign-in this is, never the token. trusted: the account whose cache files may show (the confirmed one, or the
  // remembered one when the fingerprint matched); remembered: the fingerprint matched (and myself hasn't said otherwise), so
  // jay.lastSession's projects are this sign-in's
  const s = { gen: 0, auth: null, api: null, writer: null, me: null, session: null, projects: [], projectsStale: false, account: null,
    projectsLoad: null, projectsLoaded: false, fingerprint: null, trusted: null, remembered: false,
    running: false, starting: false, error: null, notes: {}, view: null, fresh: false, mineKeys: new Set(), mineOkAt: null, events: null, cleared: false };
  const note = () => { for (const k of NOTE_POLLS) { const n = s.notes[k]; if (n && (n.offline || n.throttle)) return n.offline || n.throttle; } return null; };
  const setNote = (poll, kind, text) => { const n = s.notes[poll] || (s.notes[poll] = {}); if (n[kind] === text) return; n[kind] = text; render(); };
  const me = { accountId: null, displayName: null };   // the tabs hold this object; it is filled in at each sign-in

  // The tabs, loader and mirror live as long as the extension; they reach the current sign-in through these.
  const apiRef = new Proxy({}, { get: (_, k) => (...a) => { if (!s.api) throw new SignInNeeded('none'); return s.api[k](...a); } });
  const writerRef = { pending: (k) => !!s.writer && s.writer.pending(k) };
  for (const k of WRITES) writerRef[k] = (...a) => (s.writer ? s.writer[k](...a) : Promise.resolve(NOT_SIGNED_IN));
  const eventsRef = { seen: (k) => { if (s.events) s.events.seen(k); }, save: () => { if (s.events) { s.events.save(); render(); } } };

  const sidebar = new Sidebar(context.extensionUri);
  const loader = createLoader({ api: apiRef, cacheDir: path.join(jayDir, 'cache'), now, fields: WITH_DESCRIPTION });
  const mirror = createMirror({ dir: jayDir, enabled: () => cfg('agentFiles', true) !== false, browseUrl: (k) => apiRef.browseUrl(k) });
  const periods = createPeriods({ api: apiRef, store, cfg, now });
  const tickets = createTickets({ vscode, extensionUri: context.extensionUri, api: apiRef, writer: writerRef, mirror, events: eventsRef,
    getIndex: () => (s.view ? s.view.index : new Map()), me, isFocused, log });

  /** The 5 most recently picked project keys, newest first (globalState jay.recentProjects). */
  const recentProjects = () => { const r = store.get('jay.recentProjects'); return Array.isArray(r) ? r.filter((k) => typeof k === 'string').slice(0, 5) : []; };
  // ---- the view: project, period and mode as stored. The period is a quarter, sprint or fix version (jay.period, see
  // periods.js); its default ('current') follows today's quarter or the active sprint. No key until a sprint/version list loads.
  function choice() {
    const project = store.get('jay.project') || null;
    const p = periods.select(project);
    return { ...p, project, mode: store.get('jay.mode') === 'all' ? 'all' : 'mine', key: project && p.period ? viewKeyOf(project, p.period) : null };
  }

  /** jay.columns, checked: known names only, no repeats, in the user's order, and summary always present. */
  function columns() {
    const v = cfg('columns', DEFAULT_COLUMNS);
    if (!Array.isArray(v)) return DEFAULT_COLUMNS.slice();
    const out = [];
    for (const c of v) if (COLUMN_NAMES.includes(c) && !out.includes(c)) out.push(c);
    if (!out.includes('summary')) out.splice(out.includes('key') ? out.indexOf('key') + 1 : 0, 0, 'summary');
    return out;
  }

  function render() {
    const c = choice();
    const v = s.me && s.view && s.view.key === c.key ? s.view : null;
    // "Loading tickets…" on the page: no view for this key on screen yet, and the tree poll will load one
    const treeLoading = !!((s.running || s.starting) && c.key && !v);
    const tree = v ? buildTree({ epics: v.epics, children: v.children, meId: me.accountId, mode: c.mode, placeholders: cfg('placeholderAssignees', []) }) : { groups: [] };
    const events = {};
    // "new epic" in quarter mode; "new in this period" for the members of a sprint or version view
    const members = v && v.members ? new Set(v.members) : null;
    const mark = (n) => {
      const r = s.events.rollup(n); const newEpic = (members ? members.has(n.key) : n.kind === 'epic') && s.events.state(n.key).newEpic;
      if (r.mention || r.bold || newEpic) events[n.key] = { mention: r.mention, bold: r.bold, newEpic };
      n.children.forEach(mark);
    };
    if (s.events && v) for (const g of tree.groups) g.nodes.forEach(mark);
    sidebar.update({
      signedIn: s.running || s.starting, error: s.error, note: note(),
      account: !s.running && !s.starting ? null : s.me ? `Signed in as ${s.me.emailAddress || (s.auth.email && s.auth.email()) || s.me.displayName} (${s.auth.describe()})` : 'Signing in…',
      // quarters/quarter: the period picker's choices and value, whatever the period kind
      projects: s.projects, project: c.project, recentProjects: recentProjects(), quarters: c.choices, quarter: c.id, periodKind: c.kind, periodNote: c.note,
      mode: c.mode, groups: tree.groups, events, columns: columns(), loading: !!(s.running && c.project && !c.period), treeLoading,
    });
    sidebar.setBadge(s.events && s.me ? s.events.badge() : 0);
  }

  /** The cached view for key, only if the account jay trusts wrote it (none trusted yet: none shown). */
  const cachedView = (key) => (key && s.trusted ? loader.cached(key, s.trusted) : null);

  /** The view on screen now: the cached one for a new project or quarter, shown at once; the tree poll then loads it in full. */
  function switchView() {
    const { key } = choice();
    if (!s.view || s.view.key !== key) { s.view = cachedView(key); s.fresh = false; }
    render();
    treePoller.kick();
  }

  // ---- sign-in
  async function buildAuth() {
    const file = userCfg('signIn.tokenFile', '');
    if (file) return createFileAuth({ file: expand(file), refreshCommand: userCfg('signIn.refreshCommand', '') || null, lockDir: jayDir, run, now });
    const email = await secrets.get('jay.email'); const token = await secrets.get('jay.apiToken'); const site = userCfg('site', '');
    return email && token && site ? createApiTokenAuth({ site, email, token }) : null;
  }

  /** Which sign-in this is: the token file's path as written, or the site and email of an API token. Never the token. */
  async function fingerprintOf() {
    const file = userCfg('signIn.tokenFile', '');
    if (file) return 'file:' + file;
    return 'token:' + userCfg('site', '') + '|' + ((await secrets.get('jay.email')) || '');
  }
  const lastSession = () => { const v = store.get(LAST_SESSION); return v && typeof v === 'object' ? v : null; };
  /** The remembered sign-in's project list. */
  const lastProjects = () => { const l = lastSession(); const r = l && l.projects; return Array.isArray(r) ? r.filter((p) => p && typeof p.key === 'string') : []; };

  /** The account this sign-in is. Someone else than before: what jay holds in memory was theirs (seen.json on disk is this machine's and stays). */
  function becomeAccount(accountId) {
    if (s.account && s.account !== accountId) {
      Object.assign(s, { view: null, fresh: false, mineKeys: new Set(), mineOkAt: null, events: createEvents({ file: path.join(jayDir, 'seen.json'), now }) });
    }
    s.account = accountId;
  }

  /** Who this is: once per sign-in. The polls wait for this only; the project list follows without blocking them. */
  function ensureSession() {
    if (!s.session) {
      const api = s.api;
      const p = s.session = (async () => {
        const who = await api.myself();
        if (s.api !== api) return;
        // another account than the remembered one: its project list was that account's
        if (s.remembered && s.account !== who.accountId) { s.remembered = false; if (!s.projectsLoaded) s.projects = []; }
        becomeAccount(who.accountId);
        s.me = who; Object.assign(me, who); s.trusted = who.accountId;
        s.writer = createWriter({ api, meId: who.accountId, now });
        const projects = s.projectsLoaded ? s.projects : s.remembered ? lastProjects() : [];
        store.update(LAST_SESSION, { fingerprint: s.fingerprint, accountId: who.accountId, displayName: who.displayName || null, emailAddress: who.emailAddress || null,
          projects: projects.map((x) => ({ key: x.key, name: x.name })) });
        render();
        loadProjects();
        tickets.resumeWaiting();
      })();
      p.catch(() => { if (s.session === p) s.session = null; });
    }
    return s.session;
  }

  /** The projects this sign-in can browse, in the background; remembered for the next startup. A failure tries again at the next tree poll. */
  function loadProjects() {
    if (s.projectsLoad) return;
    const api = s.api;
    const p = s.projectsLoad = api.projects().then((projects) => {
      if (s.api !== api) return;
      s.projectsLoad = null; s.projectsLoaded = true;
      s.projects = projects;
      // kept with the session it belongs to: the one myself confirmed for this sign-in
      const l = lastSession();
      if (l && l.fingerprint === s.fingerprint && s.me && l.accountId === s.me.accountId) store.update(LAST_SESSION, { ...l, projects: projects.map((x) => ({ key: x.key, name: x.name })) });
      render();
    }, (e) => {
      if (s.api !== api) return;
      if (s.projectsLoad === p) s.projectsLoad = null;
      s.projectsStale = true;
      if (!(e && (e.name === 'Offline' || e.name === 'Timeout'))) log(e);
    });
  }

  function stopAll() { s.gen++; for (const p of pollers) p.stop(); }

  /** Builds the sign-in from the settings and secrets, and polls if there is one. */
  async function restart() {
    stopAll();
    periods.markStale();   // another sign-in may see other sprints, or be allowed what this one was refused
    const g0 = s.gen;
    // nothing of the last sign-in shows until this one says who it is
    Object.assign(s, { running: false, starting: true, auth: null, api: null, writer: null, me: null, session: null, error: null, notes: {}, view: null, fresh: false,
      projects: [], trusted: null, remembered: false });
    Object.assign(me, { accountId: null, displayName: null });
    render();
    watchTokenFile();
    const auth = userOut() ? null : await buildAuth();
    const fingerprint = auth ? await fingerprintOf() : null;
    if (g0 !== s.gen) return;
    s.starting = false;
    if (!auth) { s.error = userOut() ? null : signInText('none'); render(); return; }
    s.auth = auth; s.api = createApi(createHttp({ auth, fetch: fetchFn }), auth); s.cleared = false;
    Object.assign(s, { fingerprint, projectsLoad: null, projectsLoaded: false, projectsStale: false });
    if (!s.events) s.events = createEvents({ file: path.join(jayDir, 'seen.json'), now });
    // the same sign-in as last time: show who it was, its projects and the cached tree now; myself() confirms it in the background
    const last = lastSession();
    if (last && last.fingerprint === fingerprint && typeof last.accountId === 'string') {
      becomeAccount(last.accountId);
      const who = { accountId: last.accountId, displayName: last.displayName || null, emailAddress: last.emailAddress || null };
      s.me = who; Object.assign(me, who); s.trusted = who.accountId; s.remembered = true;
      s.projects = lastProjects();
      s.view = cachedView(choice().key);
    }
    s.running = true;
    render();
    for (const p of pollers) p.start();
  }

  function needSignIn(reason) {
    if (!s.running) return;
    s.starting = false;
    stopAll();
    s.running = false; s.error = signInText(reason, s.auth && s.auth.kind, userCfg('signIn.tokenFile', ''));
    render();
  }

  let watcher = null, watched = '';
  function watchTokenFile() {
    const file = userCfg('signIn.tokenFile', '') ? expand(userCfg('signIn.tokenFile', '')) : '';
    if (file === watched) return;
    if (watcher) watcher.dispose();
    watcher = null; watched = file;
    if (!file) return;
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    // the auth re-reads the file by itself when it changes; signed out because of it, jay tries again
    const changed = () => { if (!s.running && !userOut()) restart().catch(log); };
    watcher.onDidChange(changed); watcher.onDidCreate(changed);
  }

  /** Checks a sign-in with myself(); on success clears the signed-out flag. */
  async function check(auth) {
    try { await createApi(createHttp({ auth, fetch: fetchFn }), auth).myself(); }
    catch (e) { vscode.window.showErrorMessage(`jay couldn't sign in: ${signInFailure(e)}`); return false; }
    await store.update(SIGNED_OUT, undefined);
    return true;
  }

  let pendingSite = null;   // the jay.site value Sign In is writing: its settings change needn't restart again
  async function signIn() {
    if (userCfg('signIn.tokenFile', '')) {   // the token file wins; Sign In just tries it again
      if (await check(await buildAuth())) await restart();
      return;
    }
    const ask = (o) => vscode.window.showInputBox(Object.assign({ ignoreFocusOut: true }, o));
    const site = await ask({ prompt: 'Your Jira Cloud site', value: userCfg('site', ''), placeHolder: 'https://example.atlassian.net' });
    if (!site) return;
    const email = await ask({ prompt: 'Your Atlassian account email' });
    if (!email) return;
    const token = await ask({ prompt: 'An Atlassian API token (id.atlassian.com → Security → API tokens)', password: true });
    if (!token) return;
    const url = site.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^/\s]+$/i.test(url)) { vscode.window.showErrorMessage('jay: the site must look like https://example.atlassian.net'); return; }
    if (!(await check(createApiTokenAuth({ site: url, email: email.trim(), token: token.trim() })))) return;
    await secrets.store('jay.email', email.trim());
    await secrets.store('jay.apiToken', token.trim());
    if (userCfg('site', '') !== url) { pendingSite = url; await vscode.workspace.getConfiguration('jay').update('site', url, true); }
    await restart();
  }

  /** This window's part of a sign-out: stop, close the tabs, forget what is in memory, delete the ~/.jay files. */
  function signOutHere() {
    // stop everything that could write under ~/.jay first, so nothing re-creates a file once it is cleared
    stopAll();
    tickets.disposeAll();
    Object.assign(s, { running: false, starting: false, auth: null, api: null, writer: null, me: null, session: null, events: null, view: null, fresh: false,
      projects: [], trusted: null, remembered: false, mineKeys: new Set(), mineOkAt: null, error: null, notes: {}, cleared: true });
    Object.assign(me, { accountId: null, displayName: null });
    mirror.clearAll(); periods.clear();
    render();
  }

  async function signOut() {
    signOutHere();
    await store.update(SIGNED_OUT, true);
    await store.update(LAST_SESSION, undefined);
    await store.update(LEGACY_PROJECTS, undefined);
    await secrets.delete('jay.email');
    await secrets.delete('jay.apiToken');
  }
  /** Signed out in another window (its flag is shared through globalState): sign out here too, once. */
  function signedOutElsewhere() { if (userOut() && !s.cleared) { signOutHere(); return true; } return false; }

  // ---- the polls
  /** After an await: false if the poll belongs to an older sign-in (and, after a sign-out, wipes what it may have cached). */
  function live(g0) {
    if (g0 === s.gen) return true;
    if (s.cleared) mirror.clearAll();
    return false;
  }
  const mineOf = (issues) => issues.filter((i) => i.assignee && i.assignee.accountId === me.accountId).map((i) => i.key);

  async function observe(issues, g0, mineKeys) {
    for (const i of issues) {
      const { comments } = await s.api.comments(i.key);
      if (!live(g0)) return false;
      s.events.observe(i, comments, { meId: me.accountId, mineKeys });
    }
    return true;
  }

  async function pollTree() {
    const g0 = s.gen;
    await ensureSession();
    if (!live(g0)) return;
    if (s.projectsStale) { s.projectsStale = false; loadProjects(); }   // in the background: the tree doesn't wait for it
    for (;;) {
      // the sprint or version list first (cached for 15 minutes); a refusal falls back to quarters inside periods.js.
      // A project picked meanwhile needs its own list: its kick was dropped while this poll ran.
      const project = store.get('jay.project') || null;
      const fetched = await periods.ensure(project);
      if (!live(g0)) return;
      if ((store.get('jay.project') || null) !== project) continue;
      if (fetched) render();
      const c = choice();
      if (!c.project || !c.key) { render(); return; }
      const patterns = cfg('quarter.patterns', PATTERNS);
      let prev = s.view && s.view.key === c.key ? s.view : null; let view, changed;
      if (prev && s.fresh) ({ view, changed } = await loader.refresh(prev, { patterns }));
      else {
        if (!prev && (prev = cachedView(c.key))) { s.view = prev; render(); }
        view = await loader.load({ project: c.project, period: c.period, patterns, owner: s.trusted });
        changed = prev ? changedSince(prev, view) : null;   // a first load only sets each ticket's baseline
      }
      if (!live(g0)) return;
      if (choice().key !== c.key) continue;   // another project or quarter was picked meanwhile
      const mineKeys = new Set([...s.mineKeys, ...mineOf([...view.index.values()])]);
      if (changed === null) for (const i of view.index.values()) s.events.observe(i, [], { meId: me.accountId, mineKeys });
      else if (!(await observe(changed, g0, mineKeys))) return;
      s.events.observeEpics(view.key, view.members || view.epics.map((e) => e.key));
      s.events.save();
      if (choice().key !== c.key) continue;
      s.view = view; s.fresh = true;
      render();
      return;
    }
  }

  async function pollTabs() {
    const g0 = s.gen;
    await ensureSession();
    if (live(g0)) await tickets.refreshVisible();
  }

  async function pollMine() {
    const g0 = s.gen;
    await ensureSession();
    if (!live(g0)) return;
    // the window reaches back to the last poll that succeeded (+1 min), so a slow unfocused cycle misses nothing
    const t = now();
    const minutes = s.mineOkAt === null ? MINE_FIRST_MIN : Math.min(Math.ceil((t - s.mineOkAt) / 60000) + 1, MINE_MAX_MIN);
    const found = await s.api.search(`assignee = currentUser() AND updated >= "-${minutes}m"`, { fields: WITH_DESCRIPTION });
    if (!live(g0)) return;
    s.mineKeys = new Set(found.map((i) => i.key));
    const mineKeys = new Set([...s.mineKeys, ...(s.view ? mineOf([...s.view.index.values()]) : [])]);
    if (!(await observe(found, g0, mineKeys))) return;
    s.events.save();
    s.mineOkAt = t;
    render();
  }

  /** Throttling and offline go back to the poller, which backs off; SignInNeeded stops all three. */
  const guarded = (name, fn) => async () => {
    if (signedOutElsewhere()) return;
    try {
      await fn();
      setNote(name, 'offline', null);
    } catch (e) {
      if (e instanceof SignInNeeded) return needSignIn(e.reason);
      if (e && e.name === 'Offline') setNote(name, 'offline', OFFLINE);
      throw e;
    }
  };
  const addPoller = (name, fn, everyMs) => createPoller({ run: guarded(name, fn), everyMs, isFocused, timers: deps.timers,
    onThrottle: (text) => setNote(name, 'throttle', text), onError: log });
  const treePoller = addPoller('tree', pollTree, TREE_MS);
  const pollers = [treePoller, addPoller('tab', pollTabs, TAB_MS), addPoller('mine', pollMine, MINE_MS)];

  // ---- the page
  /** The sidebar's search of all of Jira. Any failure is only an error reply: sign-in, pollers and the note stay as they are. */
  async function searchJira(m) {
    if (typeof m.query !== 'string' || m.query.length < 3 || m.query.length > 200 || typeof m.id !== 'number') return;
    const { id, query } = m;
    const api = s.api;
    if (!api) { sidebar.reply({ type: 'searchResults', id, query, error: SEARCH_FAILED }); return; }
    try {
      const upper = query.trim().toUpperCase();
      // a key-like query (DEMO-12, but also UTF-8) is looked up on its own: `OR key = X` fails the whole search when X doesn't exist
      const byKey = KEY_RE.test(upper) ? api.issue(upper).catch((e) => { if (e && (e.status === 404 || e.status === 400)) return null; throw e; }) : null;
      const jql = `text ~ "${jqlString(luceneEscape(query))}" ORDER BY updated DESC`;
      const [found, hit] = await Promise.all([api.search(jql, { fields: FIELDS, max: SEARCH_MAX }), byKey]);
      const all = hit ? [hit, ...found.filter((i) => i.key !== hit.key)] : found;
      const items = all.slice(0, SEARCH_MAX).map((i) => ({
        key: i.key, summary: i.summary, who: firstName(i.assignee), ...columnsOf(i),
        status: i.status && i.status.category === 'new' ? null : (i.status && i.status.name) || null,
        mine: !!i.assignee && i.assignee.accountId === me.accountId,
      }));
      sidebar.reply({ type: 'searchResults', id, query, items });
    } catch (e) {
      sidebar.reply({ type: 'searchResults', id, query, error: SEARCH_FAILED });
    }
  }

  /** A project in the list; before this sign-in's list has come, also one remembered from the last, or the current one. */
  const knownProject = (key) => typeof key === 'string' && (s.projects.some((p) => p.key === key)
    || (!s.projectsLoaded && ((s.remembered && lastProjects().some((p) => p.key === key)) || key === store.get('jay.project'))));

  sidebar.onMessage((m) => {
    if (m.type === 'signIn') { signIn().catch(log); return; }
    if (m.type === 'open') {
      const key = typeof m.key === 'string' ? m.key.trim().toUpperCase() : '';
      if (KEY_RE.test(key) && s.running) tickets.open(key);
      return;
    }
    if (m.type === 'search') { searchJira(m); return; }
    if (m.type === 'setMode') { if (MODES.has(m.mode)) { store.update('jay.mode', m.mode); s.fresh = false; switchView(); } return; }
    if (m.type === 'setProject') { if (knownProject(m.key)) { store.update('jay.project', m.key); store.update('jay.recentProjects', [m.key, ...recentProjects().filter((k) => k !== m.key)].slice(0, 5)); switchView(); } return; }
    // setQuarter is the older name of setPeriod; either is checked against the picker's current choices
    if (m.type === 'setPeriod' || m.type === 'setQuarter') { if (periods.choose(store.get('jay.project') || null, m.id)) switchView(); }
  });

  function onSettings(e) {
    const own = pendingSite !== null && userCfg('site', '') === pendingSite;   // Sign In wrote it and restarts by itself
    if (own) pendingSite = null;
    if (e.affectsConfiguration('jay.signIn') || (e.affectsConfiguration('jay.site') && !own)) restart().catch(log);
    if (e.affectsConfiguration('jay.quarter') || e.affectsConfiguration('jay.period')) { s.fresh = false; switchView(); }
    if (e.affectsConfiguration('jay.placeholderAssignees') || e.affectsConfiguration('jay.columns')) render();
    if (e.affectsConfiguration('jay.agentFiles') && cfg('agentFiles', true) === false) mirror.clearFiles();
  }

  async function refresh() {
    if (!s.running) { if (!userOut()) await restart(); return; }
    s.projectsStale = true; periods.markStale();
    for (const p of pollers) p.kick();
  }

  function dispose() {
    stopAll();
    if (watcher) watcher.dispose();
    watcher = null;
    // the tabs stay: VS Code disposes the panels itself, and the serializer restores them after a reload
    tickets.dispose();
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('jay.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeWindowState((w) => { if (w.focused) for (const p of pollers) p.kick(); }),
    vscode.workspace.onDidChangeConfiguration(onSettings),
    // Sign Out in another window deletes the shared secrets after setting the flag
    secrets.onDidChange((e) => { if (e && (e.key === 'jay.email' || e.key === 'jay.apiToken')) signedOutElsewhere(); }),
    vscode.commands.registerCommand('jay.refresh', () => refresh()),
    vscode.commands.registerCommand('jay.signIn', () => signIn()),
    vscode.commands.registerCommand('jay.signOut', () => signOut()),
    vscode.commands.registerCommand('jay.focusSearch', () => sidebar.focusSearch()),
    vscode.commands.registerCommand('jay.activeIssueFile', () => (cfg('agentFiles', true) === false ? null : tickets.frontFile())),
    out,
  );

  render();
  restart().catch(log);
  current = { dispose, state: s, pollers };
  return current;
}

function deactivate() { if (current) current.dispose(); current = null; }

module.exports = { activate, deactivate };
