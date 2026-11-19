'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { buildTree, isPlaceholder, chainOf } = require('../src/tree');

const ME = 'acc-me';
const person = (id, name) => ({ accountId: id, displayName: name });
const iss = (key, o = {}) => ({
  key, summary: `Summary ${key}`, type: 'Task', isEpic: false, isSubtask: false,
  status: { name: 'To Do', category: 'new' }, assignee: null, duedate: null, parentKey: null, labels: [], ...o,
});
const me = person(ME, 'Mia Demo'); const bob = person('acc-bob', 'Bob Sample');
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children)]);
const keys = (nodes) => nodes.map((n) => n.key);

function fixture() {
  const epics = [iss('DEMO-1', { isEpic: true, type: 'Epic', assignee: bob }), iss('DEMO-2', { isEpic: true, type: 'Epic', assignee: bob })];
  const children = new Map([
    ['DEMO-1', [iss('DEMO-3', { parentKey: 'DEMO-1', assignee: bob }), iss('DEMO-4', { parentKey: 'DEMO-1', assignee: bob })]],
    ['DEMO-3', [iss('DEMO-5', { parentKey: 'DEMO-3', isSubtask: true, type: 'Sub-task', assignee: me })]],
    ['DEMO-2', [iss('DEMO-6', { parentKey: 'DEMO-2', assignee: bob })]],
  ]);
  return { epics, children };
}

test('mine includes an epic via a sub-task of mine under someone else\'s task', () => {
  const { epics, children } = fixture();
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'mine', placeholders: [] });
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].id, 'mine'); assert.strictEqual(groups[0].title, null);
  assert.deepStrictEqual(keys(groups[0].nodes), ['DEMO-1']);
});

test('mine includes the whole tree, and others\' items have mine false', () => {
  const { epics, children } = fixture();
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'mine', placeholders: [] });
  const all = flat(groups[0].nodes);
  assert.deepStrictEqual(keys(all), ['DEMO-1', 'DEMO-3', 'DEMO-5', 'DEMO-4']);
  assert.deepStrictEqual(all.map((n) => n.mine), [false, false, true, false]);
  assert.deepStrictEqual(all.map((n) => n.kind), ['epic', 'task', 'subtask', 'task']);
});

test('mine excludes epics with nothing of mine', () => {
  const { epics, children } = fixture();
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'mine', placeholders: [] });
  assert.ok(!keys(groups[0].nodes).includes('DEMO-2'));
  const none = buildTree({ epics, children, meId: 'nobody', mode: 'mine', placeholders: [] });
  assert.deepStrictEqual(none.groups, []);
});

test('all puts placeholder and unassigned epics in unclaimed, first', () => {
  const epics = [
    iss('DEMO-1', { isEpic: true, assignee: bob }),
    iss('DEMO-2', { isEpic: true, assignee: person('acc-ph', 'Placeholder Team') }),
    iss('DEMO-3', { isEpic: true, assignee: null }),
  ];
  const { groups } = buildTree({ epics, children: new Map(), meId: ME, mode: 'all', placeholders: ['Placeholder Team'] });
  assert.deepStrictEqual(groups.map((g) => g.id), ['unclaimed', 'claimed']);
  assert.deepStrictEqual(keys(groups[0].nodes), ['DEMO-3', 'DEMO-2']);
  assert.deepStrictEqual(keys(groups[1].nodes), ['DEMO-1']);
  const only = buildTree({ epics: [epics[0]], children: new Map(), meId: ME, mode: 'all', placeholders: [] });
  assert.deepStrictEqual(only.groups.map((g) => g.id), ['claimed']);
});

test('isPlaceholder matches displayName or accountId', () => {
  assert.strictEqual(isPlaceholder(person('acc-ph', 'Placeholder Team'), ['Placeholder Team']), true);
  assert.strictEqual(isPlaceholder(person('acc-ph', 'Placeholder Team'), ['acc-ph']), true);
  assert.strictEqual(isPlaceholder(bob, ['Placeholder Team']), false);
  assert.strictEqual(isPlaceholder(null, ['x']), false);
});

