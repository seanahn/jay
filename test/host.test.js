'use strict';
// The extension host against a fake vscode, a fake Jira, fake timers and a throwaway home (~/.jay). No network.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { install, memento, secrets } = require('./vscodeStub');
const { ui, vscode } = install();
const ext = require('../src/extension');

const SITE = 'https://example.atlassian.net';
const ME = { accountId: 'acc-me', displayName: 'Ann Example' };
const OTHER = { accountId: 'acc-bo', displayName: 'Bo Sample' };
function raw(key, o = {}) {
  return { key, id: key, fields: {
    summary: o.summary || `${key} title`, status: { name: 'To Do', statusCategory: { key: 'new' } },
    assignee: o.assignee === undefined ? ME : o.assignee, reporter: OTHER,
    issuetype: o.epic ? { name: 'Epic', hierarchyLevel: 1 } : { name: 'Task', hierarchyLevel: 0 },
    parent: o.parent ? { key: o.parent } : undefined, labels: o.labels || [], description: o.description || null,
    created: '2027-01-01T00:00:00.000+0000', updated: o.updated || '2027-01-02T00:00:00.000+0000',
  } };
}

/** A fake Jira Cloud: routes by path, reads `world`, records every request. */
function jira(world) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, jql: body && body.jql, fields: body && body.fields });
    const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (world.reject) return new Response('{}', { status: 401 });
    const p = decodeURIComponent(u.pathname.replace(/^\/ex\/jira\/[^/]+/, ''));
    if (world.offline && p === '/rest/api/3/search/jql') throw new TypeError('fetch failed');
    if (world.agileGate && p.startsWith('/rest/agile/')) await world.agileGate;
    if (world.hold && world.hold[p]) await world.hold[p];   // a request held until the test releases it
    if (world.fail) { const res = world.fail(p, init); if (res) return res; }
    if (p === '/rest/api/3/myself') return ok(world.me || ME);
    if (p === '/rest/api/3/project/search') return ok({ values: world.projects, isLast: true });
    if (p === '/rest/api/3/priority') return ok([]);
    if (p === '/rest/agile/1.0/board') return ok({ values: world.boards || [], isLast: true });
    let a = /^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/.exec(p);
    if (a) return ok({ values: (world.sprints || {})[a[1]] || [], isLast: true });
    if ((a = /^\/rest\/api\/3\/project\/(\w+)\/versions$/.exec(p))) return ok(world.versions || []);
    if (p === '/rest/api/3/search/jql') {
      if (world.gate) await world.gate;
      const jql = body.jql; let m;
      if ((m = /^project = "(\w+)" AND issuetype = Epic/.exec(jql))) return ok({ issues: world.epics[m[1]] || [] });
      if ((m = /^parent in \(([^)]*)\)/.exec(jql))) { const ks = m[1].split(', '); return ok({ issues: world.children.filter((c) => ks.includes(c.fields.parent.key)) }); }
      if (/^assignee = currentUser\(\) AND updated >= "-\d+m"$/.test(jql)) return ok({ issues: world.mine || [] });
      if (/^project = "(\w+)" AND updated >= /.test(jql)) return ok({ issues: world.updated || [] });
      // sprint and version modes: world.inPeriod maps a period clause to its member issues
      if ((m = /^project = "(\w+)" AND ((?:sprint|fixVersion) .+)$/.exec(jql))) { const ip = world.inPeriod || {}; return ok({ issues: ip[`${m[1]}|${m[2]}`] || ip[m[2]] || [] }); }
      if ((m = /^key in \(([^)]*)\)(?: AND (.+))?$/.exec(jql))) {
        const ks = m[1].split(', ');
        const pool = m[2] ? (world.inPeriod || {})[m[2]] || [] : [...Object.values(world.epics).flat(), ...world.children];
        return ok({ issues: pool.filter((i) => ks.includes(i.key)) });
      }
      if (world.search && /^text ~ /.test(jql)) return world.search(body, ok);
      return ok({ issues: [] });
    }
    let m = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(p);
    if (m) { const cs = (world.comments || {})[m[1]] || []; return ok({ comments: cs, total: cs.length }); }
    m = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(p);
    if (m) { const all = [...Object.values(world.epics).flat(), ...world.children]; const i = all.find((x) => x.key === m[1]); return i ? ok(i) : new Response('{}', { status: 404 }); }
    return new Response('{}', { status: 404 });
  };
  fetch.calls = calls;
  return fetch;
}

/** Timers the pollers use: nothing fires by itself; fire() runs what is due. */
function fakeTimers() {
  let n = 0; const pending = new Map();
  return { pending, set: (fn, ms) => { pending.set(++n, { fn, ms }); return n; }, clear: (id) => { pending.delete(id); },
    fire() { const due = [...pending.values()]; pending.clear(); for (const t of due) t.fn(); },
    delays: () => [...pending.values()].map((t) => t.ms).sort((a, b) => a - b) };
}

const ATL_COMMAND = 'atlascode.jira.showIssueForKey';
const ATL_TYPE = 'mainThreadWebview-react';
/** Installs a fake Atlassian extension: its command opens a "react" webview tab titled with the key, or rejects. */
function atlassian(o = {}) {
  ui.extensions['atlassian.atlascode'] = { id: 'atlassian.atlascode' };
  const tabs = {};
  ui.commands[ATL_COMMAND] = async (key) => {
    if (o.reject) throw new Error(o.reject);
    tabs[key] = tabs[key] && tabs[key].group.tabs.includes(tabs[key]) ? (ui.activateTab(tabs[key]), tabs[key]) : ui.openTab({ label: key, viewType: ATL_TYPE });
  };
  return tabs;
}
const atlCalls = () => ui.executed.filter((c) => c[0] === ATL_COMMAND);
const seenAt = (h, key) => { try { const t = JSON.parse(fs.readFileSync(path.join(h.jayDir, 'seen.json'), 'utf8')).tickets[key]; return t ? t.seen : null; } catch (_) { return null; } };

const running = [];
function start(o = {}) {
  for (const k of Object.keys(ui.config)) delete ui.config[k];
  for (const k of Object.keys(ui.workspaceConfig)) delete ui.workspaceConfig[k];
  Object.assign(ui.workspaceConfig, o.workspaceConfig || {});
  ui.panels.length = 0; ui.inputs.length = 0; ui.inputOptions.length = 0; ui.out.length = 0; ui.watchers.length = 0;
  ui.infos.length = 0; ui.executed.length = 0; ui.resetTabs();
  for (const k of Object.keys(ui.extensions)) delete ui.extensions[k];
  delete ui.commands[ATL_COMMAND];
  ui.focused = o.focused !== undefined ? o.focused : true;
  const home = o.home || fs.mkdtempSync(path.join(os.tmpdir(), 'jay-host-'));
  const world = Object.assign({
    projects: [{ key: 'DEMO', name: 'Demo' }, { key: 'OTH', name: 'Other' }],
    epics: { DEMO: [raw('DEMO-1', { epic: true })] },
    children: [raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER })],
  }, o.world);
  const fetch = jira(world);
  const sec = o.secrets || secrets();
  if (!o.signedOut) { sec.m.set('jay.email', 'ann@example.com'); sec.m.set('jay.apiToken', 'tok-api'); ui.config['jay.site'] = SITE; }
  Object.assign(ui.config, o.config || {});
  const gs = o.gs || memento();
  const stored = Object.assign({ 'jay.project': 'DEMO', 'jay.quarter': 'any' }, o.stored);
  for (const [k, v] of Object.entries(stored)) if (v !== undefined) gs.update(k, v);
  const clock = { t: o.t || Date.UTC(2027, 0, 15, 12) };
  const timers = fakeTimers();
  const context = { extensionUri: vscode.Uri.file(path.join(__dirname, '..')), globalState: gs, secrets: sec, subscriptions: [] };
  const api = ext.activate(context, { fetch, home, now: () => clock.t, run: o.run || (async () => ({ code: 1, timedOut: false, stderr: '' })), timers });
  const view = ui.resolveSidebar();
  const h = { api, fetch, home, world, secrets: sec, gs, clock, timers, view, jayDir: path.join(home, '.jay') };
  running.push(h);
  return h;
}
test.afterEach(() => { for (const h of running.splice(0)) ext.deactivate(); for (const p of ui.panels) p.dispose(); });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const lastState = (view) => view.webview.posted.filter((m) => m.type === 'state').at(-1);
const keysOf = (st) => st.groups.flatMap((g) => g.nodes).map((n) => n.key);
const JWT = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 's'].map((x, i) => (i < 2 ? Buffer.from(x).toString('base64url') : x)).join('.');
function tokenFile(home, token = JWT({ sub: 'x' })) {
  const f = path.join(home, 'creds.json');
  fs.writeFileSync(f, JSON.stringify({ access_token: token, cloud_id: 'cloud-1', jira_url: SITE }), { mode: 0o600 });
  return f;
}

