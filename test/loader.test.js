'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createLoader } = require('../src/loader');

const PATTERNS = ['label:FY{YYYY}Q{Q}'];
const Q = { fy: 2027, q: 3 };
const EPIC_JQL = 'project = "DEMO" AND issuetype = Epic AND (labels in ("FY2027Q3"))';
const iss = (key, o = {}) => ({
  key, summary: `Summary ${key}`, isEpic: false, isSubtask: false, parentKey: null, labels: [],
  status: { name: 'To Do', category: 'new' }, updated: '2026-11-19T10:00:00.000+0000', ...o,
});
const epic = (key, o = {}) => iss(key, { isEpic: true, labels: ['FY2027Q3'], ...o });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jay-loader-'));

// A fake api: answers by exact JQL from a table (a function value is called each time), and records every call.
function fakeApi(table) {
  const calls = [];
  return { calls, table, search: async (jql) => {
    calls.push(jql);
    if (!(jql in table)) throw new Error(`unexpected JQL: ${jql}`);
    const v = table[jql]; return typeof v === 'function' ? v() : v;
  } };
}
const clock = (t = 1_000_000_000_000) => { const c = () => c.t; c.t = t; return c; };

function basicTable() {
  return {
    [EPIC_JQL]: [epic('DEMO-1'), epic('DEMO-2'), iss('DEMO-9', { isEpic: true, labels: ['other'] })],
    'parent in (DEMO-1, DEMO-2)': [iss('DEMO-3', { parentKey: 'DEMO-1' }), iss('DEMO-4', { parentKey: 'DEMO-2' })],
    'parent in (DEMO-3, DEMO-4)': [iss('DEMO-5', { parentKey: 'DEMO-3', isSubtask: true })],
  };
}

test('full load issues epic, task and sub-task queries and filters epics by quarter', async () => {
  const api = fakeApi(basicTable()); const now = clock();
  const loader = createLoader({ api, cacheDir: tmp(), now });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS });
  assert.deepStrictEqual(api.calls, [EPIC_JQL, 'parent in (DEMO-1, DEMO-2)', 'parent in (DEMO-3, DEMO-4)']);
  assert.strictEqual(view.key, 'DEMO|FY2027Q3');
  assert.deepStrictEqual(view.epics.map((e) => e.key), ['DEMO-1', 'DEMO-2']);
  assert.deepStrictEqual(view.children.get('DEMO-1').map((e) => e.key), ['DEMO-3']);
  assert.deepStrictEqual(view.children.get('DEMO-3').map((e) => e.key), ['DEMO-5']);
  assert.deepStrictEqual([...view.index.keys()].sort(), ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5']);
  assert.strictEqual(view.loadedAt, now()); assert.strictEqual(view.fullAt, now());
});

test('parent in chunks of 50', async () => {
  const keys = Array.from({ length: 120 }, (_, i) => `DEMO-${i + 1}`);
  const table = { [EPIC_JQL]: keys.map((k) => epic(k)) };
  const chunks = [keys.slice(0, 50), keys.slice(50, 100), keys.slice(100)];
  for (const c of chunks) table[`parent in (${c.join(', ')})`] = [];
  const api = fakeApi(table);
  await createLoader({ api, cacheDir: tmp(), now: clock() }).load({ project: 'DEMO', quarter: Q, patterns: PATTERNS });
  assert.deepStrictEqual(api.calls, [EPIC_JQL, ...chunks.map((c) => `parent in (${c.join(', ')})`)]);
});

test('cached returns the last written view after a new loader starts', async () => {
  const cacheDir = tmp();
  const view = await createLoader({ api: fakeApi(basicTable()), cacheDir, now: clock() }).load({ project: 'DEMO', quarter: Q, patterns: PATTERNS, owner: 'acc-me' });
  const again = createLoader({ api: fakeApi({}), cacheDir, now: clock() }).cached('DEMO|FY2027Q3', 'acc-me');
  assert.deepStrictEqual(again.epics, view.epics);
  assert.ok(again.children instanceof Map && again.index instanceof Map);
  assert.deepStrictEqual([...again.children], [...view.children]);
  assert.deepStrictEqual([...again.index], [...view.index]);
  assert.strictEqual(again.fullAt, view.fullAt);
  assert.strictEqual(createLoader({ api: fakeApi({}), cacheDir, now: clock() }).cached('DEMO|FY2026Q1', 'acc-me'), null);
});

