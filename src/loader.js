'use strict';
// Loads a project's epics for one quarter, their tasks and sub-tasks, keeps them in a file cache, and refreshes them
// incrementally. A View is { key, project, quarter, epics, children, index, loadedAt, fullAt }; children maps a parent key
// to its child issues and index maps every key to its issue.
// In sprint and version modes (a period { kind, id }) the tickets carry the period, so the view is built upward from its
// members: { key, project, period, members, epics, children, index, ... }, with epic-less members under NOEPIC.
// Every view has an owner, the accountId that loaded it: a cache file is only ever returned to that account.
const fs = require('node:fs'); const path = require('node:path');
const { quarterJql, quarterMatches, quarterId } = require('./quarters');
const { periodJql } = require('./periods');
const { NOEPIC } = require('./tree');

const CHUNK = 50;
const FULL_EVERY_MS = 15 * 60000;
const isMemberPeriod = (p) => !!(p && typeof p === 'object' && p.kind);
const viewKeyOf = (project, period) => `${project}|${period === 'any' ? 'any' : isMemberPeriod(period) ? `${period.kind}:${period.id}` : quarterId(period)}`;
const safeName = (viewKey) => `${viewKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
const q = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

function atomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// The cache keeps no descriptions (they can be large); the view in memory may hold them.
const slim = (i) => { const o = { ...i }; delete o.description; return o; };
const toJson = (v) => JSON.stringify({ ...v, epics: v.epics.map(slim), children: [...v.children].map(([k, cs]) => [k, cs.map(slim)]), index: [...v.index].map(([k, i]) => [k, slim(i)]) });
const fromJson = (text) => { const o = JSON.parse(text); return { ...o, children: new Map(o.children), index: new Map(o.index) }; };

/** @param fields the fields every search asks for (default: the api's) */
function createLoader({ api, cacheDir, now = Date.now, fields }) {
  const fileOf = (viewKey) => path.join(cacheDir, safeName(viewKey));
  const search = (jql) => api.search(jql, fields ? { fields } : undefined);
  const save = (view) => { atomic(fileOf(view.key), toJson(view)); return view; };

  /** The cached view, only for the account that wrote it: null for another account, no account, or a file with no owner. */
  function cached(viewKey, accountId) {
    if (!accountId) return null;
    let v; try { v = fromJson(fs.readFileSync(fileOf(viewKey), 'utf8')); } catch (_) { return null; }
    return v.owner === accountId ? v : null;
  }

  async function inChunks(keys, jqlOf, run = search) {
    const out = [];
    for (let i = 0; i < keys.length; i += CHUNK) out.push(...await run(jqlOf(keys.slice(i, i + CHUNK).join(', '))));
    return out;
  }
  const childrenOf = (keys) => inChunks(keys, (ks) => `parent in (${ks})`);

  /** @param o { project, quarter, patterns } for a quarter, or { project, period } for a sprint or version; owner: the accountId loading it */
  function load(o) {
    const period = o.period !== undefined ? o.period : o.quarter;
    const owner = o.owner || null;
    return isMemberPeriod(period) ? loadMembers(o.project, period, owner) : loadQuarter({ ...o, quarter: period, owner });
  }

  async function loadQuarter({ project, quarter, patterns, owner }) {
    const qj = quarterJql(quarter, patterns);
    const filter = quarter === 'any' ? 'statusCategory != Done' : qj;
    const found = await search(`project = ${q(project)} AND issuetype = Epic${filter ? ` AND ${filter}` : ''}`);
    const epics = found.filter((e) => quarterMatches(e, quarter, patterns));
    const children = new Map(); const index = new Map(epics.map((e) => [e.key, e]));
    let level = epics.map((e) => e.key);
    for (let depth = 0; depth < 2 && level.length; depth++) {
      const next = [];
      for (const c of await childrenOf(level)) {
        if (!children.has(c.parentKey)) children.set(c.parentKey, []);
        children.get(c.parentKey).push(c); index.set(c.key, c); next.push(c.key);
      }
      level = next;
    }
    const t = now();
    return save({ key: viewKeyOf(project, quarter), project, quarter, owner, epics, children, index, loadedAt: t, fullAt: t });
  }

  // The issues of `next` that are new or whose `updated` moved since `prev`.
  const diff = (prev, next) => [...next.index.values()].filter((i) => !prev.index.has(i.key) || prev.index.get(i.key).updated !== i.updated);

  // ---- sprint and version modes
  /**
   * What the members make visible, from `index` (every issue that may matter): each member; an epic member's whole tree;
   * a task member's sub-tasks; and the ancestors of all of those. Children slot under their parent when it is kept,
   * else under NOEPIC.
   */
  function assemble(index, members) {
    const kidsOf = new Map();
    for (const i of index.values()) if (i.parentKey) { if (!kidsOf.has(i.parentKey)) kidsOf.set(i.parentKey, []); kidsOf.get(i.parentKey).push(i); }
    const keep = new Set();
    for (const k of members) {
      const m = index.get(k);
      if (!m) continue;
      keep.add(k);
      if (m.isSubtask) continue;
      for (const c of kidsOf.get(k) || []) {
        keep.add(c.key);
        if (m.isEpic && !c.isSubtask) for (const g of kidsOf.get(c.key) || []) keep.add(g.key);
      }
    }
    for (const k of [...keep]) {
      for (let i = index.get(k), n = 0; i && !i.isEpic && i.parentKey && index.has(i.parentKey) && n < 3; n++) { keep.add(i.parentKey); i = index.get(i.parentKey); }
    }
    const epics = []; const children = new Map(); const kept = new Map();
    for (const k of keep) {
      const i = index.get(k); kept.set(k, i);
      if (i.isEpic) { epics.push(i); continue; }
      const slot = i.parentKey && keep.has(i.parentKey) ? i.parentKey : NOEPIC;
      if (!children.has(slot)) children.set(slot, []);
      children.get(slot).push(i);
    }
    return { epics, children, index: kept };
  }

  /**
   * Fetches what `expand` brings (an epic its whole tree, a task its sub-tasks), then the missing parents (task, then epic)
   * of what was fetched or changed (`touched`) and is shown, and assembles the view.
   */
  async function grow(index, members, expand, touched) {
    const add = (i) => { index.set(i.key, i); touched.add(i.key); };
    const xs = expand.map((k) => index.get(k)).filter(Boolean);
    const tasks = new Set(xs.filter((i) => !i.isEpic && !i.isSubtask).map((i) => i.key));
    for (const c of await childrenOf(xs.filter((i) => i.isEpic).map((i) => i.key))) { add(c); if (!c.isSubtask) tasks.add(c.key); }
    for (const c of await childrenOf([...tasks])) add(c);
    let v = assemble(index, members);
    for (let round = 0; round < 2; round++) {
      const missing = [...new Set([...touched].map((k) => v.index.get(k)).filter((i) => i && !i.isEpic && i.parentKey && !index.has(i.parentKey)).map((i) => i.parentKey))];
      if (!missing.length) break;
      const parents = await inChunks(missing, (ks) => `key in (${ks})`);
      parents.forEach(add);
      v = assemble(index, members);
      if (!parents.length) break;
    }
    return v;
  }

  async function loadMembers(project, period, owner) {
    const found = await search(`project = ${q(project)} AND ${periodJql(period)}`);
    const members = found.map((i) => i.key);
    const index = new Map(found.map((i) => [i.key, i]));
    const v = await grow(index, new Set(members), members, new Set(members));
    const t = now();
    return save({ key: viewKeyOf(project, period), project, period: { kind: period.kind, id: period.id }, owner, members, ...v, loadedAt: t, fullAt: t });
  }

  async function refreshMembers(view) {
    const t = now();
    if (t - view.fullAt > FULL_EVERY_MS) {
      const next = await loadMembers(view.project, view.period, view.owner);
      return { view: next, changed: diff(view, next) };
    }
    const minutes = Math.ceil((t - view.loadedAt) / 60000) + 2;
    const found = await search(`project = ${q(view.project)} AND updated >= ${q(`-${minutes}m`)}`);
    const index = new Map(view.index); const members = new Set(view.members); const joined = [];
    if (found.length) {
      // which of the changed tickets are in the period now: a cheap second search
      const cheap = (jql) => api.search(jql, { fields: 'summary' });
      const inside = new Set((await inChunks(found.map((i) => i.key), (ks) => `key in (${ks}) AND ${periodJql(view.period)}`, cheap)).map((i) => i.key));
      for (const i of found) {
        index.set(i.key, i);
        if (!inside.has(i.key)) members.delete(i.key);
        else if (!members.has(i.key)) { members.add(i.key); joined.push(i.key); }
      }
    }
    // what joined brings its descendants; so does a task new to the view under a member epic
    const shown = assemble(index, members).index;
    const under = [...shown.values()].filter((i) => !view.index.has(i.key) && !i.isEpic && !i.isSubtask && !members.has(i.key)
      && members.has(i.parentKey) && index.get(i.parentKey).isEpic).map((i) => i.key);
    const v = await grow(index, members, [...joined, ...under], new Set(found.map((i) => i.key)));
    const next = save({ ...view, members: [...members], ...v, loadedAt: t });
    return { view: next, changed: diff(view, next) };
  }

  async function refresh(view, { patterns } = {}) {
    if (view.period) return refreshMembers(view);
    const t = now();
    if (t - view.fullAt > FULL_EVERY_MS) {
      const next = await load({ project: view.project, quarter: view.quarter, patterns, owner: view.owner });
      return { view: next, changed: diff(view, next) };
    }
    const minutes = Math.ceil((t - view.loadedAt) / 60000) + 2;
    const found = await search(`project = ${q(view.project)} AND updated >= ${q(`-${minutes}m`)}`);
    const epics = view.epics.slice(); const index = new Map(view.index);
    const children = new Map([...view.children].map(([k, v]) => [k, v.slice()]));
    const changed = []; const added = [];
    const detach = (key) => { const old = index.get(key); const sibs = old && children.get(old.parentKey); if (sibs) children.set(old.parentKey, sibs.filter((s) => s.key !== key)); };
    // Drops an issue and everything below it from the view.
    const remove = (key) => {
      detach(key);
      const at = epics.findIndex((e) => e.key === key); if (at >= 0) epics.splice(at, 1);
      const kids = children.get(key) || []; children.delete(key); index.delete(key);
      for (const k of kids) remove(k.key);
    };
    const place = (issue) => {
      const old = index.get(issue.key);
      if (!old) { changed.push(issue); added.push(issue); } else if (old.updated !== issue.updated) changed.push(issue);
      if (issue.isEpic) {
        const at = epics.findIndex((e) => e.key === issue.key);
        if (at >= 0) epics[at] = issue; else epics.push(issue);
      } else {
        const sibs = children.get(issue.parentKey) || [];
        const at = old && old.parentKey === issue.parentKey ? sibs.findIndex((s) => s.key === issue.key) : -1;
        if (old && at < 0) detach(issue.key);
        if (at >= 0) sibs[at] = issue; else sibs.push(issue);
        children.set(issue.parentKey, sibs);
      }
      index.set(issue.key, issue);
    };
    const wanted = (e) => (view.quarter === 'any' ? !(e.status && e.status.category === 'done') : index.has(e.key) || quarterMatches(e, view.quarter, patterns));
    // Parents can arrive after their children in one batch, so retry what has no known parent until a pass adds nothing.
    let pending = found;
    for (let progress = true; progress && pending.length;) {
      const rest = [];
      for (const i of pending) {
        if (i.isEpic) { if (wanted(i)) place(i); else if (index.has(i.key)) remove(i.key); }
        else if (index.has(i.parentKey)) place(i);
        else rest.push(i);
      }
      progress = rest.length < pending.length; pending = rest;
    }
    for (const i of pending) if (index.has(i.key)) remove(i.key); // re-parented out of the view
    // What entered the view brings its descendants, which the updated-window search does not return.
    for (let level = added.filter((i) => !i.isSubtask && index.has(i.key)).map((i) => i.key); level.length;) {
      const next = [];
      for (const c of await childrenOf(level)) {
        if (index.has(c.key) || !index.has(c.parentKey)) continue;
        place(c); if (!c.isSubtask) next.push(c.key);
      }
      level = next;
    }
    return { view: save({ ...view, epics, children, index, loadedAt: t }), changed };
  }

  return { cached, load, refresh };
}

module.exports = { createLoader, viewKeyOf };