test('signed out shows Sign In; signIn stores secrets only after myself succeeds', async () => {
  const h = start({ signedOut: true, config: { 'jay.site': SITE } });
  await settle();
  assert.strictEqual(lastState(h.view).signedIn, false);
  assert.strictEqual(h.fetch.calls.length, 0, 'no requests while signed out');

  h.world.reject = true;
  ui.inputs.push(SITE + '/', 'ann@example.com', 'bad-token');
  await ui.commands['jay.signIn']();
  assert.strictEqual(ui.inputOptions[0].value, SITE, 'the site is prefilled from jay.site');
  assert.strictEqual(ui.inputOptions[2].password, true);
  assert.strictEqual(h.secrets.m.size, 0, 'nothing stored when myself fails');
  assert.ok(ui.out.some((l) => /^error: /.test(l)) && !ui.out.some((l) => l.includes('bad-token')), 'an error, never the token');

  h.world.reject = false;
  ui.config['jay.site'] = undefined;
  const before = h.fetch.calls.length;
  ui.inputs.push(SITE, 'ann@example.com', 'tok-good');
  await ui.commands['jay.signIn']();
  await settle();
  const myself = h.fetch.calls.slice(before).filter((c) => c.url.endsWith('/myself')).length;
  assert.strictEqual(myself, 2, 'one check before storing, one for the session: writing jay.site does not restart again');
  assert.strictEqual(h.secrets.m.get('jay.email'), 'ann@example.com');
  assert.strictEqual(h.secrets.m.get('jay.apiToken'), 'tok-good');
  assert.strictEqual(ui.config['jay.site'], SITE);
  const st = lastState(h.view);
  assert.strictEqual(st.signedIn, true);
  assert.strictEqual(st.account, 'Signed in as ann@example.com (API token)');
  assert.deepStrictEqual(keysOf(st), ['DEMO-1']);
  const last = h.fetch.calls.at(-1);
  assert.ok(last.url.startsWith(SITE + '/rest/api/3/'));
  assert.strictEqual(last.auth, 'Basic ' + Buffer.from('ann@example.com:tok-good').toString('base64'));
});

test('the account line shows the email Jira reports, else the sign-in email, else the name', async () => {
  let h = start({ world: { me: { ...ME, emailAddress: 'ann.jira@example.com' } } });
  await settle();
  assert.strictEqual(lastState(h.view).account, 'Signed in as ann.jira@example.com (API token)');
  h = start({});
  await settle();
  assert.strictEqual(lastState(h.view).account, 'Signed in as ann@example.com (API token)', 'myself has no email: the sign-in email');
});

test('env token file: JIRA_USERNAME is the fallback email', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-env-'));
  const file = path.join(home, 'env');
  fs.writeFileSync(file, `JIRA_URL=${SITE}\nJIRA_USERNAME=env.ann@example.com\nJIRA_API_TOKEN=tok-env\n`, { mode: 0o600 });
  const h = start({ config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.strictEqual(lastState(h.view).account, 'Signed in as env.ann@example.com (token file)');
});

test('jay.site, jay.signIn.tokenFile and jay.signIn.refreshCommand are read from user settings only', async () => {
  // a repo's .vscode/settings.json points the token at another site: ignored
  let h = start({ workspaceConfig: { 'jay.site': 'https://other.example.net' } });
  await settle();
  assert.ok(h.fetch.calls.length > 0);
  for (const c of h.fetch.calls) assert.ok(c.url.startsWith(SITE + '/'), c.url);
  // ... or at a token file of its own: the API token stays in use and nothing is watched
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-ws-'));
  h = start({ workspaceConfig: { 'jay.signIn.tokenFile': tokenFile(home) } });
  await settle();
  assert.strictEqual(lastState(h.view).account, 'Signed in as ann@example.com (API token)');
  assert.strictEqual(ui.watchers.length, 0);
  for (const c of h.fetch.calls) assert.ok(c.url.startsWith(SITE + '/'), c.url);
  // ... or chooses the refresh command for an expired token file: never run
  const ran = [];
  const file = tokenFile(home, JWT({ sub: 'x', exp: 1 }));
  h = start({ config: { 'jay.signIn.tokenFile': file }, workspaceConfig: { 'jay.signIn.refreshCommand': 'touch /tmp/owned' },
    run: async (cmd) => { ran.push(cmd); return { code: 1, timedOut: false, stderr: '' }; } });
  await settle();
  assert.deepStrictEqual(ran, []);
  // the user's own refresh command is the one run
  h = start({ config: { 'jay.signIn.tokenFile': file, 'jay.signIn.refreshCommand': 'my-login --refresh' }, workspaceConfig: { 'jay.signIn.refreshCommand': 'touch /tmp/owned' },
    run: async (cmd) => { ran.push(cmd); return { code: 1, timedOut: false, stderr: '' }; } });
  await settle();
  assert.deepStrictEqual([...new Set(ran)], ['my-login --refresh']);
});

test('token file setting wins over secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tf-'));
  const token = JWT({ sub: 'tf' });
  const file = tokenFile(home, token);
  const h = start({ config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.ok(h.fetch.calls.length > 0);
  for (const c of h.fetch.calls) {
    assert.ok(c.url.startsWith('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/'), c.url);
    assert.strictEqual(c.auth, 'Bearer ' + token);
  }
  assert.strictEqual(lastState(h.view).account, 'Signed in as Ann Example (token file)');
  assert.strictEqual(ui.watchers.length, 1, 'the token file is watched');
});

test('SignInNeeded stops polling and a token file change resumes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tf-'));
  const file = tokenFile(home);
  const h = start({ config: { 'jay.signIn.tokenFile': '~/creds.json' }, world: { reject: true } });
  await settle();
  assert.strictEqual(lastState(h.view).error, 'Sign in again with the tool that writes the token file', 'a missing token file');
  // ~ expands to deps.home
  fs.copyFileSync(file, path.join(h.home, 'creds.json'));
  await ui.commands['jay.refresh']();
  await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.signedIn, false);
  assert.strictEqual(st.error, 'Sign in again with the tool that writes the token file');
  assert.deepStrictEqual(h.timers.delays(), [30000], 'all three pollers stopped; only the token file check is waiting');
  const n = h.fetch.calls.length;
  h.timers.fire(); await settle();
  assert.strictEqual(h.fetch.calls.length, n, 'no polls while signed out');

  h.world.reject = false;
  fs.writeFileSync(path.join(h.home, 'creds.json'), JSON.stringify({ access_token: JWT({ sub: 'new' }), cloud_id: 'cloud-1', jira_url: SITE }));
  ui.watchers.at(-1).changed.fire({});
  await settle();
  assert.strictEqual(lastState(h.view).signedIn, true);
  assert.strictEqual(lastState(h.view).error, null);
  assert.ok(h.fetch.calls.length > n, 'polling resumed');
  assert.strictEqual(h.timers.pending.size, 3);
});

const EXPIRED = () => JWT({ sub: 'x', exp: Math.floor(Date.UTC(2027, 0, 15, 12) / 1000) - 3600 });
function rewrite(file, token, bump = 5000) {   // another tool's atomic temp+rename: new inode and mtime, no watcher event
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ access_token: token, cloud_id: 'cloud-1', jira_url: SITE }));
  const t = new Date(Date.now() + bump); fs.utimesSync(tmp, t, t);
  fs.renameSync(tmp, file);
}

test('expired token file, no refresh command: a renewed file is noticed by the 30 s check without a watcher event', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tfm-'));
  const file = tokenFile(home, EXPIRED());
  const h = start({ home, config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.strictEqual(lastState(h.view).signedIn, false);
  assert.strictEqual(lastState(h.view).error, 'Sign in again with the tool that writes the token file');
  assert.deepStrictEqual(h.timers.delays(), [30000], 'the file is checked every 30 s');
  h.timers.fire(); await settle();   // unchanged: stays signed out, checks again
  assert.strictEqual(lastState(h.view).signedIn, false);
  assert.deepStrictEqual(h.timers.delays(), [30000]);
  rewrite(file, JWT({ sub: 'fresh' }));
  h.timers.fire(); await settle();
  assert.strictEqual(lastState(h.view).signedIn, true, 'signed in again');
  assert.strictEqual(h.timers.pending.size, 3, 'only the pollers: no file check once running');
});

test('a token file that appears later is noticed by the 30 s check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tfa-'));
  const file = path.join(home, 'creds.json');
  const h = start({ home, config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.strictEqual(lastState(h.view).signedIn, false);
  assert.deepStrictEqual(h.timers.delays(), [30000]);
  tokenFile(home);
  h.timers.fire(); await settle();
  assert.strictEqual(lastState(h.view).signedIn, true);
});