test('a cache file is owned by the account that wrote it: never returned to another account, or with no account', async () => {
  const table = basicTable(); const now = clock(); const cacheDir = tmp();
  const loader = createLoader({ api: fakeApi(table), cacheDir, now });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS, owner: 'acc-a' });
  assert.strictEqual(view.owner, 'acc-a');
  const fresh = () => createLoader({ api: fakeApi({}), cacheDir, now });
  assert.ok(fresh().cached('DEMO|FY2027Q3', 'acc-a'));
  assert.strictEqual(fresh().cached('DEMO|FY2027Q3', 'acc-b'), null, 'another account');
  assert.strictEqual(fresh().cached('DEMO|FY2027Q3'), null, 'no account');
  // a refresh keeps the owner, also when it is a full reload
  now.t += 60000; table['project = "DEMO" AND updated >= "-3m"'] = [];
  const { view: next } = await loader.refresh(view, { patterns: PATTERNS });
  assert.ok(fresh().cached('DEMO|FY2027Q3', 'acc-a') && next.owner === 'acc-a');
  now.t += 16 * 60000;
  const { view: full } = await loader.refresh(next, { patterns: PATTERNS });
  assert.ok(fresh().cached('DEMO|FY2027Q3', 'acc-a') && full.owner === 'acc-a');
  // a file with no owner (written before owners) is nobody's
  const file = path.join(cacheDir, 'DEMO_FY2027Q3.json'); const o = JSON.parse(fs.readFileSync(file, 'utf8')); delete o.owner;
  fs.writeFileSync(file, JSON.stringify(o));
  assert.strictEqual(fresh().cached('DEMO|FY2027Q3', 'acc-a'), null);
});

test('cache file mode is 600 and dir 700, named by the safe view key', async () => {
  const cacheDir = path.join(tmp(), 'cache');
  await createLoader({ api: fakeApi(basicTable()), cacheDir, now: clock() }).load({ project: 'DEMO', quarter: Q, patterns: PATTERNS });
  assert.deepStrictEqual(fs.readdirSync(cacheDir), ['DEMO_FY2027Q3.json']);
  assert.strictEqual(fs.statSync(cacheDir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(cacheDir, 'DEMO_FY2027Q3.json')).mode & 0o777, 0o600);
});

test('any quarter uses statusCategory != Done and keeps all epics', async () => {
  const anyJql = 'project = "DEMO" AND issuetype = Epic AND statusCategory != Done';
  const api = fakeApi({ [anyJql]: [epic('DEMO-1'), iss('DEMO-9', { isEpic: true })], 'parent in (DEMO-1, DEMO-9)': [] });
  const view = await createLoader({ api, cacheDir: tmp(), now: clock() }).load({ project: 'DEMO', quarter: 'any', patterns: PATTERNS });
  assert.deepStrictEqual(api.calls, [anyJql, 'parent in (DEMO-1, DEMO-9)']);
  assert.deepStrictEqual(view.epics.map((e) => e.key), ['DEMO-1', 'DEMO-9']);
  assert.strictEqual(view.key, 'DEMO|any');
});