test('who, status and done values', () => {
  const epics = [iss('DEMO-1', { isEpic: true, assignee: person('a', 'Mia Demo'), status: { name: 'In Progress', category: 'indeterminate' } })];
  const children = new Map([['DEMO-1', [
    iss('DEMO-2', { parentKey: 'DEMO-1' }),
    iss('DEMO-3', { parentKey: 'DEMO-1', status: { name: 'Done', category: 'done' }, assignee: bob }),
  ]]]);
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'all', placeholders: [] });
  const [e] = groups[0].nodes; const [t2, t3] = e.children;
  assert.strictEqual(e.who, 'Mia'); assert.strictEqual(e.status, 'In Progress'); assert.strictEqual(e.done, false);
  assert.strictEqual(t2.who, '-'); assert.strictEqual(t2.status, null); assert.strictEqual(t2.done, false);
  assert.strictEqual(t3.who, 'Bob'); assert.strictEqual(t3.status, 'Done'); assert.strictEqual(t3.done, true);
  assert.deepStrictEqual(Object.keys(e).sort(), ['assignee', 'children', 'done', 'due', 'estimate', 'key', 'kind', 'labels', 'mine', 'owner', 'priority', 'status', 'statusName', 'summary', 'type', 'who']);
});

test('ordering', () => {
  const e = (key, duedate) => iss(key, { isEpic: true, assignee: bob, duedate });
  const epics = [e('DEMO-9', null), e('DEMO-10', '2026-12-01'), e('DEMO-2', '2026-12-01'), e('DEMO-3', '2026-11-01'), e('DEMO-11', null)];
  const children = new Map([['DEMO-2', [iss('DEMO-20', { parentKey: 'DEMO-2' }), iss('DEMO-4', { parentKey: 'DEMO-2' }), iss('DEMO-12', { parentKey: 'DEMO-2' })]]]);
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'all', placeholders: [] });
  assert.deepStrictEqual(keys(groups[0].nodes), ['DEMO-3', 'DEMO-10', 'DEMO-2', 'DEMO-11', 'DEMO-9']);
  const two = groups[0].nodes.find((n) => n.key === 'DEMO-2');
  assert.deepStrictEqual(keys(two.children), ['DEMO-4', 'DEMO-12', 'DEMO-20']);
});

function index() {
  const { epics, children } = fixture();
  const idx = new Map();
  for (const x of [...epics, ...[...children.values()].flat()]) idx.set(x.key, x);
  return { idx, children };
}

test('chainOf a sub-task gives path epic>task, siblings, no tree', () => {
  const { idx } = index();
  idx.set('DEMO-7', iss('DEMO-7', { parentKey: 'DEMO-3', isSubtask: true }));
  const c = chainOf('DEMO-5', idx);
  assert.deepStrictEqual(c.path.map((i) => i.key), ['DEMO-1', 'DEMO-3']);
  assert.deepStrictEqual(c.siblings.map((i) => i.key), ['DEMO-7']);
  assert.deepStrictEqual(c.children, []);
  assert.deepStrictEqual(c.tree, []);
});

test('chainOf an epic gives its whole tree', () => {
  const { idx } = index();
  const c = chainOf('DEMO-1', idx);
  assert.deepStrictEqual(c.path, []);
  assert.deepStrictEqual(c.children.map((i) => i.key), ['DEMO-3', 'DEMO-4']);
  assert.deepStrictEqual(c.tree.map((i) => i.key), ['DEMO-3', 'DEMO-5', 'DEMO-4']);
  assert.deepStrictEqual(c.siblings, []);
});