test('the token file check stops on Sign Out, on a token file setting change, and on dispose', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tfs-'));
  const file = tokenFile(home, EXPIRED());
  let h = start({ home, config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.deepStrictEqual(h.timers.delays(), [30000]);
  await ui.commands['jay.signOut']();
  assert.strictEqual(h.timers.pending.size, 0, 'Sign Out');
  ext.deactivate(); running.length = 0;

  h = start({ home, config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.deepStrictEqual(h.timers.delays(), [30000]);
  ui.setConfig('jay.signIn.tokenFile', '');
  await settle();
  assert.strictEqual(h.timers.pending.size, 3, 'the setting changed away from the token file: only the pollers (API token sign-in)');

  h = start({ home, config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.deepStrictEqual(h.timers.delays(), [30000]);
  ext.deactivate(); running.length = 0;
  assert.strictEqual(h.timers.pending.size, 0, 'dispose');
});

test('API token rejected: the sidebar says to sign in again', async () => {
  const h = start({ world: { reject: true } });
  await settle();
  assert.strictEqual(lastState(h.view).error, 'API token rejected: jay: Sign In again');
  assert.strictEqual(h.timers.pending.size, 0);
});

test('default quarter recomputed on refresh', async () => {
  const label = (id) => [raw('DEMO-1', { epic: true, labels: [id] })];
  const h = start({
    t: new Date(2027, 0, 31, 12).getTime(), stored: { 'jay.quarter': undefined },
    config: { 'jay.quarter.fiscalYearStart': 5 }, world: { epics: { DEMO: label('FY2027Q3') } },
  });
  await settle();
  assert.strictEqual(lastState(h.view).quarter, 'FY2027Q3');
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
  h.clock.t = new Date(2027, 1, 1, 12).getTime();
  h.world.epics.DEMO = label('FY2027Q4');
  await ui.commands['jay.refresh']();
  await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.quarter, 'FY2027Q4');
  assert.strictEqual(st.quarters[1].id, 'FY2027Q4');
  assert.ok(h.fetch.calls.some((c) => c.jql && c.jql.includes('"FY2027Q4"')));
  assert.deepStrictEqual(keysOf(st), ['DEMO-1']);
});

test('changing project shows cache first then loads', async () => {
  const h = start({ world: { epics: { DEMO: [raw('DEMO-1', { epic: true })], OTH: [raw('OTH-1', { epic: true })] } } });
  await settle();
  h.view.webview._receive({ type: 'setProject', key: 'NOPE' });
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO', 'a project not in the list is ignored');
  h.view.webview._receive({ type: 'setProject', key: 'OTH' });
  await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['OTH-1']);

  // back to DEMO: Jira now has a second epic, but answers only once released
  h.world.epics.DEMO = [raw('DEMO-1', { epic: true }), raw('DEMO-9', { epic: true })];
  let release; h.world.gate = new Promise((r) => { release = r; });
  h.view.webview._receive({ type: 'setProject', key: 'DEMO' });
  const shown = lastState(h.view);
  assert.strictEqual(shown.project, 'DEMO');
  assert.deepStrictEqual(keysOf(shown), ['DEMO-1'], 'the cached DEMO view, at once');
  h.world.gate = null; release();
  await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-9', 'DEMO-1']);
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO');
});

test('page messages are validated', async () => {
  const h = start();
  await settle();
  const r = (m) => h.view.webview._receive(m);
  r({ type: 'setMode', mode: 'weird' }); r({ type: 'setQuarter', id: 'FY1999Q1' }); r({ type: 'open', key: 'not a key' }); r({ type: 'open', key: { x: 1 } });
  assert.strictEqual(h.gs.get('jay.mode'), undefined);
  assert.strictEqual(h.gs.get('jay.quarter'), 'any');
  assert.strictEqual(ui.panels.length, 0);
  r({ type: 'setMode', mode: 'all' });
  assert.strictEqual(lastState(h.view).mode, 'all');
  assert.deepStrictEqual(lastState(h.view).groups.map((g) => g.id), ['claimed']);
  r({ type: 'open', key: 'demo-2' });
  assert.strictEqual(ui.panels.at(-1).title, 'DEMO-2');
});

test('activeIssueFile returns the front tab\'s file; null with agentFiles false', async () => {
  const h = start();
  await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' });
  await settle();
  const file = path.join(h.jayDir, 'issues', 'DEMO-1.jira');
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), file);
  assert.ok(fs.readFileSync(path.join(h.jayDir, 'current.jira'), 'utf8').includes('DEMO-1'));
  ui.setConfig('jay.agentFiles', false);
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
  assert.ok(!fs.existsSync(file), 'agent files removed');
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'current.jira')));
  assert.ok(fs.existsSync(path.join(h.jayDir, 'seen.json')), 'seen state is not an agent file');
});

test('Sign Out in one window signs out the others: secrets removed, or the flag seen at the next poll', async () => {
  const a = start({});
  await settle();
  const signOutA = ui.commands['jay.signOut'];
  const b = start({ secrets: a.secrets, gs: a.gs, home: a.home });
  await settle();
  b.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' }); await settle();
  assert.ok(fs.existsSync(path.join(b.jayDir, 'issues', 'DEMO-1.jira')));
  await signOutA(); await settle();
  assert.strictEqual(b.api.state.running, false, 'the other window stopped');
  assert.strictEqual(lastState(b.view).signedIn, false);
  assert.strictEqual(lastState(b.view).error, null, 'signed out, not an error');
  assert.ok(panel.disposed, "the other window's tabs closed");
  assert.strictEqual(b.timers.pending.size, 0, 'its pollers stopped');
  const n = b.fetch.calls.length;
  b.timers.fire(); await settle();
  assert.strictEqual(b.fetch.calls.length, n);
  assert.ok(!fs.existsSync(path.join(b.jayDir, 'issues', 'DEMO-1.jira')), 'nothing re-created under ~/.jay');
  a.api.dispose();

  // a token-file sign-in has no secrets to remove: the signed-out flag is checked at the start of each poll
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tf-'));
  const c = start({ config: { 'jay.signIn.tokenFile': tokenFile(home) } });
  await settle();
  const m = c.fetch.calls.length;
  await c.gs.update('jay.signedOut', true);
  c.timers.fire(); await settle();
  assert.strictEqual(c.fetch.calls.length, m, 'no request once signed out elsewhere');
  assert.strictEqual(c.api.state.running, false);
  assert.strictEqual(c.timers.pending.size, 0);
  assert.strictEqual(lastState(c.view).signedIn, false);
});

test('signOut deletes secrets and ~/.jay files, not the token file', async () => {
  const h = start();
  const file = tokenFile(h.home);
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  ui.panels.at(-1).webview._receive({ type: 'ready' });
  await settle();
  assert.ok(fs.existsSync(path.join(h.jayDir, 'seen.json')));
  assert.ok(fs.existsSync(path.join(h.jayDir, 'cache')));
  assert.ok(fs.existsSync(path.join(h.jayDir, 'issues', 'DEMO-1.jira')));
  await ui.commands['jay.signOut']();
  assert.strictEqual(h.secrets.m.size, 0);
  assert.ok(ui.panels.every((p) => p.disposed), 'ticket tabs closed');
  for (const f of ['seen.json', 'cache', 'issues', 'current.jira']) assert.ok(!fs.existsSync(path.join(h.jayDir, f)), f);
  assert.ok(fs.existsSync(file), 'the token file is never touched');
  assert.strictEqual(lastState(h.view).signedIn, false);
  h.timers.fire(); await ui.commands['jay.refresh'](); await settle();
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'seen.json')), 'nothing re-creates ~/.jay files after sign out');
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'cache')));
});

test('unfocused window polls four times slower', async () => {
  let h = start();
  await settle();
  assert.deepStrictEqual(h.timers.delays(), [30000, 60000, 300000]);
  ext.deactivate(); running.length = 0;
  h = start({ focused: false });
  await settle();
  assert.deepStrictEqual(h.timers.delays(), [120000, 240000, 1200000]);
});

test('a mention lights the epic and the badge; seen clears it', async () => {
  const doc = (content) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });
  const h = start();
  await settle();
  assert.strictEqual(h.view.badge, undefined);
  h.clock.t += 120000;
  const at = new Date(h.clock.t - 30000).toISOString();
  h.world.updated = [raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER, updated: at })];
  h.world.comments = { 'DEMO-2': [{ id: '1', author: OTHER, created: at, updated: at, body: doc([{ type: 'mention', attrs: { id: ME.accountId, text: '@Ann' } }]) }] };
  await ui.commands['jay.refresh']();
  await settle();
  const st = lastState(h.view);
  assert.deepStrictEqual(st.events['DEMO-1'], { mention: true, bold: true, newEpic: false }, 'rolled up to the epic');
  assert.strictEqual(st.events['DEMO-2'].mention, true);
  assert.deepStrictEqual(h.view.badge, { value: 1, tooltip: '1 new' });
  assert.ok(h.fetch.calls.some((c) => c.url.includes('/issue/DEMO-2/comment')));
  assert.ok(!h.fetch.calls.some((c) => c.url.includes('/issue/DEMO-1/comment')), 'comments only for changed issues');
  h.view.webview._receive({ type: 'open', key: 'DEMO-2' });
  ui.panels.at(-1).webview._receive({ type: 'ready' });
  await settle();
  assert.strictEqual(lastState(h.view).events['DEMO-1'], undefined);
  assert.strictEqual(h.view.badge, undefined);
});

const docOf = (content) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });

test('a description that newly mentions me lights the ticket', async () => {
  const h = start();
  await settle();
  h.clock.t += 120000;
  const at = new Date(h.clock.t - 30000).toISOString();
  h.world.updated = [raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER, updated: at, description: docOf([{ type: 'mention', attrs: { id: ME.accountId, text: '@Ann' } }]) })];
  await ui.commands['jay.refresh']();
  await settle();
  assert.strictEqual(lastState(h.view).events['DEMO-2'].mention, true);
  const updated = h.fetch.calls.filter((c) => c.jql && /AND updated >= /.test(c.jql));
  assert.ok(updated.length && updated.every((c) => c.fields.includes('description')), 'the updated-since and mine searches ask for the description');
});

test('an old description mention does not light on a later status-only change', async () => {
  const mentioning = docOf([{ type: 'mention', attrs: { id: ME.accountId, text: '@Ann' } }]);
  const h = start({ world: { children: [raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER, description: mentioning })] } });
  await settle();
  assert.ok(h.fetch.calls.filter((c) => c.jql).every((c) => c.fields.includes('description')), 'full loads read the description too');
  h.clock.t += 120000;
  const moved = raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER, description: mentioning, updated: new Date(h.clock.t - 30000).toISOString() });
  moved.fields.status = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
  h.world.updated = [moved];
  await ui.commands['jay.refresh']();
  await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.groups[0].nodes[0].children[0].status, 'In Progress', 'the change was seen');
  assert.strictEqual(st.events['DEMO-2'], undefined);
});

test('restart shows nothing of the last sign-in until it knows who this is', async () => {
  const h = start();
  await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
  ui.setConfig('jay.site', SITE);   // a restart; the state below is what shows before myself() answers
  const st = lastState(h.view);
  assert.deepStrictEqual(st.groups, []);
  assert.strictEqual(st.account, 'Signing in…');
  assert.strictEqual(h.view.badge, undefined);
  await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
  assert.strictEqual(lastState(h.view).account, 'Signed in as ann@example.com (API token)');
});

test('the offline note stays until the poller that went offline succeeds', async () => {
  const h = start();
  await settle();
  const [tree, tab, mine] = h.api.pollers;
  h.world.offline = true;
  tree.kick(); mine.kick(); await settle();
  assert.strictEqual(lastState(h.view).note, 'Offline, retrying');
  tab.kick(); await settle();
  assert.strictEqual(lastState(h.view).note, 'Offline, retrying', 'a tab poll succeeding does not clear it');
  h.world.offline = false;
  tree.kick(); await settle();
  assert.strictEqual(lastState(h.view).note, 'Offline, retrying', 'the mine poll is still offline');
  mine.kick(); await settle();
  assert.strictEqual(lastState(h.view).note, null);
});

