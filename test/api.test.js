'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { createApi, FIELDS } = require('../src/api');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n + '.json'), 'utf8'));
function mk(replies) {
  const calls = [];
  const http = {
    get: async (p, q, o) => { calls.push(o === undefined ? { m: 'GET', p, q } : { m: 'GET', p, q, o }); const r = replies.shift(); return typeof r === 'function' ? r(p, q) : r; },
    send: async (m, p, b) => { calls.push({ m, p, b }); const r = replies.shift(); return typeof r === 'function' ? r(p, b) : r; },
  };
  const auth = { siteUrl: () => 'https://example.atlassian.net' };
  return { api: createApi(http, auth), calls };
}

test('search follows nextPageToken until absent', async () => {
  const { api, calls } = mk([fx('search-page1'), fx('search-page2')]);
  const issues = await api.search('project = DEMO');
  assert.deepStrictEqual(issues.map((i) => i.key), ['DEMO-10', 'DEMO-12']);
  assert.strictEqual(calls.length, 2); assert.strictEqual(calls[0].m, 'POST'); assert.strictEqual(calls[0].p, '/rest/api/3/search/jql');
  assert.deepStrictEqual(calls[0].b, { jql: 'project = DEMO', fields: FIELDS.split(','), maxResults: 100 });
  assert.strictEqual(calls[1].b.nextPageToken, 'tok-2');
  assert.strictEqual(issues[0].isEpic, true); assert.strictEqual(issues[1].parentKey, 'DEMO-10'); assert.strictEqual(issues[1].status.category, 'done');
});
test('search accepts custom fields', async () => {
  const { api, calls } = mk([{ issues: [] }]);
  await api.search('x', { fields: 'summary' }); assert.deepStrictEqual(calls[0].b.fields, ['summary']);
});
test('search with max stops paging once it has enough and caps maxResults', async () => {
  const page = (keys, token) => ({ issues: keys.map((k) => ({ key: k, id: k, fields: {} })), nextPageToken: token });
  const { api, calls } = mk([page(['A-1', 'A-2', 'A-3'], 't2'), page(['A-4'], 't3')]);
  const got = await api.search('x', { max: 3 });
  assert.deepStrictEqual(got.map((i) => i.key), ['A-1', 'A-2', 'A-3']);
  assert.strictEqual(calls.length, 1, 'no second page once max is reached');
  assert.strictEqual(calls[0].b.maxResults, 3);
  const two = mk([page(['A-1', 'A-2'], 't2'), page(['A-3', 'A-4'], 't3')]);
  assert.deepStrictEqual((await two.api.search('x', { max: 3 })).map((i) => i.key), ['A-1', 'A-2', 'A-3'], 'trimmed to max');
  assert.deepStrictEqual(two.calls.map((c) => c.b.maxResults), [3, 1], 'asks only for what is still missing');
  const big = mk([{ issues: [] }]); await big.api.search('x', { max: 500 });
  assert.strictEqual(big.calls[0].b.maxResults, 100);
});
test('issue normalization', async () => {
  const { api, calls } = mk([fx('issue-subtask'), fx('issue-epic')]);
  const i = await api.issue('DEMO-12');
  assert.strictEqual(calls[0].p, '/rest/api/3/issue/DEMO-12'); assert.strictEqual(calls[0].q.fields, FIELDS + ',description');
  assert.deepStrictEqual({ key: i.key, id: i.id, type: i.type, isSubtask: i.isSubtask, isEpic: i.isEpic, parentKey: i.parentKey }, { key: 'DEMO-12', id: '10042', type: 'Sub-task', isSubtask: true, isEpic: false, parentKey: 'DEMO-10' });
  assert.deepStrictEqual(i.status, { name: 'In Progress', category: 'indeterminate' });
  assert.strictEqual(i.assignee, null); assert.deepStrictEqual(i.reporter, { accountId: 'acc-sam', displayName: 'Sam Lee' });
  assert.deepStrictEqual(i.priority, { id: '3', name: 'Medium' }); assert.deepStrictEqual(i.labels, ['FY2026Q1']);
  assert.strictEqual(i.duedate, '2026-03-31'); assert.strictEqual(i.summary, 'Write the migration script'); assert.strictEqual(i.description.type, 'doc');
  const e = await api.issue('DEMO-10');
  assert.strictEqual(e.isEpic, true); assert.strictEqual(e.parentKey, null); assert.strictEqual(e.priority, null); assert.strictEqual(e.description, null); assert.deepStrictEqual(e.assignee, { accountId: 'acc-alex', displayName: 'Alex Kim' });
});
test('field returns the raw value', async () => {
  const { api, calls } = mk([{ fields: { duedate: '2026-03-31' } }]);
  assert.strictEqual(await api.field('DEMO-12', 'duedate'), '2026-03-31'); assert.deepStrictEqual(calls[0].q, { fields: 'duedate' });
});
test('comments returns the newest 50 oldest-first with total', async () => {
  const { api, calls } = mk([fx('comments'), { id: '9', author: { accountId: 'acc-sam', displayName: 'Sam Lee' }, created: 'c', updated: 'u', body: { type: 'doc' } }]);
  const r = await api.comments('DEMO-12');
  assert.deepStrictEqual(r.comments.map((c) => c.id), ['301', '302', '303']); assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(calls[0].q, { orderBy: '-created', maxResults: 50 });
  assert.deepStrictEqual(r.comments[0], { id: '301', author: { accountId: 'acc-sam', displayName: 'Sam Lee' }, created: '2026-01-07T10:00:00.000+0000', updated: '2026-01-07T10:00:00.000+0000', body: { type: 'doc', version: 1, content: [] } });
  const c = await api.comment('DEMO-12', '9'); assert.strictEqual(c.id, '9'); assert.strictEqual(calls[1].p, '/rest/api/3/issue/DEMO-12/comment/9');
});
test('transitions marks hasScreen', async () => {
  const { api, calls } = mk([fx('transitions')]);
  const t = await api.transitions('DEMO-12');
  assert.deepStrictEqual(calls[0].q, { expand: 'transitions.fields' });
  assert.deepStrictEqual(t, [
    { id: '11', name: 'Start', to: { name: 'In Progress', category: 'indeterminate' }, hasScreen: false },
    { id: '31', name: 'Done', to: { name: 'Done', category: 'done' }, hasScreen: true },
    { id: '21', name: 'Back to To Do', to: { name: 'To Do', category: 'new' }, hasScreen: false },
  ]);
});
test('myself has a null emailAddress when Jira hides it', async () => {
  const { api } = mk([{ accountId: 'acc-alex', displayName: 'Alex Kim' }]);
  assert.deepStrictEqual(await api.myself(), { accountId: 'acc-alex', displayName: 'Alex Kim', emailAddress: null });
});
test('projects pages through all results', async () => {
  const { api, calls } = mk([{ values: [{ key: 'DEMO', name: 'Demo', x: 1 }], isLast: false, total: 2 }, { values: [{ key: 'SAMP', name: 'Sample' }], isLast: true, total: 2 }]);
  assert.deepStrictEqual(await api.projects(), [{ key: 'DEMO', name: 'Demo' }, { key: 'SAMP', name: 'Sample' }]);
  assert.strictEqual(calls[1].q.startAt, 1);
});
test('people, priorities, myself', async () => {
  const u = { accountId: 'acc-alex', displayName: 'Alex Kim', emailAddress: 'alex@example.com' };
  const { api, calls } = mk([u, [u], [u], [{ id: '2', name: 'High', iconUrl: 'z' }]]);
  assert.deepStrictEqual(await api.myself(), { accountId: 'acc-alex', displayName: 'Alex Kim', emailAddress: 'alex@example.com' });
  assert.deepStrictEqual(await api.assignable('DEMO-12', 'al'), [{ accountId: 'acc-alex', displayName: 'Alex Kim' }]);
  assert.deepStrictEqual(calls[1].q, { issueKey: 'DEMO-12', query: 'al' });
  assert.deepStrictEqual(await api.users('al'), [{ accountId: 'acc-alex', displayName: 'Alex Kim' }]); assert.strictEqual(calls[2].p, '/rest/api/3/user/search');
  assert.deepStrictEqual(await api.priorities(), [{ id: '2', name: 'High' }]);
});
test('writes send the documented requests', async () => {
  const cm = { id: '5', author: { accountId: 'a', displayName: 'A' }, created: 'c', updated: 'u', body: { type: 'doc' } };
  const { api, calls } = mk([null, null, cm, cm]);
  await api.setFields('DEMO-12', { duedate: null }); await api.transition('DEMO-12', '31');
  const added = await api.addComment('DEMO-12', { type: 'doc' }); const edited = await api.editComment('DEMO-12', '5', { type: 'doc' });
  assert.deepStrictEqual(calls.map((c) => [c.m, c.p]), [['PUT', '/rest/api/3/issue/DEMO-12'], ['POST', '/rest/api/3/issue/DEMO-12/transitions'], ['POST', '/rest/api/3/issue/DEMO-12/comment'], ['PUT', '/rest/api/3/issue/DEMO-12/comment/5']]);
  assert.deepStrictEqual(calls[0].b, { fields: { duedate: null } }); assert.deepStrictEqual(calls[1].b, { transition: { id: '31' } });
  assert.deepStrictEqual(calls[2].b, { body: { type: 'doc' } }); assert.strictEqual(added.id, '5'); assert.strictEqual(edited.id, '5');
});
test('browseUrl', () => { assert.strictEqual(mk([]).api.browseUrl('DEMO-12'), 'https://example.atlassian.net/browse/DEMO-12'); });

