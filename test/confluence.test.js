'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const path = require('node:path');
const { createConfluence } = require('../src/confluence');
const { JiraError } = require('../src/http');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n + '.json'), 'utf8'));
function mk(replies) {
  const calls = [];
  const next = (r, ...a) => (typeof r === 'function' ? r(...a) : r);
  const http = {
    get: async (p, q) => { calls.push({ m: 'GET', p, q }); return next(replies.shift(), p, q); },
    send: async (m, p, b, o) => { calls.push(o === undefined ? { m, p, b } : { m, p, b, o }); return next(replies.shift(), p, b); },
  };
  const auth = { siteUrl: () => 'https://example.atlassian.net' };
  return { cf: createConfluence(http, auth), calls };
}

test('spaces maps items and returns the cursor from _links.next', async () => {
  const { cf, calls } = mk([fx('conf-spaces')]);
  const r = await cf.spaces();
  assert.deepStrictEqual(calls[0], { m: 'GET', p: '/api/v2/spaces', q: { limit: 250, sort: 'name', cursor: undefined } });
  assert.deepStrictEqual(r.items[0], { id: '2001', key: 'DEMO', name: 'Demo Space', type: 'global', homepageId: '1001' });
  assert.strictEqual(r.next, 'CUR2');
  const { cf: c2, calls: k2 } = mk([{ results: [] }]);
  assert.strictEqual((await c2.spaces({ cursor: 'CUR2' })).next, null); assert.strictEqual(k2[0].q.cursor, 'CUR2');
});
test('spaceByKey returns the space or null', async () => {
  const { cf, calls } = mk([fx('conf-spaces'), { results: [] }]);
  assert.strictEqual((await cf.spaceByKey('DEMO')).id, '2001'); assert.deepStrictEqual(calls[0].q, { keys: 'DEMO' });
  assert.strictEqual(await cf.spaceByKey('NOPE'), null);
});
test('space(id) is cached for the api lifetime', async () => {
  const { cf, calls } = mk([fx('conf-spaces').results[0]]);
  assert.deepStrictEqual(await cf.space('2001'), { id: '2001', key: 'DEMO', name: 'Demo Space', type: 'global', homepageId: '1001' });
  await cf.space('2001'); assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].p, '/api/v2/spaces/2001');
});
test('titles batches 250 ids and leaves missing ids out', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => String(1000 + i));
  const { cf, calls } = mk([{ results: [{ id: '1000', title: 'A' }] }, { results: [{ id: '1299', title: 'Z' }] }]);
  const m = await cf.titles(ids);
  assert.strictEqual(calls.length, 2); assert.strictEqual(calls[0].p, '/api/v2/pages');
  assert.strictEqual(calls[0].q.id, ids.slice(0, 250).join(',')); assert.strictEqual(calls[0].q.limit, 250);
  assert.strictEqual(calls[1].q.id, ids.slice(250).join(','));
  assert.deepStrictEqual([...m], [['1000', 'A'], ['1299', 'Z']]);
  assert.strictEqual((await mk([]).cf.titles([])).size, 0);
});
test('rootItems and children map to Items', async () => {
  const { cf, calls } = mk([fx('conf-root'), fx('conf-children'), fx('conf-children')]);
  const r = await cf.rootItems('2001', { cursor: 'X' });
  assert.deepStrictEqual(calls[0], { m: 'GET', p: '/api/v2/spaces/2001/pages', q: { depth: 'root', status: 'current', limit: 250, cursor: 'X' } });
  assert.deepStrictEqual(r.items[1], { id: '1002', kind: 'page', title: 'Runbooks', position: 1 }); assert.strictEqual(r.next, null);
  const c = await cf.children('1001', 'page');
  assert.strictEqual(calls[1].p, '/api/v2/pages/1001/direct-children'); assert.strictEqual(calls[1].q.limit, 250);
  assert.deepStrictEqual(c.items.map((i) => i.kind), ['page', 'folder', 'whiteboard']);
  assert.deepStrictEqual(c.items[1], { id: '3001', kind: 'folder', title: 'Archive Folder', position: 1 }); assert.strictEqual(c.next, 'CH2');
  await cf.children('3001', 'folder'); assert.strictEqual(calls[2].p, '/api/v2/folders/3001/direct-children');
});
test('page parses adf, builds absolute urls, and reads ancestors and editor', async () => {
  const { cf, calls } = mk([fx('conf-page'), { results: [{ id: '900', type: 'page' }, { id: '1000', type: 'page' }] }, { results: [{ key: 'editor', value: 'v2' }] }]);
  const p = await cf.page('1001');
  assert.deepStrictEqual(calls.map((c) => c.p), ['/api/v2/pages/1001', '/api/v2/pages/1001/ancestors', '/api/v2/pages/1001/properties']);
  assert.deepStrictEqual(calls[0].q, { 'body-format': 'atlas_doc_format', 'include-version': true }); assert.deepStrictEqual(calls[2].q, { key: 'editor' });
  assert.strictEqual(p.adf.content[0].content[0].text, 'Hello from DEMO');
  assert.strictEqual(p.webUrl, 'https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Demo+Home');
  assert.strictEqual(p.tinyUrl, 'https://example.atlassian.net/wiki/x/AbCd');
  assert.deepStrictEqual(p.version, { number: 12, authorId: 'acc-bo', createdAt: '2026-11-01T10:00:00.000Z' });
  assert.deepStrictEqual(p.ancestors, [{ id: '900' }, { id: '1000' }]);
  assert.deepStrictEqual({ id: p.id, spaceId: p.spaceId, title: p.title, status: p.status, subtype: p.subtype, authorId: p.authorId, parentId: p.parentId, editor: p.editor },
    { id: '1001', spaceId: '2001', title: 'Demo Home', status: 'current', subtype: null, authorId: 'acc-me', parentId: '1000', editor: 'v2' });
});
test('page with no body or editor property gives null adf and null editor', async () => {
  const raw = { ...fx('conf-page'), body: {} };
  const p = await mk([raw, { results: [] }, { results: [] }]).cf.page('1001');
  assert.strictEqual(p.adf, null); assert.strictEqual(p.editor, null);
});
test('pageVersion maps a version and returns null on 404', async () => {
  const { cf, calls } = mk([{ number: 5, message: '', minorEdit: false, authorId: 'acc-bo', createdAt: 't', page: {} }, () => { throw new JiraError(404, []); }]);
  assert.deepStrictEqual(await cf.pageVersion('1001', 5), { number: 5, authorId: 'acc-bo', createdAt: 't' });
  assert.strictEqual(calls[0].p, '/api/v2/pages/1001/versions/5');
  assert.strictEqual(await cf.pageVersion('1001', 6), null);
  await assert.rejects(mk([() => { throw new JiraError(500, []); }]).cf.pageVersion('1', 1), { status: 500 });
});
test('currentVersion and pageAt', async () => {
  const { cf, calls } = mk([{ id: '1001', version: { number: 12 } }, fx('conf-page')]);
  assert.strictEqual(await cf.currentVersion('1001'), 12); assert.strictEqual(calls[0].p, '/api/v2/pages/1001'); assert.strictEqual(calls[0].q, undefined);
  const a = await cf.pageAt('1001', 7);
  assert.deepStrictEqual(calls[1].q, { version: 7, 'body-format': 'atlas_doc_format' });
  assert.strictEqual(a.title, 'Demo Home'); assert.strictEqual(a.adf.type, 'doc');
});
test('updatePage sends exactly the PUT body and returns a Page', async () => {
  const adf = { version: 1, type: 'doc', content: [] };
  const { cf, calls } = mk([fx('conf-page')]);
  const p = await cf.updatePage('1001', { title: 'New', adf, version: 13 });
  assert.deepStrictEqual(calls[0], { m: 'PUT', p: '/api/v2/pages/1001', b: { id: '1001', status: 'current', title: 'New', body: { representation: 'atlas_doc_format', value: JSON.stringify(adf) }, version: { number: 13, message: '' } } });
  assert.strictEqual(p.id, '1001');
});
test('footerComments follows cursors, attaches replies, caps at the newest 50', async () => {
  const { cf, calls } = mk([fx('conf-footer'), { results: [] }, fx('conf-replies'), { results: [] }]);
  const cs = await cf.footerComments('1001');
  assert.deepStrictEqual(calls[0], { m: 'GET', p: '/api/v2/pages/1001/footer-comments', q: { 'body-format': 'atlas_doc_format', limit: 100, cursor: undefined } });
  assert.strictEqual(calls[1].q.cursor, 'FC2');
  assert.deepStrictEqual(calls.slice(2).map((c) => c.p), ['/api/v2/footer-comments/5001/children', '/api/v2/footer-comments/5002/children']);
  assert.deepStrictEqual(calls[2].q, { 'body-format': 'atlas_doc_format', limit: 100, cursor: undefined });
  assert.deepStrictEqual(cs.map((c) => c.id), ['5001', '5002']);
  assert.strictEqual(cs[0].kind, 'footer'); assert.strictEqual(cs[0].authorId, 'acc-bo'); assert.strictEqual(cs[0].version, 2);
  assert.strictEqual(cs[0].adf.type, 'doc'); assert.deepStrictEqual(cs[0].replies.map((r) => r.id), ['5101']); assert.deepStrictEqual(cs[1].replies, []);
  const many = { results: Array.from({ length: 60 }, (_, i) => ({ id: String(7000 + i), version: { number: 1, authorId: 'a', createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` }, body: {} })) };
  const big = mk([many, ...Array(50).fill({ results: [] })]);
  const got = await big.cf.footerComments('1001');
  assert.strictEqual(got.length, 50); assert.strictEqual(got[0].id, '7010'); assert.strictEqual(got[49].id, '7059'); assert.strictEqual(got[0].adf, null);
  assert.strictEqual(got.total, 60, 'the top-level count it saw'); assert.strictEqual(cs.total, 2);
});
test('inlineComments add quote and resolved', async () => {
  const { cf, calls } = mk([fx('conf-inline'), { results: [] }]);
  const cs = await cf.inlineComments('1001');
  assert.strictEqual(calls[0].p, '/api/v2/pages/1001/inline-comments'); assert.strictEqual(calls[1].p, '/api/v2/inline-comments/6001/children');
  assert.strictEqual(cs[0].kind, 'inline'); assert.strictEqual(cs[0].quote, 'Hello'); assert.strictEqual(cs[0].resolved, false);
  const done = await mk([{ results: [{ ...fx('conf-inline').results[0], resolutionStatus: 'resolved' }] }, { results: [] }]).cf.inlineComments('1001');
  assert.strictEqual(done[0].resolved, true);
});
test('addFooterComment, reply, comment and editComment', async () => {
  const adf = { version: 1, type: 'doc', content: [] }; const body = { representation: 'atlas_doc_format', value: JSON.stringify(adf) };
  const one = fx('conf-footer').results[0];
  const { cf, calls } = mk([one, one, one, one]);
  assert.strictEqual((await cf.addFooterComment('1001', adf)).id, '5001');
  assert.deepStrictEqual(calls[0], { m: 'POST', p: '/api/v2/footer-comments', b: { pageId: '1001', body } });
  await cf.reply('5001', 'footer', adf); assert.deepStrictEqual(calls[1], { m: 'POST', p: '/api/v2/footer-comments', b: { parentCommentId: '5001', body } });
  await cf.reply('6001', 'inline', adf); assert.strictEqual(calls[2].p, '/api/v2/inline-comments');
  const c = await cf.comment('5001', 'footer'); assert.strictEqual(calls[3].p, '/api/v2/footer-comments/5001'); assert.strictEqual(calls[3].q.limit, undefined); assert.strictEqual(c.kind, 'footer');
  const e = mk([one]); await e.cf.editComment('6001', 'inline', adf, 3);
  assert.deepStrictEqual(e.calls[0], { m: 'PUT', p: '/api/v2/inline-comments/6001', b: { version: { number: 3 }, body } });
});
test('users batches 100 and never asks twice for an id', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => 'acc-' + i);
  const reply = (_p, b) => ({ results: b.accountIds.map((a) => ({ accountId: a, displayName: 'N ' + a, email: 'x' })) });
  const { cf, calls } = mk([reply, reply]);
  const m = await cf.users(ids);
  assert.strictEqual(calls.length, 2); assert.strictEqual(calls[0].p, '/api/v2/users-bulk'); assert.strictEqual(calls[0].b.accountIds.length, 100); assert.strictEqual(calls[1].b.accountIds.length, 50);
  assert.deepStrictEqual(m.get('acc-149'), { accountId: 'acc-149', displayName: 'N acc-149' });
  await cf.users(['acc-1', 'acc-2']); assert.strictEqual(calls.length, 2, 'cached');
  assert.strictEqual(calls[0].o.read, true);
  const { cf: c2, calls: k2 } = mk([reply]); await c2.users(['a', 'a', 'b']); assert.deepStrictEqual(k2[0].b.accountIds, ['a', 'b']);
});
test('search maps page and comment hits; a comment hit takes the container id', async () => {
  const { cf, calls } = mk([fx('conf-search-mentions')]);
  const r = await cf.search('mention = "acc-me"', { limit: 10, start: 5 });
  assert.deepStrictEqual(calls[0], { m: 'GET', p: '/rest/api/search', q: { cql: 'mention = "acc-me"', limit: 10, start: 5, expand: 'content.version,content.space,content.container' } });
  assert.strictEqual(r.total, 7);
  assert.deepStrictEqual(r.items[0], { id: '1001', type: 'page', title: 'Demo Home', spaceKey: 'DEMO', pageId: '1001', lastModified: '2026-11-05T10:00:00.000Z',
    by: { accountId: 'acc-bo', displayName: 'Bo Sample' }, webUrl: 'https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Demo+Home' });
  assert.strictEqual(r.items[1].type, 'comment'); assert.strictEqual(r.items[1].id, '5001'); assert.strictEqual(r.items[1].pageId, '1010');
  await mk([{ results: [] }]).cf.search('x');
  const d = mk([{ results: [] }]); await d.cf.search('x'); assert.strictEqual(d.calls[0].q.limit, 25); assert.strictEqual(d.calls[0].q.start, 0);
});
test('probe asks for one space and throws what http throws', async () => {
  const { cf, calls } = mk([{ results: [] }]);
  assert.strictEqual(await cf.probe(), true); assert.deepStrictEqual(calls[0], { m: 'GET', p: '/api/v2/spaces', q: { limit: 1 } });
  await assert.rejects(mk([() => { throw new JiraError(403, []); }]).cf.probe(), { status: 403 });
});