test('a 429 on the visible tab makes the tab poller back off', async () => {
  const h = start();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  ui.panels.at(-1).webview._receive({ type: 'ready' });
  await settle();
  h.world.fail = (p, init) => (p === '/rest/api/3/issue/DEMO-1' && init.method === 'GET' ? new Response('{}', { status: 429 }) : undefined);
  h.api.pollers[1].kick(); await settle();
  assert.deepStrictEqual(h.timers.delays(), [5000, 60000, 300000]);
});

test('the mine poll window covers the time since its last success', async () => {
  const h = start({ focused: false });
  await settle();
  const mineJql = () => h.fetch.calls.filter((c) => c.jql && c.jql.startsWith('assignee = currentUser()')).map((c) => c.jql);
  assert.deepStrictEqual(mineJql(), ['assignee = currentUser() AND updated >= "-6m"']);
  h.clock.t += 20 * 60000;
  h.timers.fire(); await settle();
  const m = Number(/-(\d+)m"$/.exec(mineJql().at(-1))[1]);
  assert.ok(m >= 21, `window ${m}m`);
  h.clock.t += 30 * 86400000;
  h.timers.fire(); await settle();
  assert.strictEqual(mineJql().at(-1), 'assignee = currentUser() AND updated >= "-10080m"', 'capped at 7 days');
});

test('signing in as someone else resets the view and events; the same account keeps them', async () => {
  const h = start();
  await settle();
  const events = h.api.state.events;
  const epicLoads = () => h.fetch.calls.filter((c) => c.jql && c.jql.includes('issuetype = Epic')).length;
  let loads = epicLoads();
  ui.setConfig('jay.site', SITE); await settle();
  assert.strictEqual(h.api.state.events, events, 'same account: same events');
  assert.strictEqual(epicLoads(), loads + 1, 'every sign-in reloads the view in full');
  h.world.me = { accountId: 'acc-cy', displayName: 'Cy Other', emailAddress: 'cy@example.com' };
  loads = epicLoads();
  ui.setConfig('jay.site', SITE); await settle();
  assert.notStrictEqual(h.api.state.events, events, 'another account: new events');
  assert.strictEqual(epicLoads(), loads + 1);
  assert.strictEqual(lastState(h.view).account, 'Signed in as cy@example.com (API token)');
});

test('Sign In clears the signed-out flag only on success; setMode reloads in full', async () => {
  const h = start();
  await settle();
  const epicLoads = () => h.fetch.calls.filter((c) => c.jql && c.jql.includes('issuetype = Epic')).length;
  const loads = epicLoads();
  h.view.webview._receive({ type: 'setMode', mode: 'all' }); await settle();
  assert.strictEqual(epicLoads(), loads + 1);
  await ui.commands['jay.signOut']();
  assert.strictEqual(h.gs.get('jay.signedOut'), true);
  h.world.reject = true;
  ui.inputs.push(SITE, 'ann@example.com', 'bad');
  await ui.commands['jay.signIn']();
  assert.strictEqual(h.gs.get('jay.signedOut'), true, 'still signed out after a failed sign-in');
  ui.inputs.push(undefined);
  await ui.commands['jay.signIn']();
  assert.strictEqual(h.gs.get('jay.signedOut'), true, 'still signed out after a cancelled sign-in');
  h.world.reject = false;
  ui.inputs.push(SITE, 'ann@example.com', 'good');
  await ui.commands['jay.signIn']();
  assert.strictEqual(h.gs.get('jay.signedOut'), undefined);
});

function envFile(home, token = 'tok-env') {
  const f = path.join(home, 'jira-mcp');
  fs.writeFileSync(f, `#!/bin/bash\nexport JIRA_URL="${SITE}/"\nexport JIRA_USERNAME=ann@example.com\nexport JIRA_API_TOKEN=${token}\nexec mcp-atlassian "$@"\n`, { mode: 0o600 });
  return f;
}
test('signing in from an env token file shows the tree with basic auth to JIRA_URL', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-env-'));
  const file = envFile(home);
  const h = start({ config: { 'jay.signIn.tokenFile': file } });
  await settle();
  assert.ok(h.fetch.calls.length > 0);
  for (const c of h.fetch.calls) {
    assert.ok(c.url.startsWith(SITE + '/rest/api/3/'), c.url);
    assert.strictEqual(c.auth, 'Basic ' + Buffer.from('ann@example.com:tok-env').toString('base64'));
  }
  const st = lastState(h.view);
  assert.strictEqual(st.signedIn, true); assert.deepStrictEqual(keysOf(st), ['DEMO-1']);
  assert.strictEqual(ui.watchers.length, 1, 'the env file is watched too');
});
test('a 401 from an env token file says to update the token in the file and stops polling', async () => {
  const h = start({ config: { 'jay.signIn.tokenFile': '~/jira-mcp' }, world: { reject: true } });
  envFile(h.home, 'tok-secret-xyz');
  await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.signedIn, false);
  assert.strictEqual(st.error, 'Update the Jira API token in ~/jira-mcp');
  assert.deepStrictEqual(h.timers.delays(), [30000], 'all pollers stopped; only the token file check is waiting');
  assert.ok(!JSON.stringify(h.view.webview.posted).includes('tok-secret-xyz') && !ui.out.some((l) => l.includes('tok-secret-xyz')));
});

const searchReplies = (view) => view.webview.posted.filter((m) => m.type === 'searchResults');
const textCalls = (h) => h.fetch.calls.filter((c) => c.jql && c.jql.startsWith('text ~'));

test('sidebar search: exact JQL, 20-item cap, mapped items', async () => {
  const hits = Array.from({ length: 30 }, (_, i) => raw(`OTH-${i + 1}`, { summary: `Widget ${i + 1}`, assignee: i === 0 ? ME : i === 1 ? null : OTHER }));
  hits[2].fields.status = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
  const h = start({ world: { search: (body, ok) => ok({ issues: hits.slice(0, body.maxResults), nextPageToken: 'more' }) } });
  await settle();
  h.view.webview._receive({ type: 'search', id: 7, query: 'wid"get\\x' });
  await settle();
  const [call] = textCalls(h);
  assert.strictEqual(call.jql, String.raw`text ~ "wid\\\"get\\\\x" ORDER BY updated DESC`);
  assert.ok(call.fields.includes('summary') && !call.fields.includes('description'));
  const [r] = searchReplies(h.view);
  assert.strictEqual(textCalls(h).length, 1, 'the cap stops paging');
  assert.strictEqual(r.id, 7); assert.strictEqual(r.query, 'wid"get\\x'); assert.strictEqual(r.items.length, 20);
  const rest = { type: 'Task', priority: null, due: null, labels: [], estimate: null };
  assert.deepStrictEqual(r.items[0], { key: 'OTH-1', summary: 'Widget 1', who: 'Ann', status: null, mine: true, assignee: 'Ann Example', statusName: 'To Do', owner: 'me', ...rest });
  assert.deepStrictEqual(r.items[1], { key: 'OTH-2', summary: 'Widget 2', who: '-', status: null, mine: false, assignee: null, statusName: 'To Do', owner: 'none', ...rest });
  assert.deepStrictEqual(r.items[2], { key: 'OTH-3', summary: 'Widget 3', who: 'Bo', status: 'In Progress', mine: false, assignee: 'Bo Sample', statusName: 'In Progress', owner: 'other', ...rest });
});

test('sidebar search: a key-like query is looked up on its own; a missing one is ignored, a real one comes first', async () => {
  const hits = [raw('OTH-1', { summary: 'About UTF-8' }), raw('DEMO-2')];
  const h = start({ world: { search: (b, ok) => ok({ issues: hits }) } });
  await settle();
  h.view.webview._receive({ type: 'search', id: 1, query: 'UTF-8' });
  await settle();
  assert.strictEqual(textCalls(h)[0].jql, String.raw`text ~ "UTF\\-8" ORDER BY updated DESC`, 'no key clause, which Jira would reject');
  assert.ok(h.fetch.calls.some((c) => c.url.includes('/rest/api/3/issue/UTF-8')), 'the key is looked up');
  assert.deepStrictEqual(searchReplies(h.view)[0].items.map((i) => i.key), ['OTH-1', 'DEMO-2'], "its 404 is ignored: the text results still show");
  h.view.webview._receive({ type: 'search', id: 2, query: 'demo-2' });
  await settle();
  assert.strictEqual(textCalls(h)[1].jql, String.raw`text ~ "demo\\-2" ORDER BY updated DESC`);
  assert.deepStrictEqual(searchReplies(h.view)[1].items.map((i) => i.key), ['DEMO-2', 'OTH-1'], 'the issue itself first, once');
  // a 400 for the key is ignored too; any other failure is a failed search
  h.world.fail = (p) => (p === '/rest/api/3/issue/ABC-1' ? new Response('{}', { status: 400 }) : null);
  h.view.webview._receive({ type: 'search', id: 3, query: 'ABC-1' });
  await settle();
  assert.deepStrictEqual(searchReplies(h.view)[2].items.map((i) => i.key), ['OTH-1', 'DEMO-2']);
});

test('sidebar search: Lucene special characters are escaped inside the JQL string', async () => {
  const h = start({ world: { search: (b, ok) => ok({ issues: [] }) } });
  await settle();
  const cases = [['[Q3FY27]', String.raw`\\[Q3FY27\\]`], ['C++', String.raw`C\\+\\+`], ['a && b || !c', String.raw`a \\&\\& b \\|\\| \\!c`],
    ['(x){y}^"z"~*?:/', String.raw`\\(x\\)\\{y\\}\\^\\\"z\\\"\\~\\*\\?\\:\\/`], [String.raw`back\slash`, String.raw`back\\\\slash`]];
  let id = 0;
  for (const [q] of cases) h.view.webview._receive({ type: 'search', id: ++id, query: q });
  await settle();
  assert.deepStrictEqual(textCalls(h).map((c) => c.jql), cases.map(([, e]) => `text ~ "${e}" ORDER BY updated DESC`));
});

