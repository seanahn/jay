'use strict';
// A space's page tree, loaded a level at a time (a space can hold thousands of pages), cached per space under ~/.jay/cache,
// owned by the account that loaded it (design 102, "The sidebar"; 101's account-owned rule).
// A Tree is { spaceId, items: Map<id, Item>, roots: [id], rootsNext }; an Item is the api's { id, kind, title, position } plus
// { parentId, childrenLoaded, children: [id], next } (next: the cursor of the children's next page).
const fs = require('fs'); const path = require('path');

const EXPANDABLE = new Set(['page', 'folder']);

function atomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function createPageTree({ confluence, cacheDir, now = Date.now }) {
  const fileOf = (spaceId) => path.join(cacheDir, `confluence-${String(spaceId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const itemOf = (i, parentId) => ({ id: String(i.id), kind: i.kind || 'page', title: i.title || '', position: i.position === undefined ? null : i.position,
    parentId, childrenLoaded: !EXPANDABLE.has(i.kind || 'page'), children: [], next: null });
  function add(tree, list, parentId) {
    const ids = [];
    for (const i of list) { const it = itemOf(i, parentId); if (!tree.items.has(it.id)) tree.items.set(it.id, it); ids.push(it.id); }
    return ids;
  }
  /** Copies the loaded branch under id from prev into tree. */
  function keep(tree, prev, id) {
    const old = prev.items.get(id); const it = tree.items.get(id);
    if (!old || !it || !old.childrenLoaded || !EXPANDABLE.has(it.kind)) return;
    Object.assign(it, { childrenLoaded: true, children: old.children.slice(), next: old.next });
    for (const k of old.children) { const o = prev.items.get(k); if (o && !tree.items.has(k)) { tree.items.set(k, { ...o, children: o.children.slice() }); keep(tree, prev, k); } }
  }

  /** The space's top level. With prev (the tree shown before, of the same space), branches already loaded under roots that remain are kept. */
  async function load(spaceId, owner, prev) {
    const r = await confluence.rootItems(spaceId);
    const tree = { spaceId, items: new Map(), roots: [], rootsNext: r.next || null };
    tree.roots = add(tree, r.items, null);
    if (prev && prev.spaceId === spaceId) for (const id of tree.roots) keep(tree, prev, id);
    return tree;
  }

  /** Loads the first page of an item's children, once. */
  async function expand(tree, id) {
    const it = tree.items.get(String(id));
    if (!it || it.childrenLoaded) return tree;
    const r = await confluence.children(it.id, it.kind);
    it.children = add(tree, r.items, it.id); it.next = r.next || null; it.childrenLoaded = true;
    return tree;
  }

  /** The next page of an item's children (id), or of the roots (null). */
  async function more(tree, id) {
    if (id === null || id === undefined) {
      if (!tree.rootsNext) return tree;
      const r = await confluence.rootItems(tree.spaceId, { cursor: tree.rootsNext });
      tree.roots = [...tree.roots, ...add(tree, r.items, null).filter((k) => !tree.roots.includes(k))]; tree.rootsNext = r.next || null;
      return tree;
    }
    const it = tree.items.get(String(id));
    if (!it || !it.next) return tree;
    const r = await confluence.children(it.id, it.kind, { cursor: it.next });
    it.children = [...it.children, ...add(tree, r.items, it.id).filter((k) => !it.children.includes(k))]; it.next = r.next || null;
    return tree;
  }

  function save(tree, owner) {
    if (!owner) return;
    atomic(fileOf(tree.spaceId), JSON.stringify({ owner, savedAt: now(), spaceId: tree.spaceId, roots: tree.roots, rootsNext: tree.rootsNext, items: [...tree.items.values()] }));
  }

  /** The cached tree, only for the account that saved it. */
  function cached(spaceId, owner) {
    if (!owner) return null;
    let o; try { o = JSON.parse(fs.readFileSync(fileOf(spaceId), 'utf8')); } catch (_) { return null; }
    if (!o || o.owner !== owner || !Array.isArray(o.items) || !Array.isArray(o.roots)) return null;
    return { spaceId: o.spaceId || spaceId, items: new Map(o.items.map((i) => [i.id, i])), roots: o.roots, rootsNext: o.rootsNext || null };
  }

  /** Signing out: every cached tree. */
  function clearAll() {
    let names = []; try { names = fs.readdirSync(cacheDir); } catch (_) { return; }
    for (const n of names) if (/^\.?confluence-.*\.(json|tmp)$/.test(n)) { try { fs.unlinkSync(path.join(cacheDir, n)); } catch (_) { /* gone */ } }
  }

  return { load, expand, more, save, cached, clearAll };
}

module.exports = { createPageTree };
