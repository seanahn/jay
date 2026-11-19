'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { sprintChoices, versionChoices, defaultOf, periodJql, kindOf, createPeriods, UNAVAILABLE } = require('../src/periods');
const { JiraError } = require('../src/http');

const sp = (id, state, o = {}) => ({ id, name: `Sprint ${id}`, state, startDate: null, endDate: null, ...o });
const ver = (id, o = {}) => ({ id: String(id), name: `v${id}`, released: false, archived: false, releaseDate: null, ...o });

test('kindOf accepts the three modes and falls back to quarter', () => {
  assert.strictEqual(kindOf('sprint'), 'sprint'); assert.strictEqual(kindOf('fixVersion'), 'fixVersion');
  assert.strictEqual(kindOf('quarter'), 'quarter'); assert.strictEqual(kindOf('weird'), 'quarter'); assert.strictEqual(kindOf(undefined), 'quarter');
});

test('sprint choices: active first, then up to 3 future by start asc, then up to 3 closed by end desc, then any; deduped by id', () => {
  const list = [
    sp(5, 'closed', { endDate: '2026-10-01T00:00:00Z' }), sp(9, 'future', { startDate: '2027-02-01T00:00:00Z' }),
    sp(7, 'active'), sp(8, 'future', { startDate: '2027-01-01T00:00:00Z' }), sp(3, 'closed', { endDate: '2026-08-01T00:00:00Z' }),
    sp(10, 'future', { startDate: '2027-03-01T00:00:00Z' }), sp(11, 'future', { startDate: '2027-04-01T00:00:00Z' }),
    sp(4, 'closed', { endDate: '2026-09-01T00:00:00Z' }), sp(2, 'closed', { endDate: '2026-07-01T00:00:00Z' }),
    sp(7, 'active'), sp(12, 'active'), sp(13, 'future'),
  ];
  const c = sprintChoices(list);
  assert.deepStrictEqual(c.map((x) => x.id), ['7', '12', '8', '9', '10', '5', '4', '3', 'any']);
  assert.deepStrictEqual(c.map((x) => x.label), ['Sprint 7', 'Sprint 12', 'Sprint 8 (future)', 'Sprint 9 (future)', 'Sprint 10 (future)',
    'Sprint 5 (closed)', 'Sprint 4 (closed)', 'Sprint 3 (closed)', 'Any sprint']);
  assert.strictEqual(defaultOf('sprint', c), '7', 'the first active sprint');
  assert.strictEqual(defaultOf('sprint', sprintChoices([sp(8, 'future')])), 'any', 'no active sprint: any');
  assert.deepStrictEqual(sprintChoices([]).map((x) => x.id), ['any']);
});

test('version choices: unreleased unarchived in Jira order, then up to 3 released by date desc, then any', () => {
  const list = [
    ver(30), ver(10, { released: true, releaseDate: '2026-06-01' }), ver(20), ver(40, { archived: true }),
    ver(11, { released: true, releaseDate: '2026-09-01' }), ver(12, { released: true, releaseDate: '2026-08-01' }),
    ver(13, { released: true, releaseDate: '2026-07-01' }), ver(14, { released: true, archived: true, releaseDate: '2026-10-01' }),
  ];
  const c = versionChoices(list);
  assert.deepStrictEqual(c.map((x) => x.id), ['30', '20', '11', '12', '13', 'any']);
  assert.deepStrictEqual(c.map((x) => x.label), ['v30', 'v20', 'v11 (released)', 'v12 (released)', 'v13 (released)', 'Any version']);
  assert.strictEqual(defaultOf('fixVersion', c), '30');
  assert.strictEqual(defaultOf('fixVersion', versionChoices([ver(10, { released: true })])), 'any');
});

test('period JQL', () => {
  assert.strictEqual(periodJql({ kind: 'sprint', id: 'any' }), 'sprint in openSprints()');
  assert.strictEqual(periodJql({ kind: 'sprint', id: '42' }), 'sprint = 42');
  assert.strictEqual(periodJql({ kind: 'fixVersion', id: 'any' }), 'fixVersion in unreleasedVersions()');
  assert.strictEqual(periodJql({ kind: 'fixVersion', id: '10001' }), 'fixVersion = 10001');
  assert.throws(() => periodJql({ kind: 'sprint', id: '1 OR x' }));
});

// ---- the selection, against a fake store, settings and api
function memo(init = {}) { const m = new Map(Object.entries(init)); return { m, get: (k) => m.get(k), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); } }; }
function rig({ period = 'sprint', stored = {}, boards = [{ id: 1 }], sprints = { 1: [sp(7, 'active'), sp(8, 'future')] }, versions = [ver(30), ver(20)], t = Date.UTC(2027, 0, 15, 12) } = {}) {
  const config = { 'period': period };
  const calls = [];
  const api = {
    boards: async (p) => { calls.push(['boards', p]); if (typeof boards === 'function') return boards(); return boards; },
    sprints: async (id) => { calls.push(['sprints', id]); const v = sprints[id]; if (typeof v === 'function') return v(); return v || []; },
    versions: async (p) => { calls.push(['versions', p]); if (typeof versions === 'function') return versions(); return versions; },
  };
  const store = memo(stored); const clock = { t };
  const periods = createPeriods({ api, store, cfg: (k, d) => (k in config ? config[k] : d), now: () => clock.t });
  return { periods, store, calls, config, clock };
}

