'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { parsePageUrl, decodeTiny, confluenceLinksIn } = require('../src/pageLinks');

const SITE = 'https://example.atlassian.net';
const enc = (id) => { let n = BigInt(id); const b = []; while (n) { b.push(Number(n & 255n)); n >>= 8n; } return Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\//g, '-').replace(/\+/g, '_'); };

test('page URL forms', () => {
  assert.deepStrictEqual(parsePageUrl(SITE + '/wiki/spaces/DEMO/pages/1001/Setup+guide', SITE), { pageId: '1001' });
  assert.deepStrictEqual(parsePageUrl(SITE + '/wiki/spaces/DEMO/pages/edit-v2/1001', SITE), { pageId: '1001' });
  assert.deepStrictEqual(parsePageUrl(SITE + '/wiki/pages/viewpage.action?pageId=1001', SITE), { pageId: '1001' });
  assert.deepStrictEqual(parsePageUrl(SITE + '/wiki/spaces/DEMO/pages/1001?focusedCommentId=77', SITE), { pageId: '1001', commentId: '77' });
  assert.deepStrictEqual(parsePageUrl('https://EXAMPLE.atlassian.net/wiki/spaces/DEMO/pages/1001#top', SITE), { pageId: '1001' });
});
test('not jay pages', () => {
  for (const u of ['https://other.atlassian.net/wiki/spaces/DEMO/pages/1001', SITE + '/wiki/spaces/DEMO/blog/2027/01/01/1001', SITE + '/wiki/spaces/DEMO/whiteboard/1001',
    SITE + '/wiki/pages/viewpage.action', SITE + '/wiki/x/!!', 'http://example.atlassian.net/wiki/spaces/DEMO/pages/1001', SITE + '/browse/DEMO-1', 'not a url', ''])
    assert.strictEqual(parsePageUrl(u, SITE), null, u);
  assert.strictEqual(parsePageUrl(null, SITE), null);
});
test('decodeTiny round-trips little-endian ids', () => {
  for (const id of ['1001', '123456789', '98765432101']) assert.strictEqual(decodeTiny(enc(id)), id);
  assert.strictEqual(decodeTiny(''), null);
  assert.strictEqual(decodeTiny('AAAA'), null);
  assert.strictEqual(decodeTiny('a+b'), null);
  assert.strictEqual(parsePageUrl(SITE + '/wiki/x/' + enc('1001'), SITE).pageId, '1001');
});
test('confluenceLinksIn finds cards, link marks and bare URLs once each', () => {
  const a = SITE + '/wiki/spaces/DEMO/pages/1001/A';
  const b = SITE + '/wiki/spaces/DEMO/pages/1002/B';
  const c = SITE + '/wiki/spaces/DEMO/pages/1003/C';
  const adf = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: a } }, { type: 'text', text: 'see ' }, { type: 'text', text: 'B', marks: [{ type: 'link', attrs: { href: b } }] }] },
    { type: 'blockCard', attrs: { url: a } },
    { type: 'paragraph', content: [{ type: 'text', text: 'and ' + c + ', plus ' + SITE + '/browse/DEMO-1 done' }] },
  ] };
  assert.deepStrictEqual(confluenceLinksIn(adf, SITE), [a, b, c]);
  assert.deepStrictEqual(confluenceLinksIn(null, SITE), []);
});