test('sidebar search: invalid messages are ignored', async () => {
  const h = start({ world: { search: (b, ok) => ok({ issues: [] }) } });
  await settle();
  for (const m of [{ query: 'abc' }, { id: 1 }, { id: '1', query: 'abc' }, { id: 1, query: 'ab' }, { id: 1, query: 5 }, { id: 1, query: 'x'.repeat(201) }]) h.view.webview._receive({ type: 'search', ...m });
  await settle();
  assert.strictEqual(textCalls(h).length, 0); assert.strictEqual(searchReplies(h.view).length, 0);
  h.view.webview._receive({ type: 'search', id: 1, query: 'x'.repeat(200) });
  await settle();
  assert.strictEqual(textCalls(h).length, 1);
});

test('sidebar search: not signed in replies with the error', async () => {
  const h = start({ signedOut: true });
  await settle();
  h.view.webview._receive({ type: 'search', id: 3, query: 'widget' });
  await settle();
  assert.deepStrictEqual(searchReplies(h.view), [{ type: 'searchResults', id: 3, query: 'widget', error: 'Jira search failed' }]);
  assert.strictEqual(h.fetch.calls.length, 0);
});

test('sidebar search: a failing search leaves sign-in, pollers and note alone', async () => {
  for (const fail of [() => new Response('{}', { status: 401 }), () => { throw new TypeError('fetch failed'); }, () => new Response('{}', { status: 500 })]) {
    const h = start({});
    await settle();
    const before = { st: lastState(h.view), pending: h.timers.pending.size, running: h.api.state.running };
    h.world.fail = (p) => (/search\/jql/.test(p) ? fail() : null);
    h.world.search = () => { throw new Error('unused'); };
    h.view.webview._receive({ type: 'search', id: 9, query: 'widget' });
    await settle();
    assert.deepStrictEqual(searchReplies(h.view), [{ type: 'searchResults', id: 9, query: 'widget', error: 'Jira search failed' }]);
    const after = lastState(h.view);
    assert.strictEqual(after.signedIn, true); assert.strictEqual(after.error, before.st.error); assert.strictEqual(after.note, before.st.note);
    assert.strictEqual(h.timers.pending.size, before.pending); assert.strictEqual(h.api.state.running, before.running);
    ext.deactivate(); running.length = 0;
  }
});

test('columns setting is validated and sent in the state; a change re-posts state', async () => {
  const h = start();
  await settle();
  const cols = () => lastState(h.view).columns;
  assert.deepStrictEqual(cols(), ['key', 'summary', 'status'], 'default');
  const set = (v) => { const n = h.view.webview.posted.length; ui.setConfig('jay.columns', v); assert.ok(h.view.webview.posted.length > n, 'state re-posted'); return cols(); };
  assert.deepStrictEqual(set(['key', 'bogus', 'estimate', 'due', 'estimate', 'key']), ['key', 'summary', 'estimate', 'due'], 'unknown and duplicates dropped, summary forced after key');
  assert.deepStrictEqual(set(['priority', 'type']), ['summary', 'priority', 'type'], 'summary first when no key');
  assert.deepStrictEqual(set(['labels', 'key']), ['labels', 'key', 'summary']);
  assert.deepStrictEqual(set('key'), ['key', 'summary', 'status'], 'non-array falls back');
  assert.deepStrictEqual(set([]), ['summary'], 'empty array still shows summary');
});

// ---- periods: quarters, sprints or fix versions
const sprint = (id, state, o = {}) => ({ id, name: `Sprint ${id}`, state, startDate: o.start || null, endDate: o.end || null });
function sprintWorld(o = {}) {
  return Object.assign({
    boards: [{ id: 1, name: 'Demo board', type: 'scrum' }],
    sprints: { 1: [sprint(42, 'active'), sprint(43, 'future', { start: '2027-02-01T00:00:00.000Z' })] },
    versions: [{ id: '10001', name: 'v1.0', released: false, archived: false }],
    inPeriod: {
      'sprint = 42': [raw('DEMO-2', { parent: 'DEMO-1', assignee: OTHER }), raw('DEMO-5')],
      'sprint = 43': [raw('DEMO-6')],
      'fixVersion = 10001': [raw('DEMO-8', { assignee: OTHER })],
    },
  }, o);
}
const jqls = (h) => h.fetch.calls.filter((c) => c.jql).map((c) => c.jql);

test('jay.period sprint: the picker lists sprints and the tree comes from the members; changing the setting swaps without a reload', async () => {
  const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld() });
  await settle();
  let st = lastState(h.view);
  assert.strictEqual(st.periodKind, 'sprint'); assert.strictEqual(st.periodNote, null);
  assert.deepStrictEqual(st.quarters, [{ id: '42', label: 'Sprint 42' }, { id: '43', label: 'Sprint 43 (future)' }, { id: 'any', label: 'Any sprint' }]);
  assert.strictEqual(st.quarter, '42', 'the active sprint by default');
  assert.ok(jqls(h).includes('project = "DEMO" AND sprint = 42'));
  assert.ok(!jqls(h).some((j) => j.includes('issuetype = Epic')), 'no quarter query in sprint mode');
  assert.deepStrictEqual(st.groups.map((g) => g.id), ['mine', 'noepic']);
  assert.deepStrictEqual(keysOf(st), ['DEMO-1', 'DEMO-5']);
  assert.ok(h.fetch.calls.some((c) => c.url.includes('/rest/agile/1.0/board?projectKeyOrId=DEMO')));

  ui.setConfig('jay.period', 'quarter'); await settle();
  st = lastState(h.view);
  assert.strictEqual(st.periodKind, 'quarter'); assert.strictEqual(st.quarter, 'any');
  assert.deepStrictEqual(keysOf(st), ['DEMO-1']); assert.deepStrictEqual(st.groups.map((g) => g.id), ['mine']);
  assert.ok(jqls(h).some((j) => j.includes('issuetype = Epic')));

  ui.setConfig('jay.period', 'fixVersion'); await settle();
  st = lastState(h.view);
  assert.strictEqual(st.periodKind, 'fixVersion');
  assert.deepStrictEqual(st.quarters.map((c) => c.id), ['10001', 'any']); assert.strictEqual(st.quarter, '10001');
  assert.ok(jqls(h).includes('project = "DEMO" AND fixVersion = 10001'));
  ui.view.webview._receive({ type: 'setMode', mode: 'all' }); await settle();
  assert.deepStrictEqual(lastState(h.view).groups.map((g) => [g.id, g.title]), [['noepic', 'No epic']]);
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-8']);
  assert.strictEqual(h.timers.pending.size, 3);
});

test('the Agile API refused: a picker note and the quarter view, the setting untouched, sign-in and pollers kept', async () => {
  for (const status of [401, 403, 404]) {
    const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld({ fail: (p) => (p.startsWith('/rest/agile/') ? new Response('{}', { status }) : null) }) });
    await settle();
    const st = lastState(h.view);
    assert.strictEqual(st.signedIn, true, `${status}`); assert.strictEqual(st.error, null);
    assert.strictEqual(st.periodNote, 'Sprints not available with this sign-in');
    assert.strictEqual(st.periodKind, 'quarter'); assert.strictEqual(st.quarter, 'any');
    assert.deepStrictEqual(keysOf(st), ['DEMO-1']);
    assert.strictEqual(ui.config['jay.period'], 'sprint', 'the setting is not changed');
    assert.strictEqual(h.timers.pending.size, 3, 'all three pollers still scheduled');
    assert.strictEqual(h.api.state.running, true);
    assert.strictEqual(h.fetch.calls.filter((c) => c.url.includes('/rest/agile/')).length, 1, 'no refresh-and-retry on the refusal');
    ext.deactivate(); running.length = 0;
  }
});

test('each mode remembers its own choice; setPeriod is validated against the current choices; setQuarter still works', async () => {
  const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld() });
  await settle();
  const r = (m) => h.view.webview._receive(m);
  r({ type: 'setPeriod', id: 'FY2027Q1' }); r({ type: 'setPeriod', id: 43 }); r({ type: 'setPeriod' });
  assert.strictEqual(h.gs.get('jay.sprint'), undefined, 'not a sprint choice: ignored');
  r({ type: 'setPeriod', id: '43' }); await settle();
  assert.strictEqual(h.gs.get('jay.sprint'), '43');
  assert.strictEqual(lastState(h.view).quarter, '43');
  assert.ok(jqls(h).includes('project = "DEMO" AND sprint = 43'));
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-6']);
  assert.strictEqual(h.gs.get('jay.quarter'), 'any', 'the quarter choice is its own');

  ui.setConfig('jay.period', 'quarter'); await settle();
  assert.strictEqual(lastState(h.view).quarter, 'any');
  r({ type: 'setQuarter', id: 'FY2027Q2' });
  assert.strictEqual(h.gs.get('jay.quarter'), 'FY2027Q2');
  r({ type: 'setPeriod', id: '43' });
  assert.strictEqual(h.gs.get('jay.quarter'), 'FY2027Q2', 'a sprint id is not a quarter choice');

  ui.setConfig('jay.period', 'sprint'); await settle();
  assert.strictEqual(lastState(h.view).quarter, '43', 'back to sprints: the remembered sprint');
  r({ type: 'setPeriod', id: '42' });
  assert.strictEqual(h.gs.get('jay.sprint'), 'current', 'the default follows the active sprint');
});

