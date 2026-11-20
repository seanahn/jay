'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createPageWriter } = require('../src/pageWrites');
const { mapError } = require('../src/writes');
const { JiraError, ConfluenceUnavailable, Offline, Timeout } = require('../src/http');

const doc = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
function fake(script) {
  const calls = [];
  const confluence = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push({ name, args });
    const q = script[name] || []; const r = q.length > 1 ? q.shift() : q[0];
    const v = typeof r === 'function' ? r(...args) : r;
    if (v instanceof Error) throw v;
    return v;
  } });
  const count = (n) => calls.filter((c) => c.name === n).length;
  return { confluence, calls, count };
}
const w = (f) => createPageWriter({ confluence: f.confluence, meId: 'acc-me', now: () => NOW });
const comment = (id, t, extra) => ({ id, kind: 'footer', authorId: 'acc-me', createdAt: ago(1000), version: 1, adf: doc(t), replies: [], ...extra });

test('savePage sends base+1 once and returns the new version', async () => {
  const f = fake({ updatePage: [{ id: '1001', version: { number: 13 } }] });
  const r = await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.deepStrictEqual(r, { ok: true, value: { version: 13 } });
  assert.strictEqual(f.count('updatePage'), 1);
  assert.deepStrictEqual(f.calls[0].args, ['1001', { title: 'T', adf: doc('x'), version: 13 }]);
  assert.strictEqual(f.calls.length, 1);
});
test('409 is a conflict and is never resent', async () => {
  const f = fake({ updatePage: [new JiraError(409, [])] });
  const r = await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.deepStrictEqual(r, { ok: false, kind: 'conflict', message: 'Changed in Confluence since you opened it' });
  assert.strictEqual(f.count('updatePage'), 1); assert.strictEqual(f.calls.length, 1);
});
test('title-only save when the body changed elsewhere is refused by the version check', async () => {
  const f = fake({ updatePage: [new JiraError(409, ['Version must be 14'])] });
  const wr = w(f);
  assert.strictEqual((await wr.savePage('1001', { title: 'New', adf: doc('same'), baseVersion: 12 })).kind, 'conflict');
  assert.strictEqual(f.count('updatePage'), 1);
});
test('timeout: reads version 13 by number, not latest', async () => {
  const f = fake({ updatePage: [new Timeout()], pageVersion: [{ number: 13, authorId: 'acc-me' }], pageAt: [{ title: 'T', adf: doc('x') }] });
  const r = await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.deepStrictEqual(r, { ok: true, value: { version: 13 } });
  assert.deepStrictEqual(f.calls.find((c) => c.name === 'pageVersion').args, ['1001', 13]);
  assert.deepStrictEqual(f.calls.find((c) => c.name === 'pageAt').args, ['1001', 13]);
  assert.strictEqual(f.count('updatePage'), 1);
});
test('timeout and version 13 is someone else’s → failed, no resend', async () => {
  const f = fake({ updatePage: [new Timeout()], pageVersion: [{ number: 13, authorId: 'acc-other' }] });
  const r = await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.deepStrictEqual([r.ok, r.kind], [false, 'failed']);
  assert.strictEqual(f.count('updatePage'), 1);
});
test('timeout, version 13 is mine but different content → failed; missing version → failed', async () => {
  const f = fake({ updatePage: [new Timeout()], pageVersion: [{ number: 13, authorId: 'acc-me' }], pageAt: [{ title: 'T', adf: doc('other') }] });
  assert.strictEqual((await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 })).ok, false);
  const g = fake({ updatePage: [new Timeout()], pageVersion: [null] });
  assert.strictEqual((await w(g).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 })).ok, false);
  assert.strictEqual(g.count('updatePage'), 1);
});
test('unexpected error after sending is read back too', async () => {
  const f = fake({ updatePage: [new Error('bad json')], pageVersion: [{ number: 13, authorId: 'acc-me' }], pageAt: [{ title: 'T', adf: doc('x') }] });
  assert.strictEqual((await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 })).ok, true);
});
test('a second save while one is pending is busy', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = fake({ updatePage: [() => gate] });
  const wr = w(f);
  const p1 = wr.savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.strictEqual(wr.pending('1001'), true);
  const r2 = await wr.addComment('1001', doc('hi'));
  assert.deepStrictEqual([r2.ok, r2.kind], [false, 'busy']);
  assert.match(r2.message, /page/);
  assert.strictEqual(f.count('updatePage'), 1); assert.strictEqual(f.count('addFooterComment'), 0);
  release({ version: { number: 13 } }); assert.strictEqual((await p1).ok, true);
  assert.strictEqual(wr.pending('1001'), false);
});
test('400 is rejected with Confluence’s message and nothing else is sent', async () => {
  const f = fake({ updatePage: [new JiraError(400, ['Title already exists'])] });
  const r = await w(f).savePage('1001', { title: 'T', adf: doc('x'), baseVersion: 12 });
  assert.deepStrictEqual([r.ok, r.kind, r.message], [false, 'rejected', 'Title already exists']);
  assert.strictEqual(f.calls.length, 1);
});
test('messages say Confluence; 401 says Confluence; ConfluenceUnavailable is mapped', async () => {
  const f = fake({ updatePage: [new JiraError(401, [])] });
  assert.match((await w(f).savePage('1', { title: 'T', adf: doc('x'), baseVersion: 1 })).message, /^Confluence refused/);
  const g = fake({ updatePage: [new ConfluenceUnavailable(403)] });
  const r = await w(g).savePage('1', { title: 'T', adf: doc('x'), baseVersion: 1 });
  assert.deepStrictEqual([r.kind, r.message], ['failed', "Confluence isn't available with this sign-in"]);
  assert.strictEqual(g.count('pageVersion'), 0);
  assert.strictEqual(mapError(new JiraError(401, [])).message, 'Jira refused the sign-in (401); not saved');
  assert.strictEqual(mapError(new JiraError(503, []), 'write', 'Confluence').message, 'Confluence had a problem (503)');
});
test('offline write is failed and nothing is read back', async () => {
  const f = fake({ updatePage: [new Offline()] });
  assert.strictEqual((await w(f).savePage('1', { title: 'T', adf: doc('x'), baseVersion: 1 })).message, 'Offline');
  assert.strictEqual(f.calls.length, 1);
});

