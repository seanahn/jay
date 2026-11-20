'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createPageTree } = require('../src/pageTree');

const item = (id, title, kind = 'page') => ({ id, kind, title, position: 0 });
/** A fake Confluence: rootItems and children by cursor; records calls. */
function fake() {
  const calls = [];
  const roots = { '': { items: [item('1001', 'Demo Home'), item('1002', 'Notes')], next: 'r2' }, r2: { items: [item('1003', 'Later')], next: null } };
  const kids = {
    '1001|': { items: [item('1101', 'Child A'), item('1102', 'Folder B', 'folder')], next: 'c2' },
    '1001|c2': { items: [item('1103', 'Child C')], next: null },
    '1102|': { items: [item('1201', 'In folder')], next: null },
  };
  return {
    calls,
    rootItems: async (spaceId, { cursor } = {}) => { calls.push(['root', spaceId, cursor || null]); return roots[cursor || '']; },
    children: async (id, kind, { cursor } = {}) => { calls.push(['children', id, kind, cursor || null]); return kids[`${id}|${cursor || ''}`] || { items: [], next: null }; },
  };
}
function make() {
  const cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tree-')), 'cache');
  const confluence = fake();
  return { cacheDir, confluence, tree: createPageTree({ confluence, cacheDir, now: () => 1000 }) };
}

test('load: the space roots, each unexpanded, with the next cursor', async () => {
  const { tree, confluence } = make();
  const t = await tree.load('2001', 'acc-ann');
  assert.strictEqual(t.spaceId, '2001');
  assert.deepStrictEqual(t.roots, ['1001', '1002']);
  assert.strictEqual(t.rootsNext, 'r2');
  assert.deepStrictEqual(t.items.get('1001'), { id: '1001', kind: 'page', title: 'Demo Home', position: 0, parentId: null, childrenLoaded: false, children: [], next: null });
  assert.deepStrictEqual(confluence.calls, [['root', '2001', null]]);
});

test('expand loads the children once, with their kinds; more follows next for a branch and for the roots', async () => {
  const { tree, confluence } = make();
  let t = await tree.load('2001', 'acc-ann');
  t = await tree.expand(t, '1001');
  assert.deepStrictEqual(t.items.get('1001').children, ['1101', '1102']);
  assert.strictEqual(t.items.get('1001').childrenLoaded, true);
  assert.strictEqual(t.items.get('1001').next, 'c2');
  assert.strictEqual(t.items.get('1102').kind, 'folder');
  assert.strictEqual(t.items.get('1101').parentId, '1001');
  await tree.expand(t, '1001');
  assert.strictEqual(confluence.calls.filter((c) => c[0] === 'children').length, 1, 'expanded once');
  t = await tree.more(t, '1001');
  assert.deepStrictEqual(t.items.get('1001').children, ['1101', '1102', '1103']);
  assert.strictEqual(t.items.get('1001').next, null);
  t = await tree.expand(t, '1102');
  assert.deepStrictEqual(confluence.calls.at(-1), ['children', '1102', 'folder', null], 'a folder is expanded as a folder');
  t = await tree.more(t, null);
  assert.deepStrictEqual(t.roots, ['1001', '1002', '1003']);
  assert.strictEqual(t.rootsNext, null);
  const n = confluence.calls.length;
  await tree.more(t, null); await tree.more(t, '1001'); await tree.expand(t, 'nope');
  assert.strictEqual(confluence.calls.length, n, 'nothing more to load: no request');
});

test('save and cached: the owner only; another owner, or no owner, gets nothing', async () => {
  const { tree, cacheDir } = make();
  let t = await tree.load('2001', 'acc-ann');
  t = await tree.expand(t, '1001');
  tree.save(t, 'acc-ann');
  const file = path.join(cacheDir, 'confluence-2001.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(cacheDir).mode & 0o777, 0o700);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw).sort(), ['items', 'owner', 'roots', 'rootsNext', 'savedAt', 'spaceId']);
  assert.strictEqual(raw.owner, 'acc-ann'); assert.strictEqual(raw.savedAt, 1000);
  const back = tree.cached('2001', 'acc-ann');
  assert.deepStrictEqual(back.roots, ['1001', '1002']);
  assert.deepStrictEqual(back.items.get('1001').children, ['1101', '1102']);
  assert.ok(back.items instanceof Map);
  assert.strictEqual(tree.cached('2001', 'acc-bo'), null, 'another account');
  assert.strictEqual(tree.cached('2001', null), null);
  assert.strictEqual(tree.cached('9999', 'acc-ann'), null, 'no file');
});

test('load with the tree before keeps the branches already loaded under roots that remain', async () => {
  const { tree } = make();
  let t = await tree.load('2001', 'acc-ann');
  t = await tree.expand(t, '1001');
  const fresh = await tree.load('2001', 'acc-ann', t);
  assert.strictEqual(fresh.items.get('1001').childrenLoaded, true);
  assert.deepStrictEqual(fresh.items.get('1001').children, ['1101', '1102']);
  assert.strictEqual(fresh.items.get('1101').title, 'Child A');
  const other = await tree.load('2002', 'acc-ann', t);
  assert.strictEqual(other.items.get('1001').childrenLoaded, false, 'another space: nothing kept');
});

test('clearAll removes every cached tree and leftover temp file, and nothing else in the cache', async () => {
  const { tree, cacheDir } = make();
  tree.save(await tree.load('2001', 'acc-ann'), 'acc-ann');
  tree.save(await tree.load('2002', 'acc-ann'), 'acc-ann');
  fs.writeFileSync(path.join(cacheDir, '.confluence-2003.json.123.tmp'), 'x');
  fs.writeFileSync(path.join(cacheDir, 'DEMO_any.json'), '{}');
  tree.clearAll();
  assert.deepStrictEqual(fs.readdirSync(cacheDir), ['DEMO_any.json']);
  assert.strictEqual(tree.cached('2001', 'acc-ann'), null);
  tree.clearAll();   // nothing left, or no cache dir: no error
  fs.rmSync(cacheDir, { recursive: true });
  tree.clearAll();
});