test('refresh merges an updated task, adds a new epic, moves a re-parented sub-task', async () => {
  const table = basicTable(); const now = clock(); const api = fakeApi(table);
  const loader = createLoader({ api, cacheDir: tmp(), now });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS });
  now.t += 3 * 60000 + 1; // 3.0000167 min -> ceil 4 + 2 = 6
  const refreshJql = 'project = "DEMO" AND updated >= "-6m"';
  table['parent in (DEMO-7, DEMO-8)'] = [];
  table[refreshJql] = [
    iss('DEMO-3', { parentKey: 'DEMO-1', summary: 'Renamed', updated: '2026-11-19T10:05:00.000+0000' }),
    epic('DEMO-7'),
    iss('DEMO-8', { parentKey: 'DEMO-7' }),
    iss('DEMO-5', { parentKey: 'DEMO-4', isSubtask: true, updated: '2026-11-19T10:06:00.000+0000' }),
    iss('DEMO-20', { parentKey: 'DEMO-99' }), // unknown parent: ignored
    epic('DEMO-21', { labels: ['other'] }), // epic outside the quarter: ignored
  ];
  const { view: next, changed } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(api.calls.slice(3), [refreshJql, 'parent in (DEMO-7, DEMO-8)']);
  assert.strictEqual(next.index.get('DEMO-3').summary, 'Renamed');
  assert.deepStrictEqual(next.children.get('DEMO-1').map((e) => e.summary), ['Renamed']);
  assert.deepStrictEqual(next.epics.map((e) => e.key), ['DEMO-1', 'DEMO-2', 'DEMO-7']);
  assert.deepStrictEqual(next.children.get('DEMO-7').map((e) => e.key), ['DEMO-8']);
  assert.deepStrictEqual((next.children.get('DEMO-3') || []).map((e) => e.key), []);
  assert.deepStrictEqual(next.children.get('DEMO-4').map((e) => e.key), ['DEMO-5']);
  assert.ok(!next.index.has('DEMO-20') && !next.index.has('DEMO-21'));
  assert.deepStrictEqual(changed.map((e) => e.key).sort(), ['DEMO-3', 'DEMO-5', 'DEMO-7', 'DEMO-8']);
  assert.strictEqual(next.loadedAt, now()); assert.strictEqual(next.fullAt, view.fullAt);
  assert.strictEqual(view.index.get('DEMO-3').summary, 'Summary DEMO-3'); // the old view is untouched
});

test('refresh after 15 minutes does a full load', async () => {
  const table = basicTable(); const now = clock(); const api = fakeApi(table);
  const loader = createLoader({ api, cacheDir: tmp(), now });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS });
  now.t += 15 * 60000 + 1;
  table[EPIC_JQL] = [epic('DEMO-1')]; // DEMO-2 left the view
  table['parent in (DEMO-1)'] = [iss('DEMO-3', { parentKey: 'DEMO-1', updated: '2026-11-19T11:00:00.000+0000' })];
  table['parent in (DEMO-3)'] = [];
  const { view: next, changed } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(api.calls.slice(3), [EPIC_JQL, 'parent in (DEMO-1)', 'parent in (DEMO-3)']);
  assert.deepStrictEqual([...next.index.keys()].sort(), ['DEMO-1', 'DEMO-3']);
  assert.deepStrictEqual(changed.map((e) => e.key), ['DEMO-3']);
  assert.strictEqual(next.fullAt, now());
});

test('refresh rewrites the cache', async () => {
  const table = basicTable(); const now = clock(); const cacheDir = tmp();
  const loader = createLoader({ api: fakeApi(table), cacheDir, now });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS, owner: 'acc-me' });
  now.t += 60000;
  table['project = "DEMO" AND updated >= "-3m"'] = [epic('DEMO-7')];
  table['parent in (DEMO-7)'] = [];
  await loader.refresh(view, { patterns: PATTERNS });
  assert.ok(createLoader({ api: fakeApi({}), cacheDir, now }).cached('DEMO|FY2027Q3', 'acc-me').index.has('DEMO-7'));
});

async function loaded(table, quarter = Q) {
  const now = clock(); const api = fakeApi(table); const cacheDir = tmp();
  const loader = createLoader({ api, cacheDir, now });
  const view = await loader.load({ project: 'DEMO', quarter, patterns: PATTERNS });
  now.t += 60000;
  return { now, api, cacheDir, loader, view };
}
const WIN = 'project = "DEMO" AND updated >= "-3m"';

test('refresh for any quarter skips Done epics and removes an epic that turned Done with its descendants', async () => {
  const anyJql = 'project = "DEMO" AND issuetype = Epic AND statusCategory != Done';
  const t = { [anyJql]: [epic('DEMO-1')], 'parent in (DEMO-1)': [iss('DEMO-3', { parentKey: 'DEMO-1' })], 'parent in (DEMO-3)': [iss('DEMO-5', { parentKey: 'DEMO-3', isSubtask: true })] };
  const { loader, view } = await loaded(t, 'any');
  const done = { name: 'Done', category: 'done' };
  t[WIN] = [epic('DEMO-1', { status: done, updated: '2026-11-19T11:00:00.000+0000' }), epic('DEMO-8', { status: done })];
  const { view: next } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(next.epics, []); assert.strictEqual(next.index.size, 0); assert.strictEqual(next.children.size, 0);
});