test('sprint mode: a ticket new to the period is bold and marked new, without the badge; the epic above it rolls up bold', async () => {
  const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld() });
  await settle();
  assert.deepStrictEqual(lastState(h.view).events, {}, 'the first load is the baseline');
  h.clock.t += 120000;
  const joined = raw('DEMO-7', { parent: 'DEMO-1', assignee: OTHER, updated: new Date(h.clock.t - 30000).toISOString() });
  h.world.inPeriod['sprint = 42'].push(joined);
  h.world.children.push(joined);   // so its tab can load
  h.world.updated = [joined];
  await ui.commands['jay.refresh']();
  await settle();
  const st = lastState(h.view);
  assert.ok(jqls(h).includes('key in (DEMO-7) AND sprint = 42'));
  assert.deepStrictEqual(st.events['DEMO-7'], { mention: false, bold: true, newEpic: true });
  assert.deepStrictEqual(st.events['DEMO-1'], { mention: false, bold: true, newEpic: false }, 'a parent epic is not a member');
  assert.strictEqual(h.view.badge, undefined);
  h.view.webview._receive({ type: 'open', key: 'DEMO-7' });
  ui.panels.at(-1).webview._receive({ type: 'ready' });
  await settle();
  assert.strictEqual(lastState(h.view).events['DEMO-7'], undefined, 'seen clears it');
});

test('sign out forgets the cached sprint list (Jira data kept in globalState)', async () => {
  const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld() });
  await settle();
  assert.ok(JSON.stringify(h.gs.get('jay.periodLists')).includes('Sprint 42'));
  await ui.commands['jay.signOut']();
  assert.strictEqual(h.gs.get('jay.periodLists'), undefined);
  assert.deepStrictEqual(lastState(h.view).quarters, [], 'nothing of the list is shown');
});

// ---- review fixes
test('versions: a 401 that survives the refresh is a sign-in problem, not "not available"', async () => {
  const h = start({ config: { 'jay.period': 'fixVersion' }, world: sprintWorld({ fail: (p) => (p.endsWith('/versions') ? new Response('{}', { status: 401 }) : null) }) });
  await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.signedIn, false); assert.strictEqual(st.error, 'API token rejected: jay: Sign In again');
  assert.strictEqual(h.timers.pending.size, 0);
});

test('a project picked while the sprint list is loading loads that project without waiting for the next poll', async () => {
  const world = sprintWorld(); world.inPeriod['OTH|sprint = 42'] = [raw('OTH-3')];
  let release; world.agileGate = new Promise((r) => { release = r; });
  const h = start({ config: { 'jay.period': 'sprint' }, world });
  await settle();
  h.view.webview._receive({ type: 'setProject', key: 'OTH' });
  h.world.agileGate = null; release();
  await settle(80);
  const st = lastState(h.view);
  assert.strictEqual(st.project, 'OTH');
  assert.deepStrictEqual(keysOf(st), ['OTH-3']);
  assert.ok(jqls(h).includes('project = "OTH" AND sprint = 42'));
});

test('a restart fetches the period lists again: a refusal from the last sign-in does not stick', async () => {
  const h = start({ config: { 'jay.period': 'sprint' }, world: sprintWorld({ fail: (p) => (p.startsWith('/rest/agile/') ? new Response('{}', { status: 403 }) : null) }) });
  await settle();
  assert.strictEqual(lastState(h.view).periodNote, 'Sprints not available with this sign-in');
  h.world.fail = null;
  ui.setConfig('jay.site', SITE); await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.periodNote, null); assert.strictEqual(st.quarter, '42');
  assert.deepStrictEqual(keysOf(st), ['DEMO-1', 'DEMO-5']);
});

test('while the first sprint list loads the sidebar says it is loading', async () => {
  const world = sprintWorld();
  let release; world.agileGate = new Promise((r) => { release = r; });
  const h = start({ config: { 'jay.period': 'sprint' }, world });
  await settle();
  let st = lastState(h.view);
  assert.strictEqual(st.loading, true); assert.deepStrictEqual(st.groups, []);
  h.world.agileGate = null; release();
  await settle();
  st = lastState(h.view);
  assert.strictEqual(st.loading, false); assert.deepStrictEqual(keysOf(st), ['DEMO-1', 'DEMO-5']);
  ui.setConfig('jay.period', 'quarter'); await settle();
  assert.strictEqual(lastState(h.view).loading, false);
});

test('recentProjects: most recent first, deduped, max 5, posted; invalid ignored', async () => {
  const projects = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => ({ key: k, name: k }));
  const h = start({ world: { projects, epics: {} }, stored: { 'jay.project': 'A' } });
  await settle();
  assert.deepStrictEqual(lastState(h.view).recentProjects, []);
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'C']) h.view.webview._receive({ type: 'setProject', key: k });
  h.view.webview._receive({ type: 'setProject', key: 'NOPE' });
  await settle();
  assert.deepStrictEqual(h.gs.get('jay.recentProjects'), ['C', 'F', 'E', 'D', 'B']);
  assert.deepStrictEqual(lastState(h.view).recentProjects, ['C', 'F', 'E', 'D', 'B']);
});

// ---- startup without waiting (design 101, "Startup without waiting")
const FP = `token:${SITE}|ann@example.com`;
const remembered = (o = {}) => ({
  'jay.lastSession': { fingerprint: FP, accountId: ME.accountId, displayName: ME.displayName, emailAddress: 'ann@example.com',
    projects: [{ key: 'DEMO', name: 'Demo' }, { key: 'OTH', name: 'Other' }], ...o },
});
function gate() { let release; const p = new Promise((r) => { release = r; }); return { p, release }; }
const statesOf = (view) => view.webview.posted.filter((m) => m.type === 'state');
/** A first window that loads DEMO|any into ~/.jay/cache, then closes: its home is the next window's. */
async function cachedHome(o) { const first = start(o); await settle(); ext.deactivate(); running.splice(running.indexOf(first), 1); return first.home; }
const OLD = { accountId: 'acc-old', displayName: 'Old Name', emailAddress: 'old@example.com' };

test('startup: a remembered sign-in shows the account line, projects and cached tree before myself and projects answer', async () => {
  const home = await cachedHome();
  const who = gate(), projects = gate();
  const h = start({ home, stored: remembered(), world: { hold: { '/rest/api/3/myself': who.p, '/rest/api/3/project/search': projects.p } } });
  await settle();
  const states = statesOf(h.view);
  const shown = states.find((m) => /^Signed in as /.test(m.account || ''));
  assert.ok(shown, 'the account line shows while myself is pending');
  assert.strictEqual(shown.account, 'Signed in as ann@example.com (API token)');
  assert.deepStrictEqual(shown.projects.map((p) => p.key), ['DEMO', 'OTH']);
  assert.deepStrictEqual(keysOf(shown), ['DEMO-1'], 'the cached tree, at once');
  for (const m of states) if (m.signedIn && m.project && !(m.groups || []).length) assert.strictEqual(m.treeLoading, true, 'never "Nothing here" before a load');
  assert.ok(!h.fetch.calls.some((c) => c.jql), 'nothing loaded yet: myself has not answered');
  who.release(); projects.release(); await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
  assert.strictEqual(lastState(h.view).treeLoading, false);
});

test('startup: a different fingerprint shows nothing from the last sign-in, before or after myself', async () => {
  // the last window was acc-old and cached DEMO; this one is another sign-in, and myself says ME
  const home = await cachedHome({ world: { me: OLD } });
  const who = gate(), search = gate();
  const h = start({ home, stored: { ...remembered({ ...OLD, fingerprint: 'token:https://other.atlassian.net|old@example.com' }), 'jay.mode': 'all' },
    world: { hold: { '/rest/api/3/myself': who.p, '/rest/api/3/search/jql': search.p } } });
  await settle();
  assert.ok(!statesOf(h.view).some((m) => /^Signed in as /.test(m.account || '')), 'no account line');
  assert.strictEqual(lastState(h.view).treeLoading, true, '"Loading tickets…"');
  assert.ok(!statesOf(h.view).some((m) => (m.projects || []).length), 'no remembered projects');
  who.release(); await settle();
  assert.strictEqual(lastState(h.view).account, 'Signed in as ann@example.com (API token)');
  const before = statesOf(h.view);
  assert.ok(!before.some((m) => (m.groups || []).length), 'acc-old\'s cache never shows');
  assert.strictEqual(lastState(h.view).treeLoading, true);
  search.release(); await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1'], 'the tree comes from ME\'s own load');
  assert.strictEqual(lastState(h.view).treeLoading, false);
});

test('an account change leaves the old account\'s other cache files unshown at the next startup', async () => {
  const world = { epics: { DEMO: [raw('DEMO-1', { epic: true })], OTH: [raw('OTH-1', { epic: true })] } };
  // window 1: acc-old (A) caches DEMO and OTH
  const first = start({ world: { ...world, me: OLD }, stored: { 'jay.mode': 'all' } });
  await settle();
  first.view.webview._receive({ type: 'setProject', key: 'OTH' }); await settle();
  first.view.webview._receive({ type: 'setProject', key: 'DEMO' }); await settle();
  const stored = { 'jay.mode': 'all', 'jay.lastSession': first.gs.get('jay.lastSession') };
  assert.strictEqual(stored['jay.lastSession'].accountId, OLD.accountId);
  ext.deactivate(); running.splice(running.indexOf(first), 1);
  // window 2: the same fingerprint now confirms ME (B), who loads DEMO
  const h = start({ home: first.home, world, stored });
  await settle();
  assert.strictEqual(h.gs.get('jay.lastSession').accountId, ME.accountId);
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
  // restart, then pick OTH while its load is held: A's OTH cache must not show
  const search = gate(); h.world.hold = { '/rest/api/3/search/jql': search.p };
  ui.setConfig('jay.site', SITE); await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1'], 'B\'s own DEMO cache shows normally after the change');
  const n = statesOf(h.view).length;
  h.view.webview._receive({ type: 'setProject', key: 'OTH' }); await settle();
  const after = statesOf(h.view).slice(n);
  assert.ok(after.some((m) => m.project === 'OTH'));
  for (const m of after.filter((x) => x.project === 'OTH')) { assert.deepStrictEqual(m.groups, [], 'A\'s OTH cache is not shown'); assert.strictEqual(m.treeLoading, true); }
  search.release(); await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['OTH-1']);
});