test('quarter mode selects as before and needs no API calls', async () => {
  const r = rig({ period: 'quarter', stored: { 'jay.quarter': 'any' } });
  assert.strictEqual(await r.periods.ensure('DEMO'), false);
  const p = r.periods.select('DEMO');
  assert.strictEqual(p.kind, 'quarter'); assert.strictEqual(p.id, 'any'); assert.strictEqual(p.period, 'any'); assert.strictEqual(p.note, null);
  assert.deepStrictEqual(p.choices.map((c) => c.id), ['FY2027Q2', 'FY2027Q1', 'FY2026Q4', 'FY2026Q3', 'FY2026Q2', 'FY2026Q1', 'any']);
  assert.deepStrictEqual(r.calls, []);
});

test('sprint mode: nothing until the list loads, then the active sprint by default; the default follows the active one', async () => {
  const r = rig();
  assert.deepStrictEqual(r.periods.select('DEMO').choices, []); assert.strictEqual(r.periods.select('DEMO').period, null);
  assert.strictEqual(await r.periods.ensure('DEMO'), true);
  assert.deepStrictEqual(r.calls, [['boards', 'DEMO'], ['sprints', 1]]);
  let p = r.periods.select('DEMO');
  assert.deepStrictEqual(p.choices, [{ id: '7', label: 'Sprint 7' }, { id: '8', label: 'Sprint 8 (future)' }, { id: 'any', label: 'Any sprint' }]);
  assert.strictEqual(p.id, '7'); assert.deepStrictEqual(p.period, { kind: 'sprint', id: '7' });
  assert.strictEqual(await r.periods.ensure('DEMO'), false, 'fresh: no refetch');
  // 15 minutes on, sprint 7 has closed and 8 is active: the default moves with it
  r.clock.t += 15 * 60000 + 1;
  const api = { 1: [sp(7, 'closed', { endDate: '2027-01-20T00:00:00Z' }), sp(8, 'active')] };
  Object.assign(r, rig({ sprints: api, stored: Object.fromEntries(r.store.m) , t: r.clock.t }));
  await r.periods.ensure('DEMO');
  p = r.periods.select('DEMO');
  assert.strictEqual(p.id, '8');
});

test('a remembered sprint stays; one no longer listed falls back to the default; choosing the default stores current', async () => {
  const r = rig({ stored: { 'jay.sprint': '8' } });
  await r.periods.ensure('DEMO');
  assert.strictEqual(r.periods.select('DEMO').id, '8');
  r.store.update('jay.sprint', '99');
  assert.strictEqual(r.periods.select('DEMO').id, '7', 'gone: the default');
  assert.strictEqual(r.periods.choose('DEMO', 'nope'), false);
  assert.strictEqual(r.periods.choose('DEMO', 5), false);
  assert.strictEqual(r.store.get('jay.sprint'), '99');
  assert.strictEqual(r.periods.choose('DEMO', 'any'), true); assert.strictEqual(r.store.get('jay.sprint'), 'any');
  assert.strictEqual(r.periods.choose('DEMO', '7'), true); assert.strictEqual(r.store.get('jay.sprint'), 'current');
  assert.strictEqual(r.store.get('jay.quarter'), undefined, 'each mode has its own key');
});

test('kanban boards (400 on sprints) are skipped; sprints are deduped across boards', async () => {
  const r = rig({ boards: [{ id: 1 }, { id: 2 }, { id: 3 }], sprints: { 1: [sp(7, 'active')], 2: () => { throw new JiraError(400); }, 3: [sp(7, 'active'), sp(9, 'future')] } });
  await r.periods.ensure('DEMO');
  assert.deepStrictEqual(r.periods.select('DEMO').choices.map((c) => c.id), ['7', '9', 'any']);
});

test('an Agile API refusal falls back to quarters with a note, without touching the setting; other errors propagate', async () => {
  for (const status of [401, 403, 404]) {
    const r = rig({ boards: () => { throw new JiraError(status); }, stored: { 'jay.quarter': 'any' } });
    assert.strictEqual(await r.periods.ensure('DEMO'), true);
    const p = r.periods.select('DEMO');
    assert.strictEqual(p.kind, 'quarter'); assert.strictEqual(p.setting, 'sprint'); assert.strictEqual(p.period, 'any');
    assert.strictEqual(p.note, UNAVAILABLE.sprint); assert.strictEqual(p.note, 'Sprints not available with this sign-in');
    assert.strictEqual(r.config.period, 'sprint');
    assert.strictEqual(r.periods.choose('DEMO', 'FY2027Q1'), true); assert.strictEqual(r.store.get('jay.quarter'), 'current', 'picks go to the quarter');
  }
  const r = rig({ sprints: { 1: () => { throw new JiraError(403); } } });
  await r.periods.ensure('DEMO');
  assert.strictEqual(r.periods.select('DEMO').note, UNAVAILABLE.sprint, 'refused on a board\'s sprints too');
  const off = rig({ boards: () => { const e = new Error('offline'); e.name = 'Offline'; throw e; } });
  await assert.rejects(off.periods.ensure('DEMO'), /offline/);
  const bad = rig({ boards: () => { throw new JiraError(500); } });
  await assert.rejects(bad.periods.ensure('DEMO'), (e) => e.status === 500);
});