test('refresh fetches descendants of an epic that enters the view', async () => {
  const t = basicTable();
  const { loader, view, api } = await loaded(t);
  t[WIN] = [epic('DEMO-7', { updated: '2026-11-19T11:00:00.000+0000' })];
  t['parent in (DEMO-7)'] = [iss('DEMO-8', { parentKey: 'DEMO-7' })];
  t['parent in (DEMO-8)'] = [iss('DEMO-10', { parentKey: 'DEMO-8', isSubtask: true })];
  const { view: next, changed } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(api.calls.slice(3), [WIN, 'parent in (DEMO-7)', 'parent in (DEMO-8)']);
  assert.ok(next.index.has('DEMO-10'));
  assert.deepStrictEqual(changed.map((i) => i.key), ['DEMO-7', 'DEMO-8', 'DEMO-10']);
});

test('refresh fetches the sub-tasks of a task moved into a known epic', async () => {
  const t = basicTable();
  const { loader, view } = await loaded(t);
  t[WIN] = [iss('DEMO-30', { parentKey: 'DEMO-1' })];
  t['parent in (DEMO-30)'] = [iss('DEMO-31', { parentKey: 'DEMO-30', isSubtask: true })];
  const { view: next } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(next.children.get('DEMO-30').map((i) => i.key), ['DEMO-31']);
  assert.deepStrictEqual(next.children.get('DEMO-1').map((i) => i.key), ['DEMO-3', 'DEMO-30']);
});

test('refresh removes the descendants of an issue dropped from the view', async () => {
  const t = basicTable();
  const { loader, view } = await loaded(t);
  t[WIN] = [iss('DEMO-3', { parentKey: 'DEMO-99', updated: '2026-11-19T11:00:00.000+0000' })];
  const { view: next } = await loader.refresh(view, { patterns: PATTERNS });
  assert.ok(!next.index.has('DEMO-3') && !next.index.has('DEMO-5'));
  assert.ok(!next.children.has('DEMO-3'));
  assert.deepStrictEqual((next.children.get('DEMO-1') || []).map((i) => i.key), []);
});

test('refresh handles children arriving before their new parent in one batch', async () => {
  const t = basicTable();
  const { loader, view } = await loaded(t);
  t[WIN] = [iss('DEMO-31', { parentKey: 'DEMO-30', isSubtask: true }), iss('DEMO-30', { parentKey: 'DEMO-7' }), epic('DEMO-7')];
  t['parent in (DEMO-7, DEMO-30)'] = [];
  const { view: next } = await loader.refresh(view, { patterns: PATTERNS });
  assert.deepStrictEqual(next.children.get('DEMO-7').map((i) => i.key), ['DEMO-30']);
  assert.deepStrictEqual(next.children.get('DEMO-30').map((i) => i.key), ['DEMO-31']);
});