test('a restart to another sign-in shows no projects from before; remembered projects count only for the same fingerprint', async () => {
  const h = start({ stored: remembered({ fingerprint: 'token:https://other.atlassian.net|ann@example.com' }) });
  await settle();
  assert.deepStrictEqual(lastState(h.view).projects.map((p) => p.key), ['DEMO', 'OTH']);
  const projects = gate(); h.world.hold = { '/rest/api/3/project/search': projects.p };
  h.gs.update('jay.lastSession', { ...h.gs.get('jay.lastSession'), projects: [{ key: 'DEMO', name: 'Demo' }, { key: 'ZED', name: 'Zed' }] });
  tokenFile(h.home);
  ui.setConfig('jay.signIn.tokenFile', '~/creds.json'); await settle();
  assert.deepStrictEqual(lastState(h.view).projects, [], 'the last sign-in\'s projects are gone');
  h.view.webview._receive({ type: 'setProject', key: 'ZED' });
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO', 'the remembered list is another sign-in\'s: not accepted');
  projects.release(); await settle();
});

test('the tab poll and the mine poll wait only for myself, not the project list', async () => {
  const projects = gate();
  const h = start({ world: { hold: { '/rest/api/3/project/search': projects.p } } });
  await settle();
  assert.ok(h.fetch.calls.some((c) => c.jql && c.jql.startsWith('assignee = currentUser()')), 'the mine poll ran');
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  ui.panels.at(-1).webview._receive({ type: 'ready' });
  await settle();
  const gets = () => h.fetch.calls.filter((c) => c.method === 'GET' && c.url.includes('/issue/DEMO-1') && !c.url.includes('/comment')).length;
  const n = gets();
  h.api.pollers[1].kick(); await settle();
  assert.ok(gets() > n, 'the tab poll refreshed the open ticket');
  assert.deepStrictEqual(h.gs.get('jay.lastSession').projects, [], 'the project list is still pending');
  projects.release(); await settle();
});

test('startup: myself returning another account clears the remembered tree', async () => {
  const home = await cachedHome({ world: { me: OLD } });
  const who = gate(), search = gate();
  const h = start({ home, stored: { ...remembered({ accountId: 'acc-old', displayName: 'Old Name', emailAddress: 'old@example.com' }), 'jay.mode': 'all' },
    world: { hold: { '/rest/api/3/myself': who.p, '/rest/api/3/search/jql': search.p } } });
  await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1'], 'the remembered tree first');
  const events = h.api.state.events;
  who.release(); await settle();
  const st = lastState(h.view);
  assert.strictEqual(st.account, 'Signed in as ann@example.com (API token)');
  assert.deepStrictEqual(st.groups, [], 'cleared: it was the other account\'s');
  assert.strictEqual(st.treeLoading, true);
  assert.notStrictEqual(h.api.state.events, events, 'new events');
  assert.strictEqual(h.gs.get('jay.lastSession').accountId, ME.accountId);
  search.release(); await settle();
  assert.deepStrictEqual(keysOf(lastState(h.view)), ['DEMO-1']);
});

test('the tree poll proceeds while the project list is still loading; setProject accepts a remembered key meanwhile', async () => {
  const projects = gate();
  const h = start({ world: { hold: { '/rest/api/3/project/search': projects.p }, epics: { DEMO: [raw('DEMO-1', { epic: true })], OTH: [raw('OTH-1', { epic: true })] } } });
  await settle();
  let st = lastState(h.view);
  assert.strictEqual(st.account, 'Signed in as ann@example.com (API token)');
  assert.deepStrictEqual(keysOf(st), ['DEMO-1'], 'the tree loaded without the project list');
  assert.deepStrictEqual(st.projects, []);
  assert.deepStrictEqual(h.gs.get('jay.lastSession'), { fingerprint: FP, accountId: ME.accountId, displayName: ME.displayName, emailAddress: null, projects: [] });
  h.view.webview._receive({ type: 'setProject', key: 'OTH' });
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO', 'not known yet: not in jay.lastProjects');
  h.view.webview._receive({ type: 'setProject', key: 'DEMO' });
  assert.deepStrictEqual(h.gs.get('jay.recentProjects'), ['DEMO'], 'the current project is accepted');
  projects.release(); await settle();
  st = lastState(h.view);
  assert.deepStrictEqual(st.projects.map((p) => p.key), ['DEMO', 'OTH']);
  assert.deepStrictEqual(h.gs.get('jay.lastSession').projects, [{ key: 'DEMO', name: 'Demo' }, { key: 'OTH', name: 'Other' }], 'kept with the session it belongs to');
  assert.strictEqual(h.gs.get('jay.lastProjects'), undefined, 'no separate key');
});

test('setProject accepts a remembered project before the live list arrives', async () => {
  const projects = gate();
  const h = start({ stored: remembered(), world: { hold: { '/rest/api/3/project/search': projects.p }, projects: [{ key: 'DEMO', name: 'Demo' }] } });
  await settle();
  h.view.webview._receive({ type: 'setProject', key: 'OTH' });
  assert.strictEqual(h.gs.get('jay.project'), 'OTH');
  projects.release(); await settle();
  h.view.webview._receive({ type: 'setProject', key: 'OTH2' });
  assert.strictEqual(h.gs.get('jay.project'), 'OTH');
});

test('Sign Out forgets the remembered sign-in and project list, and the older separate key', async () => {
  const h = start({ stored: { 'jay.lastProjects': [{ key: 'DEMO', name: 'Demo' }] } });
  await settle();
  assert.strictEqual(h.gs.get('jay.lastSession').projects.length, 2);
  await ui.commands['jay.signOut']();
  assert.strictEqual(h.gs.get('jay.lastSession'), undefined);
  assert.strictEqual(h.gs.get('jay.lastProjects'), undefined);
});

test('an older separate jay.lastProjects key is ignored', async () => {
  const projects = gate();
  const { projects: _, ...session } = remembered()['jay.lastSession'];
  const h = start({ stored: { 'jay.lastSession': session, 'jay.lastProjects': [{ key: 'DEMO', name: 'Demo' }, { key: 'ZED', name: 'Zed' }] },
    world: { hold: { '/rest/api/3/project/search': projects.p } } });
  await settle();
  assert.ok(!statesOf(h.view).some((m) => (m.projects || []).length), 'not shown');
  h.view.webview._receive({ type: 'setProject', key: 'ZED' });
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO', 'not accepted');
  projects.release(); await settle();
});

test('myself returning another account drops the remembered projects at once', async () => {
  const projects = gate(), who = gate();
  const h = start({ stored: remembered({ ...OLD, projects: [{ key: 'DEMO', name: 'Demo' }, { key: 'ZED', name: 'Zed' }] }),
    world: { hold: { '/rest/api/3/myself': who.p, '/rest/api/3/project/search': projects.p } } });
  await settle();
  assert.deepStrictEqual(lastState(h.view).projects.map((p) => p.key), ['DEMO', 'ZED'], 'the remembered list first');
  who.release(); await settle();
  assert.deepStrictEqual(lastState(h.view).projects, [], "acc-old's list is gone once myself says ME");
  assert.strictEqual(h.api.state.remembered, false);
  h.view.webview._receive({ type: 'setProject', key: 'ZED' });
  assert.strictEqual(h.gs.get('jay.project'), 'DEMO', 'not accepted');
  assert.deepStrictEqual(h.gs.get('jay.lastSession'), { fingerprint: FP, accountId: ME.accountId, displayName: ME.displayName, emailAddress: null, projects: [] });
  projects.release(); await settle();
  assert.deepStrictEqual(h.gs.get('jay.lastSession').projects, [{ key: 'DEMO', name: 'Demo' }, { key: 'OTH', name: 'Other' }]);
});

test('the remembered sign-in never holds a token (API token and token file)', async () => {
  let h = start();
  await settle();
  const dump = (g) => JSON.stringify(g.keys().map((k) => [k, g.get(k)]));
  assert.strictEqual(h.gs.get('jay.lastSession').fingerprint, FP);
  assert.ok(!dump(h.gs).includes('tok-api'), 'no API token in globalState');
  ext.deactivate();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-host-'));
  const token = JWT({ sub: 'secret-sub' });
  tokenFile(home, token);
  h = start({ home, config: { 'jay.signIn.tokenFile': '~/creds.json' } });
  await settle();
  assert.strictEqual(h.gs.get('jay.lastSession').fingerprint, 'file:~/creds.json', 'the path as written');
  assert.ok(!dump(h.gs).includes(token) && !dump(h.gs).includes('secret-sub'), 'no token in globalState');
});

test('deactivate leaves the ticket tabs and their files for the editor to restore', async () => {
  const h = start();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  const panel = ui.panels.at(-1);
  panel.webview._receive({ type: 'ready' }); await settle();
  ext.deactivate(); running.length = 0;
  assert.strictEqual(panel.disposed, false, 'VS Code disposes the panels itself and the serializer restores them');
  assert.ok(fs.existsSync(path.join(h.jayDir, 'issues', 'DEMO-1.jira')));
});

test('a tab restored before sign-in says it is waiting, then loads once the session is there', async () => {
  const who = gate();
  const h = start({ world: { hold: { '/rest/api/3/myself': who.p } } });
  const panel = vscode.window.createWebviewPanel('jay.ticket', 'DEMO-1', 1, {});
  await ui.serializer.deserializeWebviewPanel(panel, { key: 'DEMO-1' });
  panel.webview._receive({ type: 'ready' }); await settle();
  const types = () => panel.webview.posted.map((m) => m.type);
  assert.ok(!types().includes('loadError'), JSON.stringify(panel.webview.posted));
  assert.deepStrictEqual(panel.webview.posted.find((m) => m.type === 'waiting'), { type: 'waiting', message: 'Waiting for sign-in…' });
  who.release(); await settle();
  assert.strictEqual(types().filter((t) => t === 'render').length, 1, 'rendered once signed in');
  assert.ok(fs.existsSync(path.join(h.jayDir, 'issues', 'DEMO-1.jira')));
});

