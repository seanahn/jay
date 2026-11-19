'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createWriter } = require('../src/writes');
const { JiraError, Offline, Timeout } = require('../src/http');

const doc = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const NOW = Date.parse('2026-01-01T12:00:00.000Z');
// Scripted fake api: each method takes the next scripted reply (value, function, or Error to throw) and counts calls.
function fake(script) {
  const calls = [];
  const api = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push({ name, args });
    const q = script[name] || []; const r = q.length > 1 ? q.shift() : q[0];
    const v = typeof r === 'function' ? r(...args) : r;
    if (v instanceof Error) throw v;
    return v;
  } });
  const count = (n) => calls.filter((c) => c.name === n).length;
  return { api, calls, count };
}
const w = (f, extra) => createWriter({ api: f.api, meId: 'me', now: () => NOW, ...extra });

test('conflict when description changed; nothing sent', async () => {
  const f = fake({ field: [doc('theirs')] });
  const r = await w(f).saveText('DEMO-1', 'description', doc('mine'), doc('orig'));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'conflict');
  assert.strictEqual(f.count('setFields'), 0);
});
test('other changes do not block: unrelated updated time ignored', async () => {
  const f = fake({ field: [doc('orig'), doc('mine')], setFields: [undefined] });
  const r = await w(f).saveText('DEMO-1', 'description', doc('mine'), doc('orig'));
  assert.deepStrictEqual(r, { ok: true, value: doc('mine') });
  assert.deepStrictEqual(f.calls.find((c) => c.name === 'setFields').args, ['DEMO-1', { description: doc('mine') }]);
});
test('summary compares exactly; description null equals empty doc', async () => {
  const f = fake({ field: ['Title '], setFields: [undefined] });
  assert.strictEqual((await w(f).saveText('DEMO-1', 'summary', 'New', 'Title')).kind, 'conflict');
  const g = fake({ field: [null, null], setFields: [undefined] });
  const r = await w(g).saveText('DEMO-1', 'description', doc('x'), { type: 'doc', version: 1, content: [] });
  assert.strictEqual(r.ok, true);
});
test('ok with null value when read-back fails', async () => {
  const f = fake({ field: ['Old', new Offline()], setFields: [undefined] });
  assert.deepStrictEqual(await w(f).saveText('DEMO-1', 'summary', 'New', 'Old'), { ok: true, value: null });
});
test('busy while a write to the same key is pending', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = fake({ field: ['Old', 'New'], setFields: [(k) => (k === 'DEMO-1' ? gate : undefined)] });
  const wr = w(f);
  const p1 = wr.saveText('DEMO-1', 'summary', 'New', 'Old');
  assert.strictEqual(wr.pending('DEMO-1'), true);
  const r2 = await wr.transition('DEMO-1', '31');
  assert.deepStrictEqual([r2.ok, r2.kind], [false, 'busy']);
  assert.strictEqual(f.count('transition'), 0);
  assert.strictEqual((await wr.setField('DEMO-2', 'labels', ['a'])).kind !== 'busy', true);
  release(); assert.strictEqual((await p1).ok, true);
  assert.strictEqual(wr.pending('DEMO-1'), false);
});
test('pending cleared after failure', async () => {
  const f = fake({ field: ['Old'], setFields: [new Offline()] });
  const wr = w(f); await wr.saveText('DEMO-1', 'summary', 'New', 'Old');
  assert.strictEqual(wr.pending('DEMO-1'), false);
});
test('timeout then read-back equal reports ok and sent once', async () => {
  const f = fake({ field: ['Old', 'New'], setFields: [new Timeout()] });
  const r = await w(f).saveText('DEMO-1', 'summary', 'New', 'Old');
  assert.deepStrictEqual(r, { ok: true, value: 'New' }); assert.strictEqual(f.count('setFields'), 1);
});
test('timeout then read-back differs or fails is failed, sent once', async () => {
  const f = fake({ field: ['Old', 'Old'], setFields: [new Timeout()] });
  const r = await w(f).saveText('DEMO-1', 'summary', 'New', 'Old');
  assert.deepStrictEqual([r.ok, r.kind], [false, 'failed']); assert.strictEqual(f.count('setFields'), 1);
  const g = fake({ field: ['Old', new Offline()], setFields: [new Timeout()] });
  assert.strictEqual((await w(g).saveText('DEMO-1', 'summary', 'New', 'Old')).kind, 'failed');
});
test('comment timeout finds own comment and reports saved', async () => {
  const mine = { id: '9', author: { accountId: 'me' }, created: new Date(NOW - 60000).toISOString(), body: doc('hi') };
  const f = fake({ addComment: [new Timeout()], comments: [{ comments: [], total: 0 }, { comments: [mine], total: 1 }] });
  const r = await w(f).addComment('DEMO-1', doc('hi'));
  assert.deepStrictEqual(r, { ok: true, value: mine }); assert.strictEqual(f.count('addComment'), 1);
});
test('comment timeout without own comment is failed, sent once', async () => {
  const other = { id: '8', author: { accountId: 'x' }, created: new Date(NOW - 1000).toISOString(), body: doc('hi') };
  const old = { id: '7', author: { accountId: 'me' }, created: new Date(NOW - 6 * 60000).toISOString(), body: doc('hi') };
  const f = fake({ addComment: [new Timeout()], comments: [{ comments: [old, other], total: 2 }] });
  const r = await w(f).addComment('DEMO-1', doc('hi'));
  assert.deepStrictEqual([r.ok, r.kind], [false, 'failed']); assert.strictEqual(f.count('addComment'), 1);
});
test('comment timeout does not match an earlier identical own comment', async () => {
  const earlier = { id: '5', author: { accountId: 'me' }, created: new Date(NOW - 120000).toISOString(), body: doc('+1') };
  const f = fake({ addComment: [new Timeout()], comments: [{ comments: [earlier], total: 1 }] });
  const r = await w(f).addComment('DEMO-1', doc('+1'));
  assert.deepStrictEqual([r.ok, r.kind], [false, 'failed']); assert.strictEqual(f.count('addComment'), 1);
});
test('unreadable 2xx response: read-back finds the new comment, sent once', async () => {
  const fresh = { id: '6', author: { accountId: 'me' }, created: new Date(NOW - 1000).toISOString(), body: doc('hi') };
  const f = fake({ addComment: [new TypeError('bad body')], comments: [{ comments: [], total: 0 }, { comments: [fresh], total: 1 }] });
  assert.deepStrictEqual(await w(f).addComment('DEMO-1', doc('hi')), { ok: true, value: fresh });
  assert.strictEqual(f.count('addComment'), 1);
});
test('snapshot read failing does not block the write', async () => {
  const fresh = { id: '6', author: { accountId: 'me' }, created: new Date(NOW).toISOString(), body: doc('hi') };
  const f = fake({ addComment: [fresh], comments: [new Offline()] });
  assert.strictEqual((await w(f).addComment('DEMO-1', doc('hi'))).ok, true);
});
test('labels read-back compares as sets', async () => {
  const f = fake({ setFields: [new Timeout()], field: [['b', 'a']] });
  assert.strictEqual((await w(f).setField('DEMO-1', 'labels', ['a', 'b'])).ok, true);
});
test('addComment ok returns the new comment', async () => {
  const c = { id: '1' };
  assert.deepStrictEqual(await w(fake({ addComment: [c] })).addComment('DEMO-1', doc('a')), { ok: true, value: c });
});
test('429 failed with retry text; 403 rejected with Jira message', async () => {
  const f = fake({ addComment: [new JiraError(429, [], 30000)] });
  const r = await w(f).addComment('DEMO-1', doc('a'));
  assert.deepStrictEqual([r.ok, r.kind, r.retryAfterMs], [false, 'failed', 30000]);
  assert.match(r.message, /try again in 30 s/);
  const g = fake({ addComment: [new JiraError(403, ['No permission', 'Sorry'])] });
  const r2 = await w(g).addComment('DEMO-1', doc('a'));
  assert.deepStrictEqual([r2.kind, r2.message], ['rejected', 'No permission; Sorry']);
  const h = fake({ addComment: [new JiraError(400, [])] });
  assert.strictEqual((await w(h).addComment('DEMO-1', doc('a'))).message, 'Jira rejected the change (400)');
  const i = fake({ addComment: [new JiraError(503, [])] });
  assert.strictEqual((await w(i).addComment('DEMO-1', doc('a'))).kind, 'failed');
});
test('SignInNeeded is failed with Retry, never resent', async () => {
  const e = new Error('x'); e.name = 'SignInNeeded';
  const f = fake({ addComment: [e] });
  const r = await w(f).addComment('DEMO-1', doc('a'));
  assert.deepStrictEqual([r.kind, r.message], ['failed', 'Sign in again, then Retry']); assert.strictEqual(f.count('addComment'), 1);
});
test('a 401 on a write is failed, with Retry (design: refresh once, then failed); never resent', async () => {
  for (const [name, call] of [['addComment', (x) => x.addComment('DEMO-1', doc('a'))], ['setFields', (x) => x.setField('DEMO-1', 'priority', '2')],
    ['transition', (x) => x.transition('DEMO-1', '31')]]) {
    const f = fake({ [name]: [new JiraError(401, [])] });
    const r = await call(w(f));
    assert.deepStrictEqual([r.ok, r.kind, r.message], [false, 'failed', 'Jira refused the sign-in (401); not saved'], name);
    assert.strictEqual(f.count(name), 1, name);
  }
});
test('pre-save read offline: failed, nothing sent', async () => {
  const f = fake({ field: [new Offline()] });
  const r = await w(f).saveText('DEMO-1', 'summary', 'N', 'O');
  assert.deepStrictEqual([r.kind, r.message], ['failed', 'Offline — not sent']); assert.strictEqual(f.count('setFields'), 0);
});
test('offline on the write itself says Offline', async () => {
  const f = fake({ addComment: [new Offline()] });
  assert.strictEqual((await w(f).addComment('DEMO-1', doc('a'))).message, 'Offline');
});
test('editComment of another\'s comment refuses without calling api write', async () => {
  const f = fake({ comment: [{ id: '1', author: { accountId: 'x' }, body: doc('a') }] });
  const r = await w(f).editComment('DEMO-1', '1', doc('b'), doc('a'));
  assert.deepStrictEqual([r.kind, r.message], ['rejected', 'You can only edit your own comments']);
  assert.strictEqual(f.count('editComment'), 0);
});
test('editComment conflict, success, timeout read-back', async () => {
  const cur = (t) => ({ id: '1', author: { accountId: 'me' }, body: doc(t) });
  const f = fake({ comment: [cur('changed')] });
  assert.strictEqual((await w(f).editComment('DEMO-1', '1', doc('b'), doc('a'))).kind, 'conflict');
  assert.strictEqual(f.count('editComment'), 0);
  const g = fake({ comment: [cur('a')], editComment: [cur('b')] });
  assert.deepStrictEqual(await w(g).editComment('DEMO-1', '1', doc('b'), doc('a')), { ok: true, value: cur('b') });
  const h = fake({ comment: [cur('a'), cur('b')], editComment: [new Timeout()] });
  const r = await w(h).editComment('DEMO-1', '1', doc('b'), doc('a'));
  assert.deepStrictEqual(r, { ok: true, value: cur('b') }); assert.strictEqual(h.count('editComment'), 1);
});
test('setField and transition send once and return ok', async () => {
  const f = fake({ setFields: [undefined], field: [{ accountId: 'u1' }] });
  assert.deepStrictEqual(await w(f).setField('DEMO-1', 'assignee', 'u1'), { ok: true, value: { accountId: 'u1' } });
  assert.deepStrictEqual(f.calls[0].args, ['DEMO-1', { assignee: { accountId: 'u1' } }]); assert.strictEqual(f.count('setFields'), 1);
  const t = fake({ transition: [undefined] });
  assert.deepStrictEqual(await w(t).transition('DEMO-1', '31'), { ok: true, value: null });
  assert.deepStrictEqual(t.calls[0].args, ['DEMO-1', '31']); assert.strictEqual(t.count('transition'), 1);
});
test('setField mappings', async () => {
  const sent = async (field, value) => { const f = fake({ setFields: [undefined], field: [null] }); await w(f).setField('DEMO-1', field, value); return f.calls[0].args[1]; };
  assert.deepStrictEqual(await sent('assignee', null), { assignee: null });
  assert.deepStrictEqual(await sent('priority', '2'), { priority: { id: '2' } });
  assert.deepStrictEqual(await sent('duedate', '2026-02-01'), { duedate: '2026-02-01' });
  assert.deepStrictEqual(await sent('duedate', null), { duedate: null });
  assert.deepStrictEqual(await sent('labels', ['a', 'b']), { labels: ['a', 'b'] });
});
test('setField timeout read-back equal is ok, else failed', async () => {
  const f = fake({ setFields: [new Timeout()], field: [{ id: '2' }] });
  assert.deepStrictEqual(await w(f).setField('DEMO-1', 'priority', '2'), { ok: true, value: { id: '2' } });
  assert.strictEqual(f.count('setFields'), 1);
  const g = fake({ setFields: [new Timeout()], field: [['a']] });
  assert.strictEqual((await w(g).setField('DEMO-1', 'labels', ['a', 'b'])).kind, 'failed');
});
test('transition timeout is failed, sent once', async () => {
  const f = fake({ transition: [new Timeout()] });
  assert.strictEqual((await w(f).transition('DEMO-1', '31')).kind, 'failed'); assert.strictEqual(f.count('transition'), 1);
});