test('a failed refresh leaves the cached file and the old view unchanged', async () => {
  const t = basicTable();
  const { loader, view, cacheDir, now } = await loaded(t);
  const file = path.join(cacheDir, 'DEMO_FY2027Q3.json'); const before = fs.readFileSync(file, 'utf8');
  t[WIN] = [epic('DEMO-7')]; t['parent in (DEMO-7)'] = () => { throw new Error('boom'); };
  await assert.rejects(loader.refresh(view, { patterns: PATTERNS }), /boom/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(view.epics.map((e) => e.key), ['DEMO-1', 'DEMO-2']); assert.ok(!view.index.has('DEMO-7'));
  assert.strictEqual(now() - view.loadedAt, 60000);
});

test('every search asks for the fields given; the cache file keeps no descriptions', async () => {
  const now = clock(); const cacheDir = tmp();
  const table = basicTable();
  const d = { type: 'doc', version: 1, content: [] };
  for (const list of Object.values(table)) for (const i of list) i.description = d;
  const api = fakeApi(table); const opts = [];
  const search = api.search; api.search = async (jql, o) => { opts.push(o); return search(jql); };
  const loader = createLoader({ api, cacheDir, now, fields: 'summary,description' });
  const view = await loader.load({ project: 'DEMO', quarter: Q, patterns: PATTERNS, owner: 'acc-me' });
  assert.strictEqual(view.index.get('DEMO-5').description, d, 'the view in memory keeps them');
  table['project = "DEMO" AND updated >= "-3m"'] = [];
  now.t += 60000;
  await loader.refresh(view, { patterns: PATTERNS });
  assert.ok(opts.length === 4 && opts.every((o) => o && o.fields === 'summary,description'));
  const file = fs.readdirSync(cacheDir).find((f) => f.endsWith('.json'));
  assert.ok(!fs.readFileSync(path.join(cacheDir, file), 'utf8').includes('description'));
  assert.strictEqual(loader.cached(view.key, 'acc-me').index.get('DEMO-5').description, undefined);
});

// ---- sprint and version modes: the tree is built upward from the members
const { NOEPIC } = require('../src/tree');
const SPRINT = { kind: 'sprint', id: '42' };
const MEMBERS = 'project = "DEMO" AND sprint = 42';
function memberTable() {
  return {
    [MEMBERS]: [
      iss('DEMO-3', { parentKey: 'DEMO-1' }),                    // a task whose epic is not in the sprint
      iss('DEMO-6', { parentKey: null }),                        // a task with no epic
      epic('DEMO-20', { labels: [] }),                           // an epic that is itself a member
      iss('DEMO-8', { parentKey: 'DEMO-7', isSubtask: true }),   // a sub-task whose task and epic are not members
    ],
    'parent in (DEMO-20)': [iss('DEMO-21', { parentKey: 'DEMO-20' }), iss('DEMO-22', { parentKey: 'DEMO-20' })],
    'parent in (DEMO-3, DEMO-6, DEMO-21, DEMO-22)': [iss('DEMO-4', { parentKey: 'DEMO-3', isSubtask: true }), iss('DEMO-23', { parentKey: 'DEMO-21', isSubtask: true })],
    'key in (DEMO-1, DEMO-7)': [epic('DEMO-1', { labels: [] }), iss('DEMO-7', { parentKey: 'DEMO-5' })],
    'key in (DEMO-5)': [epic('DEMO-5', { labels: [] })],
  };
}
const kidsOf = (v, k) => (v.children.get(k) || []).map((i) => i.key).sort();

test('member load: members, their sub-tasks, an epic member\'s whole tree, then missing parents; no-epic bucket', async () => {
  const api = fakeApi(memberTable()); const now = clock();
  const view = await createLoader({ api, cacheDir: tmp(), now }).load({ project: 'DEMO', period: SPRINT });
  assert.deepStrictEqual(api.calls, [MEMBERS, 'parent in (DEMO-20)', 'parent in (DEMO-3, DEMO-6, DEMO-21, DEMO-22)', 'key in (DEMO-1, DEMO-7)', 'key in (DEMO-5)']);
  assert.strictEqual(view.key, 'DEMO|sprint:42');
  assert.deepStrictEqual(view.period, SPRINT);
  assert.deepStrictEqual(view.members, ['DEMO-3', 'DEMO-6', 'DEMO-20', 'DEMO-8']);
  assert.deepStrictEqual(view.epics.map((e) => e.key).sort(), ['DEMO-1', 'DEMO-20', 'DEMO-5']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-1'), ['DEMO-3']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-3'), ['DEMO-4']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-20'), ['DEMO-21', 'DEMO-22']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-21'), ['DEMO-23']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-5'), ['DEMO-7']);
  assert.deepStrictEqual(kidsOf(view, 'DEMO-7'), ['DEMO-8']);
  assert.deepStrictEqual(kidsOf(view, NOEPIC), ['DEMO-6']);
  assert.strictEqual(view.index.size, 11);
  assert.strictEqual(view.loadedAt, now()); assert.strictEqual(view.fullAt, now());
});

test('member load for fix versions and "any": the JQL and the cache file name', async () => {
  const cacheDir = tmp();
  const any = 'project = "DEMO" AND fixVersion in unreleasedVersions()';
  const api = fakeApi({ [any]: [iss('DEMO-6')], 'parent in (DEMO-6)': [] });
  const view = await createLoader({ api, cacheDir, now: clock() }).load({ project: 'DEMO', period: { kind: 'fixVersion', id: 'any' }, owner: 'acc-me' });
  assert.strictEqual(view.key, 'DEMO|fixVersion:any');
  assert.deepStrictEqual(fs.readdirSync(cacheDir), ['DEMO_fixVersion_any.json']);
  const again = createLoader({ api: fakeApi({}), cacheDir, now: clock() }).cached('DEMO|fixVersion:any', 'acc-me');
  assert.deepStrictEqual(again.members, ['DEMO-6']); assert.deepStrictEqual(kidsOf(again, NOEPIC), ['DEMO-6']);
});