test('version mode: lists, default, remembered choice under jay.version', async () => {
  const r = rig({ period: 'fixVersion', versions: [ver(30), ver(20), ver(10, { released: true, releaseDate: '2026-01-01' })] });
  await r.periods.ensure('DEMO');
  assert.deepStrictEqual(r.calls, [['versions', 'DEMO']]);
  const p = r.periods.select('DEMO');
  assert.deepStrictEqual(p.choices.map((c) => c.id), ['30', '20', '10', 'any']);
  assert.strictEqual(p.id, '30'); assert.deepStrictEqual(p.period, { kind: 'fixVersion', id: '30' });
  assert.strictEqual(r.periods.choose('DEMO', '10'), true); assert.strictEqual(r.store.get('jay.version'), '10');
  assert.strictEqual(r.periods.select('DEMO').id, '10');
});

test('lists are per project, kept across restarts, and markStale refetches', async () => {
  const r = rig();
  await r.periods.ensure('DEMO');
  const again = rig({ stored: Object.fromEntries(r.store.m), sprints: { 1: [] } });
  assert.strictEqual(again.periods.select('DEMO').id, '7', 'the last list shows at once after a restart');
  assert.deepStrictEqual(again.periods.select('OTH').choices, [], 'another project has its own list');
  assert.strictEqual(await again.periods.ensure('DEMO'), false);
  again.periods.markStale();
  assert.strictEqual(await again.periods.ensure('DEMO'), true);
  assert.strictEqual(again.periods.select('DEMO').id, 'any');
});

// ---- review fixes
const { SignInNeeded } = require('../src/auth');

test('versions: a 403 or 404 gives the versions note and quarters; SignInNeeded is not swallowed', async () => {
  for (const status of [403, 404]) {
    const r = rig({ period: 'fixVersion', versions: () => { throw new JiraError(status); } });
    await r.periods.ensure('DEMO');
    const p = r.periods.select('DEMO');
    assert.strictEqual(p.kind, 'quarter'); assert.strictEqual(p.note, 'Versions not available with this sign-in');
  }
  const r = rig({ period: 'fixVersion', versions: () => { throw new SignInNeeded('rejected'); } });
  await assert.rejects(r.periods.ensure('DEMO'), SignInNeeded);
  assert.deepStrictEqual(r.periods.select('DEMO').choices, [], 'nothing recorded');
});

test('one board refusing its sprints is skipped; quarters only when every board with sprints refused', async () => {
  const refuse = (s) => () => { throw new JiraError(s); };
  let r = rig({ boards: [{ id: 1 }, { id: 2 }, { id: 3 }], sprints: { 1: refuse(403), 2: [sp(7, 'active')], 3: refuse(404) } });
  await r.periods.ensure('DEMO');
  assert.strictEqual(r.periods.select('DEMO').note, null);
  assert.deepStrictEqual(r.periods.select('DEMO').choices.map((c) => c.id), ['7', 'any']);
  r = rig({ boards: [{ id: 1 }, { id: 2 }], sprints: { 1: refuse(403), 2: refuse(400) } });
  await r.periods.ensure('DEMO');
  assert.strictEqual(r.periods.select('DEMO').note, UNAVAILABLE.sprint, 'the only scrum board refused');
  r = rig({ boards: [{ id: 2 }], sprints: { 2: refuse(400) } });
  await r.periods.ensure('DEMO');
  assert.strictEqual(r.periods.select('DEMO').note, null, 'kanban only: no sprints, not refused');
  assert.deepStrictEqual(r.periods.select('DEMO').choices.map((c) => c.id), ['any']);
});

test('a failed refetch keeps the cached list (and waits 15 minutes again); with no list the error propagates', async () => {
  let fail = null;
  const r = rig({ boards: () => { if (fail) throw fail; return [{ id: 1 }]; } });
  await r.periods.ensure('DEMO');
  r.clock.t += 15 * 60000 + 1;
  for (fail of [new JiraError(500), new JiraError(400), Object.assign(new Error('offline'), { name: 'Offline' })]) {
    r.periods.markStale();
    assert.strictEqual(await r.periods.ensure('DEMO'), false);
    assert.strictEqual(r.periods.select('DEMO').id, '7', 'the older list is still used');
    const n = r.calls.length;
    assert.strictEqual(await r.periods.ensure('DEMO'), false); assert.strictEqual(r.calls.length, n, 'its time moved forward');
  }
  fail = new SignInNeeded('rejected'); r.periods.markStale();
  await assert.rejects(r.periods.ensure('DEMO'), SignInNeeded);
  const none = rig({ boards: () => { throw new JiraError(500); } });
  await assert.rejects(none.periods.ensure('DEMO'), (e) => e.status === 500);
});