test('nodes carry type, priority, due, labels and estimate', () => {
  const epics = [iss('DEMO-1', { isEpic: true, type: 'Epic', priority: { id: '2', name: 'High' }, duedate: '2027-03-31', labels: ['a', 'b'], estimate: '2d 4h' })];
  const children = new Map([['DEMO-1', [iss('DEMO-2', { parentKey: 'DEMO-1' })]]]);
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'all', placeholders: [] });
  const [e] = groups[0].nodes; const [t] = e.children;
  assert.strictEqual(e.type, 'Epic'); assert.strictEqual(e.priority, 'High'); assert.strictEqual(e.due, '2027-03-31');
  assert.deepStrictEqual(e.labels, ['a', 'b']); assert.strictEqual(e.estimate, '2d 4h');
  assert.strictEqual(t.type, 'Task'); assert.strictEqual(t.priority, null); assert.strictEqual(t.due, null);
  assert.deepStrictEqual(t.labels, []); assert.strictEqual(t.estimate, null);
});

test('member tasks without an epic go in a final "No epic" group, in mine and all', () => {
  const { NOEPIC } = require('../src/tree');
  const { epics, children } = fixture();
  children.set(NOEPIC, [iss('DEMO-31', { assignee: bob }), iss('DEMO-30', { assignee: me }), iss('DEMO-32', { assignee: bob })]);
  children.set('DEMO-32', [iss('DEMO-33', { parentKey: 'DEMO-32', isSubtask: true, assignee: me })]);
  const mine = buildTree({ epics, children, meId: ME, mode: 'mine', placeholders: [] });
  assert.deepStrictEqual(mine.groups.map((g) => [g.id, g.title]), [['mine', null], ['noepic', 'No epic']]);
  assert.deepStrictEqual(keys(mine.groups[1].nodes), ['DEMO-30', 'DEMO-32'], 'mine filtering: own task, or a task holding my sub-task');
  assert.deepStrictEqual(mine.groups[1].nodes.map((n) => [n.kind, n.mine]), [['task', true], ['task', false]]);
  assert.deepStrictEqual(keys(mine.groups[1].nodes[1].children), ['DEMO-33']);
  const all = buildTree({ epics, children, meId: ME, mode: 'all', placeholders: [] });
  assert.deepStrictEqual(all.groups.map((g) => g.id), ['claimed', 'noepic']);
  assert.deepStrictEqual(keys(all.groups[1].nodes), ['DEMO-30', 'DEMO-31', 'DEMO-32']);
  const none = buildTree({ epics: [], children: new Map([[NOEPIC, [iss('DEMO-31', { assignee: bob })]]]), meId: ME, mode: 'mine', placeholders: [] });
  assert.deepStrictEqual(none.groups, [], 'nothing of mine without an epic: no group');
});

test('nodes carry assignee name, status name and owner (me / other / none; a placeholder is none)', () => {
  const ghost = person('acc-tbd', 'TBD Team');
  const epics = [iss('DEMO-1', { isEpic: true, assignee: me, status: { name: 'In Progress', category: 'indeterminate' } })];
  const children = new Map([['DEMO-1', [iss('DEMO-2', { parentKey: 'DEMO-1', assignee: bob }), iss('DEMO-3', { parentKey: 'DEMO-1' }),
    iss('DEMO-4', { parentKey: 'DEMO-1', assignee: ghost }), iss('DEMO-5', { parentKey: 'DEMO-1', assignee: person('acc-tbd2', 'Other Ghost') })]]]);
  const { groups } = buildTree({ epics, children, meId: ME, mode: 'all', placeholders: ['TBD Team', 'acc-tbd2'] });
  const [e] = groups.flatMap((g) => g.nodes); const [t2, t3, t4, t5] = e.children;
  assert.deepStrictEqual([e.owner, e.assignee, e.statusName], ['me', 'Mia Demo', 'In Progress']);
  assert.deepStrictEqual([t2.owner, t2.assignee], ['other', 'Bob Sample']);
  assert.deepStrictEqual([t3.owner, t3.assignee, t3.statusName], ['none', null, 'To Do']);
  assert.strictEqual(t4.owner, 'none'); assert.strictEqual(t5.owner, 'none');
});