test('member load chunks key in and parent in by 50', async () => {
  const tasks = Array.from({ length: 60 }, (_, i) => iss(`DEMO-${i + 100}`, { parentKey: `DEMO-${i + 1}` }));
  const table = { [MEMBERS]: tasks };
  const tk = tasks.map((t) => t.key); const pk = tasks.map((t) => t.parentKey);
  table[`parent in (${tk.slice(0, 50).join(', ')})`] = []; table[`parent in (${tk.slice(50).join(', ')})`] = [];
  table[`key in (${pk.slice(0, 50).join(', ')})`] = pk.slice(0, 50).map((k) => epic(k)); table[`key in (${pk.slice(50).join(', ')})`] = pk.slice(50).map((k) => epic(k));
  const api = fakeApi(table);
  const view = await createLoader({ api, cacheDir: tmp(), now: clock() }).load({ project: 'DEMO', period: SPRINT });
  assert.strictEqual(api.calls.length, 5);
  assert.strictEqual(view.epics.length, 60);
});

async function memberLoaded(table) {
  const now = clock(); const api = fakeApi(table); const cacheDir = tmp();
  const loader = createLoader({ api, cacheDir, now });
  const view = await loader.load({ project: 'DEMO', period: SPRINT });
  now.t += 60000;
  return { now, api, loader, view };
}
const inSprint = (keys) => `key in (${keys.join(', ')}) AND sprint = 42`;
const LATER = '2026-11-19T11:00:00.000+0000';

test('member refresh: a ticket that joins the period is a member and brings its sub-tasks and its epic', async () => {
  const t = memberTable();
  const { loader, view, api, now } = await memberLoaded(t);
  t[WIN] = [iss('DEMO-30', { parentKey: 'DEMO-31', updated: LATER }), iss('DEMO-40', { parentKey: 'DEMO-99', updated: LATER })];
  t[inSprint(['DEMO-30', 'DEMO-40'])] = [iss('DEMO-30')];   // DEMO-40 changed but isn't in the sprint
  t['parent in (DEMO-30)'] = [iss('DEMO-32', { parentKey: 'DEMO-30', isSubtask: true })];
  t['key in (DEMO-31)'] = [epic('DEMO-31', { labels: [] })];
  const { view: next, changed } = await loader.refresh(view, {});
  assert.deepStrictEqual(api.calls.slice(5), [WIN, inSprint(['DEMO-30', 'DEMO-40']), 'parent in (DEMO-30)', 'key in (DEMO-31)']);
  assert.ok(next.members.includes('DEMO-30'));
  assert.deepStrictEqual(kidsOf(next, 'DEMO-31'), ['DEMO-30']);
  assert.deepStrictEqual(kidsOf(next, 'DEMO-30'), ['DEMO-32']);
  assert.ok(!next.index.has('DEMO-40') && !next.index.has('DEMO-99'));
  assert.deepStrictEqual(changed.map((i) => i.key).sort(), ['DEMO-30', 'DEMO-31', 'DEMO-32']);
  assert.strictEqual(next.fullAt, view.fullAt); assert.strictEqual(next.loadedAt, now());
  assert.ok(!view.members.includes('DEMO-30'), 'the old view is untouched');
});

test('member refresh: a ticket that left the period goes with its descendants; an epic left without members goes too', async () => {
  const t = memberTable();
  const { loader, view } = await memberLoaded(t);
  t[WIN] = [iss('DEMO-3', { parentKey: 'DEMO-1', updated: LATER }), epic('DEMO-20', { labels: [], updated: LATER })];
  t[inSprint(['DEMO-3', 'DEMO-20'])] = [];
  const { view: next } = await loader.refresh(view, {});
  assert.deepStrictEqual(next.members, ['DEMO-6', 'DEMO-8']);
  for (const k of ['DEMO-3', 'DEMO-4', 'DEMO-1', 'DEMO-20', 'DEMO-21', 'DEMO-22', 'DEMO-23']) assert.ok(!next.index.has(k), k);
  assert.deepStrictEqual(next.epics.map((e) => e.key), ['DEMO-5']);
  assert.ok(!next.children.has('DEMO-1') && !next.children.has('DEMO-20'));
});