test('sidebar search: an assignee listed in jay.placeholderAssignees has owner none', async () => {
  const h = start({ world: { search: (body, ok) => ok({ issues: [raw('OTH-1', { summary: 'W', assignee: OTHER })] }) } });
  await settle();
  ui.setConfig('jay.placeholderAssignees', ['Bo Sample']);
  h.view.webview._receive({ type: 'search', id: 1, query: 'widget' });
  await settle();
  const [r] = searchReplies(h.view);
  assert.strictEqual(r.items[0].owner, 'none'); assert.strictEqual(r.items[0].assignee, 'Bo Sample');
});

// ---- jay.ticketView (design 101, "Which view opens a ticket")
test('ticketView default: a click opens the Atlassian page, writes the file, marks seen and current.jira', async () => {
  const h = start();
  const tabs = atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  await settle();
  assert.deepStrictEqual(atlCalls(), [[ATL_COMMAND, 'DEMO-1']]);
  assert.strictEqual(ui.panels.length, 0, "jay's own tab isn't opened");
  assert.strictEqual(ui.infos.length, 0);
  const file = path.join(h.jayDir, 'issues', 'DEMO-1.jira');
  assert.ok(fs.readFileSync(file, 'utf8').includes('DEMO-1 title'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('## Tree'), 'with the chain, as in jay\'s tab');
  assert.ok(seenAt(h, 'DEMO-1') != null, 'marked seen and saved');
  assert.ok(fs.readFileSync(path.join(h.jayDir, 'current.jira'), 'utf8').includes('DEMO-1'));
  assert.ok(tabs['DEMO-1'], 'the Atlassian tab opened');
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), file);
  const gets = h.fetch.calls.filter((c) => /\/issue\/DEMO-1(\?|$)/.test(c.url)).length;
  assert.strictEqual(gets, 1, 'the click fetched once; the tab appearing did not fetch again');
  assert.ok(h.fetch.calls.some((c) => /\/issue\/DEMO-1\/comment/.test(c.url) && /maxResults=50/.test(c.url)), 'the newest 50 comments');
});

test('ticketView default, unfocused window: the file and seen, but no current.jira', async () => {
  const h = start({ focused: false });
  atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  await settle();
  assert.ok(fs.existsSync(path.join(h.jayDir, 'issues', 'DEMO-1.jira')));
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'current.jira')));
});

test('ticketView: no Atlassian extension opens jay\'s tab, with one info message per window session', async () => {
  const h = start();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  assert.strictEqual(ui.panels.at(-1).title, 'DEMO-1', "jay's tab, at once");
  h.view.webview._receive({ type: 'open', key: 'DEMO-2' });
  await settle();
  assert.strictEqual(ui.panels.length, 2);
  assert.strictEqual(atlCalls().length, 0);
  assert.strictEqual(ui.infos.length, 1);
  assert.match(ui.infos[0], /^Opened in jay's view: /);
  assert.strictEqual(ui.out.filter((l) => l.includes("jay's view")).length, 2, 'logged every time');
});

test('ticketView: the Atlassian command failing opens jay\'s tab, message once', async () => {
  const h = start();
  atlassian({ reject: 'no such issue page' });
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-2' });
  await settle();
  assert.strictEqual(atlCalls().length, 2);
  assert.deepStrictEqual(ui.panels.map((p) => p.title), ['DEMO-1', 'DEMO-2']);
  assert.deepStrictEqual(ui.infos, ["Opened in jay's view: no such issue page"]);
  assert.strictEqual(ui.out.filter((l) => l.includes('no such issue page')).length, 2);
});

test('ticketView "jay": jay\'s tab, no Atlassian call', async () => {
  const h = start({ config: { 'jay.ticketView': 'jay' } });
  atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' });
  await settle();
  assert.strictEqual(ui.panels.at(-1).title, 'DEMO-1');
  assert.strictEqual(atlCalls().length, 0);
  assert.strictEqual(ui.infos.length, 0);
});

test('ticketView: a failed fetch writes no file and marks nothing seen', async () => {
  const h = start();
  atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-404' });
  await settle();
  assert.deepStrictEqual(atlCalls(), [[ATL_COMMAND, 'DEMO-404']]);
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'issues', 'DEMO-404.jira')));
  assert.strictEqual(seenAt(h, 'DEMO-404'), null);
  assert.ok(!fs.existsSync(path.join(h.jayDir, 'current.jira')));
  assert.strictEqual(ui.panels.length, 0, 'the Atlassian page shows its own "not found"');
});

test('ticketView: the active Atlassian tab of a tracked key is the ticket in front; untracked or non-key tabs are ignored', async () => {
  const h = start();
  const tabs = atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' }); await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-2' }); await settle();
  const f1 = path.join(h.jayDir, 'issues', 'DEMO-1.jira'); const f2 = path.join(h.jayDir, 'issues', 'DEMO-2.jira');
  const current = () => fs.readFileSync(path.join(h.jayDir, 'current.jira'), 'utf8');
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), f2);
  ui.activateTab(tabs['DEMO-1']); await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), f1);
  assert.ok(/^# Jira \w+ DEMO-1:/.test(current()));
  // a "react" tab jay didn't open, and one whose title isn't a key
  ui.openTab({ label: 'DEMO-9', viewType: ATL_TYPE }); await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
  assert.ok(/^# Jira \w+ DEMO-1:/.test(current()), 'current.jira kept');
  ui.openTab({ label: 'Create issue', viewType: ATL_TYPE }); await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
  assert.ok(!h.fetch.calls.some((c) => c.url.includes('DEMO-9')));
  ui.activateTab(tabs['DEMO-2']); await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), f2);
  assert.ok(/^# Jira \w+ DEMO-2:/.test(current()));
  ui.setConfig('jay.agentFiles', false);
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
});

test('ticketView: the Atlassian tab in front is re-fetched at most once per 30 s, and by the tab poll', async () => {
  const h = start();
  const tabs = atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' }); await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-2' }); await settle();
  const gets = () => h.fetch.calls.filter((c) => /\/issue\/DEMO-1(\?|$)/.test(c.url)).length;
  assert.strictEqual(gets(), 1);
  ui.activateTab(tabs['DEMO-1']); await settle();
  assert.strictEqual(gets(), 1, 'within 30 s of the click: no re-fetch');
  h.clock.t += 31000;
  h.world.children.push(raw('DEMO-3', { parent: 'DEMO-1' }));
  ui.activateTab(tabs['DEMO-2']); ui.activateTab(tabs['DEMO-1']); await settle();
  assert.strictEqual(gets(), 2, 'after 30 s: re-fetched once');
  h.clock.t += 31000;
  h.api.pollers[1].kick(); await settle();
  assert.strictEqual(gets(), 3, 'the tab poll refreshed the Atlassian tab in front');
});

test('ticketView: closing the tracked Atlassian tab removes its file', async () => {
  const h = start();
  const tabs = atlassian();
  await settle();
  h.view.webview._receive({ type: 'open', key: 'DEMO-1' }); await settle();
  const f1 = path.join(h.jayDir, 'issues', 'DEMO-1.jira');
  assert.ok(fs.existsSync(f1));
  const other = ui.openTab({ label: 'DEMO-1', viewType: 'mainThreadWebview-somethingElse' });
  ui.closeTab(tabs['DEMO-1']); await settle();
  assert.ok(!fs.existsSync(f1), 'removed, whatever other tab has the same title');
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
  ui.closeTab(other);
  // no longer tracked: a new "react" tab with that title is ignored until it is clicked again
  ui.openTab({ label: 'DEMO-1', viewType: ATL_TYPE }); await settle();
  assert.strictEqual(await ui.commands['jay.activeIssueFile'](), null);
});

// ---- commands for other extensions (perch): jay.openTicket, jay.projectKeys
test('jay.openTicket routes like a click: Atlassian by default, jay tab with ticketView "jay"', async () => {
  const h = start();
  atlassian();
  await settle();
  assert.strictEqual(await ui.commands['jay.openTicket'](' demo-1 '), true);
  await settle();
  assert.deepStrictEqual(atlCalls(), [[ATL_COMMAND, 'DEMO-1']]);
  assert.strictEqual(ui.panels.length, 0);
  ext.deactivate(); running.length = 0;
  start({ config: { 'jay.ticketView': 'jay' } });
  await settle();
  assert.strictEqual(await ui.commands['jay.openTicket']('DEMO-2'), true);
  await settle();
  assert.strictEqual(ui.panels.at(-1).title, 'DEMO-2');
});

test('jay.openTicket: invalid or missing key, or signed out, returns false and opens nothing', async () => {
  start();
  atlassian();
  await settle();
  for (const bad of ['nope', '', undefined, null, 42, 'DEMO-1; rm']) assert.strictEqual(await ui.commands['jay.openTicket'](bad), false);
  await settle();
  assert.strictEqual(atlCalls().length, 0);
  assert.strictEqual(ui.panels.length, 0);
  ext.deactivate(); running.length = 0;
  start({ signedOut: true, config: { 'jay.site': SITE } });
  atlassian();
  await settle();
  assert.strictEqual(await ui.commands['jay.openTicket']('DEMO-1'), false);
  await settle();
  assert.strictEqual(atlCalls().length, 0);
  assert.strictEqual(ui.panels.length, 0);
});

test('jay.projectKeys returns the loaded project keys; [] when signed out', async () => {
  start();
  await settle();
  assert.deepStrictEqual(await ui.commands['jay.projectKeys'](), ['DEMO', 'OTH']);
  ext.deactivate(); running.length = 0;
  start({ signedOut: true, config: { 'jay.site': SITE } });
  await settle();
  assert.deepStrictEqual(await ui.commands['jay.projectKeys'](), []);
});
