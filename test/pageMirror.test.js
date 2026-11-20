'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createPageMirror, formatPage } = require('../src/pageMirror');

const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).toISOString();
const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const doc = (...c) => ({ type: 'doc', version: 1, content: c });

function view(o = {}) {
  return {
    page: {
      id: '1001', spaceId: '7', title: 'Release plan', status: 'current', subtype: null,
      version: { number: 4, authorId: 'acc-bo', createdAt: local(2026, 11, 18, 9, 5) }, authorId: 'acc-ann', createdAt: local(2026, 11, 2, 13, 21),
      parentId: '1000', webUrl: 'https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Release+plan', tinyUrl: null, ancestors: [], editor: 'v2',
      adf: doc(p('Tracks DEMO-1 and DEMO-7, then DEMO-1 again.'), { type: 'extension', attrs: { extensionKey: 'toc' } }),
    },
    spaceKey: 'DEMO', spaceName: 'Demo space', path: [{ title: 'Demo home' }, { title: '…' }, { title: 'Plans' }],
    authorName: 'Ann Example', editorName: 'Bo Sample',
    children: [{ id: '1002', title: 'Rollback' }, { id: '1003', title: 'Schedule' }],
    footer: [{
      id: 'c1', kind: 'footer', authorId: 'acc-ann', createdAt: local(2026, 11, 17, 14, 19), version: 1, adf: doc(p('First line')),
      replies: [{ id: 'c2', kind: 'footer', authorId: 'acc-bo', createdAt: local(2026, 11, 17, 15, 0), version: 1, adf: doc(p('Thanks')), replies: [] }],
    }],
    inline: [{ id: 'c3', kind: 'inline', authorId: 'acc-bo', createdAt: local(2026, 11, 17, 16, 30), version: 1, adf: doc(p('Is this date firm?')), replies: [], quote: 'ship on Friday', resolved: false }],
    names: new Map([['acc-ann', 'Ann Example'], ['acc-bo', 'Bo Sample']]),
    ...o,
  };
}

const EXPECTED = `# Confluence page 1001: Release plan
# https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Release+plan
# Written by jay; mirrors this page. Other pages: read their .confluence files or use a Confluence MCP server.

Space: DEMO (Demo space) · Version: 4 · Author: Ann Example · Updated: 2026-11-18 09:05 by Bo Sample
Path: Demo home › … › Plans

## Body
Tracks DEMO-1 and DEMO-7, then DEMO-1 again.

[macro: toc]

## Comments (1 of 1)
[2026-11-17 14:19] Ann Example:
  First line
  ↳ [2026-11-17 15:00] Bo Sample:
      Thanks

## Inline comments
> ship on Friday
[2026-11-17 16:30] Bo Sample: Is this date firm?

## Children
- Rollback (1002)
- Schedule (1003)

## Jira keys
DEMO-1, DEMO-7
`;

test('page file matches the format exactly', () => {
  assert.strictEqual(formatPage(view()), EXPECTED);
});

test('comment heading says newest N of M when capped', () => {
  assert.ok(formatPage(view({ footerTotal: 73 })).includes('## Comments (newest 1 of 73)\n'));
});

test('commenter names stay on one line (footer, reply and inline)', () => {
  const out = formatPage(view({ names: new Map([['acc-ann', 'Ann\n## Body\nfake'], ['acc-bo', 'Bo\r\n## Jira keys']]) }));
  assert.ok(out.includes('[2026-11-17 14:19] Ann ## Body fake:\n'), out);
  assert.ok(out.includes('  ↳ [2026-11-17 15:00] Bo ## Jira keys:\n'), out);
  assert.ok(out.includes('[2026-11-17 16:30] Bo ## Jira keys: Is this date firm?\n'), out);
  assert.strictEqual(out.match(/^## Body$/gm).length, 1);
});

test('empty sections are left out', () => {
  const v = view({ footer: [], inline: [], children: [], path: [] });
  v.page.adf = doc(p('Nothing to see.'));
  const out = formatPage(v);
  assert.ok(!out.includes('## Inline comments') && !out.includes('## Children') && !out.includes('## Jira keys') && !out.includes('Path:'), out);
  assert.ok(out.includes('## Comments (0 of 0)'));
});

function setup(enabled = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-pm-'));
  return { dir, m: createPageMirror({ dir, enabled }) };
}
const mode = (f) => fs.statSync(f).mode & 0o777;

test('files are 600 in 700 dirs, current only after setCurrent', () => {
  const { dir, m } = setup();
  const f = m.write(view());
  assert.strictEqual(f, path.join(dir, 'pages', 'DEMO-1001.confluence'));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), EXPECTED);
  assert.strictEqual(mode(f), 0o600); assert.strictEqual(mode(path.dirname(f)), 0o700); assert.strictEqual(mode(dir), 0o700);
  assert.ok(!fs.existsSync(path.join(dir, 'current.confluence')));
  m.setCurrent(f);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'current.confluence'), 'utf8'), EXPECTED);
  assert.strictEqual(mode(path.join(dir, 'current.confluence')), 0o600);
  assert.strictEqual(m.pathFor('DEMO', '1001'), f);
});

test('rewrite updates current only while it is still ours', () => {
  const { dir, m } = setup();
  const f = m.write(view()); m.setCurrent(f);
  const other = view(); other.page = { ...other.page, id: '2002', webUrl: 'https://example.atlassian.net/wiki/spaces/DEMO/pages/2002/Other' };
  fs.writeFileSync(path.join(dir, 'current.confluence'), `# Confluence page 2002: Other\n# ${other.page.webUrl}\n`);
  m.write(view({ footerTotal: 9 }));
  assert.ok(fs.readFileSync(path.join(dir, 'current.confluence'), 'utf8').startsWith('# Confluence page 2002'));
});

test('disabled writes nothing; closed and clearFiles remove', () => {
  const off = setup(() => false);
  assert.strictEqual(off.m.write(view()), null);
  assert.ok(!fs.existsSync(path.join(off.dir, 'pages')));
  const { dir, m } = setup();
  const f = m.write(view()); m.setCurrent(f);
  m.closed('DEMO', '1001'); assert.ok(!fs.existsSync(f)); assert.strictEqual(m.pathFor('DEMO', '1001'), null);
  m.write(view()); m.setCurrent(m.pathFor('DEMO', '1001'));
  fs.writeFileSync(path.join(dir, 'seen.json'), '{}');
  m.clearFiles();
  assert.ok(!fs.existsSync(path.join(dir, 'pages')) && !fs.existsSync(path.join(dir, 'current.confluence')));
  assert.ok(fs.existsSync(path.join(dir, 'seen.json')));
  m.write(view()); m.clearAll();
  assert.ok(!fs.existsSync(path.join(dir, 'pages')));
});