test('member refresh: a member re-parented to no epic moves to the no-epic bucket; one moved under a new epic fetches it', async () => {
  const t = memberTable();
  const { loader, view } = await memberLoaded(t);
  t[WIN] = [iss('DEMO-3', { parentKey: null, updated: LATER }), iss('DEMO-6', { parentKey: 'DEMO-50', updated: LATER })];
  t[inSprint(['DEMO-3', 'DEMO-6'])] = [iss('DEMO-3'), iss('DEMO-6')];
  t['key in (DEMO-50)'] = [epic('DEMO-50', { labels: [] })];
  const { view: next } = await loader.refresh(view, {});
  assert.deepStrictEqual(kidsOf(next, NOEPIC), ['DEMO-3']);
  assert.deepStrictEqual(kidsOf(next, 'DEMO-3'), ['DEMO-4'], 'it keeps its sub-tasks');
  assert.ok(!next.index.has('DEMO-1'), 'its old epic held nothing else');
  assert.deepStrictEqual(kidsOf(next, 'DEMO-50'), ['DEMO-6']);
});

test('member refresh: a new task in a member epic, and a new sub-task of a member, join without the period check matching', async () => {
  const t = memberTable();
  const { loader, view } = await memberLoaded(t);
  t[WIN] = [iss('DEMO-24', { parentKey: 'DEMO-20', updated: LATER }), iss('DEMO-9', { parentKey: 'DEMO-6', isSubtask: true, updated: LATER })];
  t[inSprint(['DEMO-24', 'DEMO-9'])] = [];
  t['parent in (DEMO-24)'] = [iss('DEMO-25', { parentKey: 'DEMO-24', isSubtask: true })];
  const { view: next } = await loader.refresh(view, {});
  assert.deepStrictEqual(kidsOf(next, 'DEMO-20'), ['DEMO-21', 'DEMO-22', 'DEMO-24']);
  assert.deepStrictEqual(kidsOf(next, 'DEMO-24'), ['DEMO-25']);
  assert.deepStrictEqual(kidsOf(next, 'DEMO-6'), ['DEMO-9']);
  assert.deepStrictEqual(next.members, view.members, 'members are what the period search says');
});

test('member refresh with nothing changed asks only the updated-since search; after 15 minutes it reloads in full', async () => {
  const t = memberTable();
  const { loader, view, api, now } = await memberLoaded(t);
  t[WIN] = [];
  const { view: same, changed } = await loader.refresh(view, {});
  assert.deepStrictEqual(api.calls.slice(5), [WIN]); assert.deepStrictEqual(changed, []);
  assert.strictEqual(same.index.size, view.index.size);
  now.t += 15 * 60000;
  t[MEMBERS] = [iss('DEMO-6', { updated: LATER })];
  t['parent in (DEMO-6)'] = [];
  const { view: full, changed: ch } = await loader.refresh(same, {});
  assert.deepStrictEqual(api.calls.slice(6), [MEMBERS, 'parent in (DEMO-6)']);
  assert.deepStrictEqual([...full.index.keys()], ['DEMO-6']);
  assert.deepStrictEqual(ch.map((i) => i.key), ['DEMO-6']);
  assert.strictEqual(full.fullAt, now());
});

test('member views keep no descriptions in the cache', async () => {
  const d = { type: 'doc', version: 1, content: [] };
  const table = memberTable();
  for (const list of Object.values(table)) for (const i of list) i.description = d;
  const cacheDir = tmp();
  const loader = createLoader({ api: fakeApi(table), cacheDir, now: clock(), fields: 'summary,description' });
  const view = await loader.load({ project: 'DEMO', period: SPRINT });
  assert.strictEqual(view.index.get('DEMO-6').description, d);
  assert.ok(!fs.readFileSync(path.join(cacheDir, 'DEMO_sprint_42.json'), 'utf8').includes('description'));
});