test('addComment ok', async () => {
  const f = fake({ footerComments: [[]], addFooterComment: [comment('c1', 'hi')] });
  const r = await w(f).addComment('1001', doc('hi'));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.value.id, 'c1');
});
test('addComment timeout: finds my new comment, ignores old and others', async () => {
  const old = comment('c0', 'hi'); const other = comment('c2', 'hi', { authorId: 'acc-x' });
  const f = fake({ footerComments: [[old], [old, other, comment('c3', 'hi')]], addFooterComment: [new Timeout()] });
  const r = await w(f).addComment('1001', doc('hi'));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.value.id, 'c3'); assert.strictEqual(f.count('addFooterComment'), 1);
});
test('addComment timeout without a match is failed, no resend', async () => {
  const f = fake({ footerComments: [[], [comment('c3', 'hi', { createdAt: ago(10 * 60 * 1000) })]], addFooterComment: [new Timeout()] });
  assert.strictEqual((await w(f).addComment('1001', doc('hi'))).ok, false);
  assert.strictEqual(f.count('addFooterComment'), 1);
});
test('reply timeout looks in the parent’s replies', async () => {
  const parent = (replies) => comment('p1', 'q', { replies });
  const f = fake({ inlineComments: [[parent([])], [parent([comment('r1', 'yes', { kind: 'inline' })])]], reply: [new Timeout()] });
  const r = await w(f).reply('1001', 'p1', 'inline', doc('yes'));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.value.id, 'r1');
  assert.deepStrictEqual(f.calls.find((c) => c.name === 'reply').args, ['p1', 'inline', doc('yes')]);
  assert.strictEqual(f.count('reply'), 1); assert.strictEqual(f.count('footerComments'), 0);
});
test('editComment refuses another author’s comment; nothing sent', async () => {
  const f = fake({ comment: [comment('c1', 'a', { authorId: 'acc-other' })] });
  const r = await w(f).editComment('1001', 'c1', 'footer', doc('b'), 1, doc('a'));
  assert.deepStrictEqual([r.ok, r.kind], [false, 'rejected']);
  assert.strictEqual(f.count('editComment'), 0);
});
test('editComment conflict when the body changed; sends base+1 otherwise', async () => {
  const f = fake({ comment: [comment('c1', 'changed')] });
  assert.strictEqual((await w(f).editComment('1001', 'c1', 'footer', doc('b'), 1, doc('a'))).kind, 'conflict');
  assert.strictEqual(f.count('editComment'), 0);
  const g = fake({ comment: [comment('c1', 'a')], editComment: [comment('c1', 'b', { version: 2 })] });
  const r = await w(g).editComment('1001', 'c1', 'footer', doc('b'), 1, doc('a'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(g.calls.find((c) => c.name === 'editComment').args, ['c1', 'footer', doc('b'), 2]);
});
test('editComment timeout re-reads and accepts a matching body; 409 is conflict', async () => {
  const f = fake({ comment: [comment('c1', 'a'), comment('c1', 'b', { version: 2 })], editComment: [new Timeout()] });
  assert.strictEqual((await w(f).editComment('1001', 'c1', 'footer', doc('b'), 1, doc('a'))).ok, true);
  assert.strictEqual(f.count('editComment'), 1);
  const g = fake({ comment: [comment('c1', 'a')], editComment: [new JiraError(409, [])] });
  assert.strictEqual((await w(g).editComment('1001', 'c1', 'footer', doc('b'), 1, doc('a'))).kind, 'conflict');
});