test('search leaves description undefined unless it asked for it', async () => {
  const page = { issues: [{ key: 'DEMO-1', id: '1', fields: { summary: 's', description: null } }] };
  const { api } = mk([page, page]);
  assert.strictEqual((await api.search('x'))[0].description, undefined);
  assert.strictEqual((await api.search('x', { fields: FIELDS + ',description' }))[0].description, null);
});

test('estimate is the original estimate as Jira formats it, else null', async () => {
  const withEst = { key: 'DEMO-1', id: '1', fields: { timetracking: { originalEstimate: '2d 4h', originalEstimateSeconds: 72000 } } };
  const none = { key: 'DEMO-2', id: '2', fields: { timetracking: {} } };
  const missing = { key: 'DEMO-3', id: '3', fields: {} };
  const { api } = mk([{ issues: [withEst, none, missing] }]);
  const got = await api.search('x');
  assert.deepStrictEqual(got.map((i) => i.estimate), ['2d 4h', null, null]);
  assert.ok(FIELDS.split(',').includes('timetracking'));
});

test('boards pages through all results with startAt/isLast and never refreshes the sign-in', async () => {
  const { api, calls } = mk([{ values: [{ id: 1, name: 'Demo board', type: 'scrum', x: 1 }], isLast: false }, { values: [{ id: 2, name: 'Kanban', type: 'kanban' }], isLast: true }]);
  assert.deepStrictEqual(await api.boards('DEMO'), [{ id: 1, name: 'Demo board', type: 'scrum' }, { id: 2, name: 'Kanban', type: 'kanban' }]);
  assert.deepStrictEqual(calls.map((c) => c.p), ['/rest/agile/1.0/board', '/rest/agile/1.0/board']);
  assert.deepStrictEqual(calls[0].q, { projectKeyOrId: 'DEMO', startAt: 0, maxResults: 50 });
  assert.strictEqual(calls[1].q.startAt, 1);
  assert.deepStrictEqual(calls[0].o, { refresh: false });
});
test('sprints: active and future in full; closed only the last page, for the most recent', async () => {
  const s = (id, state) => ({ id, name: `Sprint ${id}`, state, startDate: '2027-01-01T00:00:00.000Z', endDate: '2027-01-14T00:00:00.000Z', originBoardId: 1 });
  const { api, calls } = mk([
    { values: [s(7, 'active'), s(8, 'future')], isLast: false }, { values: [s(9, 'future')], isLast: true },
    { values: [s(1, 'closed'), s(2, 'closed')], isLast: false, total: 6, maxResults: 2 },
    { values: [s(5, 'closed'), s(6, 'closed')], isLast: true, total: 6, maxResults: 2 },
  ]);
  const got = await api.sprints(1);
  assert.deepStrictEqual(got[0], { id: 7, name: 'Sprint 7', state: 'active', startDate: '2027-01-01T00:00:00.000Z', endDate: '2027-01-14T00:00:00.000Z' });
  assert.deepStrictEqual(got.map((x) => x.id), [7, 8, 9, 1, 2, 5, 6]);
  assert.strictEqual(calls[0].p, '/rest/agile/1.0/board/1/sprint');
  assert.deepStrictEqual(calls.map((c) => [c.q.state, c.q.startAt]), [['active,future', 0], ['active,future', 2], ['closed', 0], ['closed', 4]]);
  assert.ok(calls.every((c) => c.q.maxResults === 50 && c.o.refresh === false));
  const empty = mk([{ values: [], isLast: false }, { values: [], isLast: true, total: 0 }]);
  assert.deepStrictEqual(await empty.api.sprints(3), [], 'an empty page ends the paging');
});
test('sprints: a board with hundreds of closed sprints costs a bounded number of requests', async () => {
  const closed = Array.from({ length: 730 }, (_, i) => ({ id: i + 1, name: `S${i + 1}`, state: 'closed', endDate: new Date(Date.UTC(2010, 0, 1) + i * 864e5 * 14).toISOString() }));
  const calls = [];
  const http = { get: async (p, q) => {
    calls.push(q);
    if (q.state !== 'closed') return { values: [], isLast: true };
    const values = closed.slice(q.startAt, q.startAt + 50);
    return { values, isLast: q.startAt + values.length >= closed.length, total: closed.length, maxResults: 50 };
  } };
  const got = await createApi(http, {}).sprints(1);
  assert.ok(calls.length <= 4, `${calls.length} requests`);
  assert.ok(got.some((x) => x.id === 730) && got.some((x) => x.id === 728), 'the most recent closed sprints are in');
  const { sprintChoices } = require('../src/periods');
  assert.deepStrictEqual(sprintChoices(got).map((c) => c.id), ['730', '729', '728', 'any']);
});
test('versions of a project, read like any other call', async () => {
  const { api, calls } = mk([[
    { id: '10001', name: 'v1.0', released: true, archived: false, releaseDate: '2026-10-01', self: 'x' },
    { id: '10002', name: 'v1.1', released: false, archived: false },
  ]]);
  assert.deepStrictEqual(await api.versions('DEMO'), [
    { id: '10001', name: 'v1.0', released: true, archived: false, releaseDate: '2026-10-01' },
    { id: '10002', name: 'v1.1', released: false, archived: false, releaseDate: null },
  ]);
  assert.strictEqual(calls[0].p, '/rest/api/3/project/DEMO/versions');
  assert.strictEqual(calls[0].o, undefined, 'a plain read: a 401 refreshes the sign-in like any other');
});
