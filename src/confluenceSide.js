'use strict';
// The Confluence side of jay's host (design 102): its sign-in check, the page tabs, the page tree, Mentions, My pages, its
// pollers and the sidebar's Confluence messages. extension.js builds one and wires it in; this file holds what is Confluence's
// so the Jira host stays as it was. Confluence never signs Jira out: a refusal only shows a note and stops these pollers.
const path = require('path');
const { SignInNeeded } = require('./auth');
const { createHttp } = require('./http');
const { createConfluence } = require('./confluence');
const { createPageWriter } = require('./pageWrites');
const { createPageMirror } = require('./pageMirror');
const { createPages } = require('./page');
const { createPageTree } = require('./pageTree');
const { createMentions } = require('./mentions');
const { parsePageUrl } = require('./pageLinks');
const { createPoller } = require('./poller');

const PROBE_MS = 300000;   // a probe that failed for another reason than a refusal tries again
const TAB_MS = 30000;
const MENTIONS_MS = 300000;
const MINE_MS = 900000;
const MENTIONS_MAX = 50;
const MINE_PAGE = 25;
const MINE_MAX = 100;
const SEARCH_MAX = 20;
const SPACE_PAGES = 20;   // at most 20 × 250 spaces in the space box
const NOT_YET = "This sign-in can't use Confluence yet";
const UNAVAILABLE = "Confluence isn't available with this sign-in";
const OFFLINE = 'Offline, retrying';
const THROTTLED = 'Confluence is throttling, retrying';
const SEARCH_FAILED = 'Confluence search failed';
const MENTIONS_CQL = 'mention = currentUser() order by lastmodified desc';
const MINE_CQL = 'creator = currentUser() and type = page order by created desc';
const SIDES = new Set(['jira', 'confluence']);
const SECTIONS = new Set(['mine', 'tree']);
const ID_RE = /^\d+$/;
const WRITES = ['savePage', 'addComment', 'reply', 'editComment'];
const NOT_SIGNED_IN = { ok: false, kind: 'failed', message: 'Not signed in' };
// Thrown by the proxies while Confluence isn't ready (not signed in, still probing, refused): tabs wait; never a Jira sign-out.
const WAIT = 'confluenceWait';
const cqlString = (v) => v.replace(/[\\"]/g, '\\$&');
const isUnavailable = (e) => !!e && e.name === 'ConfluenceUnavailable';

/**
 * @param o.s, o.me          extension.js's state and its `me` object
 * @param o.needSignIn(reason), o.signedOutElsewhere(), o.ensureSession()   extension.js's
 * @param o.searchUsers(q)   the Jira api's users(q), for @-mentions in page comments
 */
function createConfluenceSide(o) {
  const { vscode, s, me, store, cfg, sidebar, now, log } = o;
  const enabled = () => cfg('confluence.enabled', true) !== false;
  const siteUrl = () => { try { return s.auth ? s.auth.siteUrl() : ''; } catch (_) { return ''; } };
  const ready = () => !!(s.conf && s.conf.api && s.conf.available === true);
  const saveEvents = () => { if (s.events && s.conf) s.events.save(); };

  // The long-lived modules reach the current sign-in through these, as the ticket tabs do through apiRef and writerRef.
  const confRef = new Proxy({}, { get: (_, k) => (...a) => { if (!ready()) throw new SignInNeeded(WAIT); return s.conf.api[k](...a); } });
  const writerRef = { pending: (id) => !!(s.conf && s.conf.writer && s.conf.writer.pending(id)) };
  for (const k of WRITES) writerRef[k] = (...a) => (s.conf && s.conf.writer ? s.conf.writer[k](...a) : Promise.resolve(NOT_SIGNED_IN));
  const pageLog = (e) => { if (!(e instanceof SignInNeeded && e.reason === WAIT)) log(e); };

  const pageMirror = createPageMirror({ dir: o.jayDir, enabled: () => cfg('agentFiles', true) !== false });
  const pageTree = createPageTree({ confluence: confRef, cacheDir: path.join(o.jayDir, 'cache'), now });
  const pages = createPages({ vscode, extensionUri: o.extensionUri, confluence: confRef, writer: writerRef, mirror: pageMirror, me, log: pageLog,
    isFocused: o.isFocused, siteUrl, searchUsers: (q) => o.searchUsers(q),
    access: () => (s.conf && s.conf.available !== false ? s.conf.access : 'none'),
    onShown: (pageId) => { if (s.conf && s.events) { s.conf.mentions.seenPage(pageId); saveEvents(); o.render(); } } });
  const newMentions = () => createMentions({ events: { conf: () => s.events.conf(), now }, meId: () => me.accountId });

  // ---- stored choices
  const side = () => (enabled() && store.get('jay.side') === 'confluence' ? 'confluence' : 'jira');
  const recentSpaces = () => { const r = store.get('jay.recentSpaces'); return Array.isArray(r) ? r.filter((k) => typeof k === 'string').slice(0, 5) : []; };
  const open = () => { const v = store.get('jay.confluence.open'); return { mine: !!(v && v.mine), tree: !(v && v.tree === false) }; };
  const title = () => sidebar.setTitle(side() === 'jira' ? 'Jira' : 'Confluence');

  // ---- availability and the pollers
  let notes = {};   // per poller: { offline, throttle }
  // gen moves on at every stop() (needSignIn, sign-out, a refusal, a rebuild): an async step from before it must not start
  // pollers, request or write anything once it resumes
  let gen = 0;
  const live = (c, g) => g === gen && s.running && s.conf === c;
  const setNote = (poll, kind, text) => { const n = notes[poll] || (notes[poll] = {}); if (n[kind] === text) return; n[kind] = text; o.render(); };
  const pollNote = () => { for (const n of Object.values(notes)) if (n.offline || n.throttle) return n.offline || n.throttle; return null; };

  /** Throttling and offline back off in the poller; a refusal stops the Confluence pollers; SignInNeeded is a real sign-in problem. */
  const guard = (name, fn) => async () => {
    if (o.signedOutElsewhere()) return;
    const c = s.conf;
    if (!c || !c.api) return;
    const g = gen;
    try {
      await fn(c, g);
      setNote(name, 'offline', null);
    } catch (e) {
      if (e instanceof SignInNeeded) { if (e.reason !== WAIT) o.needSignIn(e.reason); return; }
      if (isUnavailable(e)) { unavailable(c); return; }
      if (e && e.name === 'Offline') setNote(name, 'offline', OFFLINE);
      throw e;
    }
  };
  const addPoller = (name, fn, everyMs) => createPoller({ run: guard(name, fn), everyMs, isFocused: o.isFocused, timers: o.timers,
    onThrottle: (text) => setNote(name, 'throttle', text ? THROTTLED : null), onError: log });

  const probePoller = addPoller('confProbe', async (c, g) => {
    // 403: refused; 404: a site with no Confluence. Both are "not available", and stop the Confluence pollers.
    try { await c.api.probe(); } catch (e) { if (e && (e.status === 403 || e.status === 404)) { unavailable(c); return; } throw e; }
    if (!live(c, g)) return;
    c.available = true;
    probePoller.stop();
    tabPoller.start(); mentionsPoller.start();
    if (open().mine) minePoller.start();
    loadSpaces(c); loadTree(c);
    pages.resumeWaiting();
    o.render();
  }, PROBE_MS);
  const tabPoller = addPoller('confTab', async (c, g) => {
    await o.ensureSession();
    if (live(c, g) && c.available === true) await pages.refreshVisible();
  }, TAB_MS);
  const mentionsPoller = addPoller('confMentions', async (c, g) => {
    await o.ensureSession();
    if (!live(c, g)) return;
    const r = await c.api.search(MENTIONS_CQL, { limit: MENTIONS_MAX });
    if (!live(c, g) || !s.events) return;
    c.mentions.observe(r.items);
    s.events.save();
    o.render();
  }, MENTIONS_MS);
  const minePoller = addPoller('confMine', async (c, g) => {
    await o.ensureSession();
    if (!live(c, g)) return;
    if (!c.mine) { c.loading.mine = true; o.render(); }
    try {
      const r = await c.api.search(MINE_CQL, { limit: Math.min(MINE_MAX, Math.max(MINE_PAGE, c.mine ? c.mine.items.length : 0)) });
      if (live(c, g)) c.mine = { items: r.items, total: r.total };
    } finally { if (live(c, g)) { c.loading.mine = false; o.render(); } }
  }, MINE_MS);
  const polls = [probePoller, tabPoller, mentionsPoller, minePoller];

  function stop() { gen++; for (const p of polls) p.stop(); }
  function unavailable(c) {
    if (s.conf !== c) return;
    c.available = false; c.note = UNAVAILABLE;
    stop();
    pages.unavailable(UNAVAILABLE);
    o.render();
  }
  /** An error outside a poll (a space or tree load, a sidebar action): sorted the same way, else logged. */
  function handle(c, e) {
    if (e instanceof SignInNeeded) { if (e.reason !== WAIT) o.needSignIn(e.reason); return; }
    if (isUnavailable(e)) { unavailable(c); return; }
    log(e);
  }

  /** This sign-in's Confluence: built in restart() right after the Jira api; nothing is requested until start(). */
  function build(auth) {
    stop(); notes = {};
    s.conf = null;
    if (!enabled()) return;
    let access = 'none';
    try { access = auth.confluenceAccess(); } catch (e) { log(e); }
    const c = { api: null, access, available: null, note: null, writer: null, tree: null, mentions: newMentions(), mine: null, spaces: [], space: null,
      loading: { spaces: false, tree: false, mine: false }, treeSeq: 0, busy: new Set() };
    s.conf = c;
    if (access === 'none') { c.available = false; c.note = NOT_YET; return; }
    c.api = createConfluence(createHttp({ auth, fetch: o.fetch, base: () => auth.wikiBaseUrl(), product: 'Confluence', unavailableOn401: true }), auth);
  }
  /** Starts the probe; the other pollers start once it says Confluence is there. */
  function start() { if (s.conf && s.conf.api && s.conf.available === null) probePoller.start(); }

  // ---- spaces and the tree
  async function loadSpaces(c) {
    const g = gen;
    c.loading.spaces = true; o.render();
    try {
      const all = []; let cursor;
      for (let i = 0; i < SPACE_PAGES; i++) {
        const r = await c.api.spaces({ cursor });
        if (!live(c, g)) return;
        all.push(...r.items); cursor = r.next;
        if (!cursor) break;
      }
      c.spaces = all;
    } catch (e) { if (live(c, g)) handle(c, e); } finally { if (live(c, g)) { c.loading.spaces = false; o.render(); } }
  }

  /** The chosen space's tree: the cached one at once (this account's only), then its top level from Confluence. */
  async function loadTree(c) {
    const key = store.get('jay.space');
    if (!key || c.available !== true) return;
    const seq = ++c.treeSeq; const g = gen;
    const current = () => live(c, g) && seq === c.treeSeq;
    c.loading.tree = true; o.render();
    try {
      await o.ensureSession();
      const sp = c.spaces.find((x) => x.key === key) || await c.api.spaceByKey(key);
      if (!current()) return;
      if (!sp) { c.space = null; c.tree = null; return; }
      c.space = sp;
      if (!c.tree || c.tree.spaceId !== sp.id) { c.tree = pageTree.cached(sp.id, s.trusted); o.render(); }
      const owner = s.trusted;
      const tree = await pageTree.load(sp.id, owner, c.tree);
      if (!current()) return;
      // the home page's children are the top level, as in Confluence's own sidebar (see homeOf)
      const home = homeOf(sp, tree);
      if (home && !home.childrenLoaded) { await pageTree.expand(tree, home.id); if (!current()) return; }
      c.tree = tree; pageTree.save(tree, owner); o.render();
      // then which of the shown pages are leaves (no twisty); the rows are already on screen meanwhile
      await pageTree.probe(tree, [...tree.roots, ...(home ? home.children : [])]);
      if (!current() || c.tree !== tree) return;
      pageTree.save(tree, owner);
    } catch (e) { if (live(c, g)) handle(c, e); } finally { if (current()) { c.loading.tree = false; o.render(); } }
  }

  /** The space's home page when it is on the tree's top level: shown as "Overview", its children shown as the top level. */
  function homeOf(space, tree) {
    const id = space && space.homepageId ? String(space.homepageId) : null;
    return id && tree && tree.roots.includes(id) ? tree.items.get(id) || null : null;
  }

  /** expand or more on the tree on screen, one at a time per item; saved and shown when it is still that tree. */
  async function treeStep(c, op, id) {
    const tree = c.tree; const g = gen;
    // "more" at the top level reads the home page's next children first, then the space's next top-level pages
    if (op === 'more' && (id === null || id === undefined)) { const home = homeOf(c.space, tree); if (home && home.next) id = home.id; }
    const k = op + ':' + id;
    if (!tree || c.busy.has(k)) return;
    c.busy.add(k);
    try {
      await pageTree[op](tree, id);
      if (!(live(c, g) && c.tree === tree)) return;
      pageTree.save(tree, s.trusted); o.render();
      // then which of the new rows are leaves
      const parent = id === null || id === undefined ? null : tree.items.get(String(id));
      await pageTree.probe(tree, parent ? parent.children : tree.roots);
      if (live(c, g) && c.tree === tree) { pageTree.save(tree, s.trusted); o.render(); }
    } catch (e) { if (live(c, g)) handle(c, e); } finally { c.busy.delete(k); }
  }

  // ---- the sidebar
  async function openHit(c, url, id) {
    if (typeof url === 'string') {
      const hit = parsePageUrl(url, siteUrl());
      if (hit) await pages.open(hit.pageId, { commentId: hit.commentId });
      return;
    }
    const item = c.tree && c.tree.items.get(String(id));
    // whiteboards, databases and other non-page content open in the browser
    if (item && item.kind !== 'page' && c.space) {
      await vscode.env.openExternal(vscode.Uri.parse(`${siteUrl()}/wiki/spaces/${encodeURIComponent(c.space.key)}/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.id)}`));
      return;
    }
    if (ID_RE.test(String(id))) await pages.open(String(id));
  }

  async function openMention(c, id) {
    const g = gen;
    const h = c.mentions.hit(id);
    if (!h) return;
    if (h.type === 'blogpost' && h.webUrl) await vscode.env.openExternal(vscode.Uri.parse(h.webUrl));
    else if (h.pageId && ID_RE.test(String(h.pageId))) await pages.open(String(h.pageId), h.type === 'comment' ? { commentId: String(h.id) } : {});
    if (!live(c, g) || !s.events) return;
    c.mentions.seen(id); s.events.save(); o.render();
  }

  async function search(c, m) {
    if (typeof m.query !== 'string' || m.query.length < 3 || m.query.length > 200 || typeof m.id !== 'number') return;
    const { id, query } = m;
    const fail = () => sidebar.reply({ type: 'confSearchResults', id, query, error: SEARCH_FAILED });
    if (!c || c.available !== true || !s.running) { fail(); return; }
    try {
      const r = await c.api.search(`siteSearch ~ "${cqlString(query)}" and type = page`, { limit: SEARCH_MAX });
      sidebar.reply({ type: 'confSearchResults', id, query, items: r.items.slice(0, SEARCH_MAX).map((h) => ({ id: h.id, title: h.title, spaceKey: h.spaceKey })) });
    } catch (e) { fail(); }
  }

  async function moreMine(c) {
    if (!c.mine || c.mine.items.length >= c.mine.total || c.busy.has('mine')) return;
    const g = gen;
    c.busy.add('mine');
    try {
      const r = await c.api.search(MINE_CQL, { limit: MINE_PAGE, start: c.mine.items.length });
      if (!live(c, g) || !c.mine) return;
      const have = new Set(c.mine.items.map((x) => x.id));
      c.mine = { items: [...c.mine.items, ...r.items.filter((x) => !have.has(x.id))], total: r.total };
      o.render();
    } catch (e) { if (live(c, g)) handle(c, e); } finally { c.busy.delete('mine'); }
  }

  /** A sidebar message; true when it was one of Confluence's. */
  function message(m) {
    const c = s.conf;
    const on = !!(c && c.available === true && s.running);
    switch (m.type) {
      case 'setSide':
        if (SIDES.has(m.side) && (m.side === 'jira' || enabled())) { store.update('jay.side', m.side); title(); o.render(); }
        return true;
      case 'setSpace':
        if (on && typeof m.key === 'string' && (c.spaces.some((x) => x.key === m.key) || (!c.spaces.length && m.key === store.get('jay.space')))) {
          store.update('jay.space', m.key);
          store.update('jay.recentSpaces', [m.key, ...recentSpaces().filter((k) => k !== m.key)].slice(0, 5));
          if (!c.space || c.space.key !== m.key) { c.space = null; c.tree = null; }
          loadTree(c);
          o.render();
        }
        return true;
      case 'expandPage': if (on && typeof m.id === 'string') treeStep(c, 'expand', m.id); return true;
      case 'morePages': if (on && (m.id === null || typeof m.id === 'string')) treeStep(c, 'more', m.id); return true;
      case 'openPage': if (on && s.running && (typeof m.url === 'string' || typeof m.id === 'string')) openHit(c, m.url, m.id).catch(log); return true;
      case 'openMention': if (on && typeof m.id === 'string') openMention(c, m.id).catch(log); return true;
      case 'confSearch': search(c, m); return true;
      case 'toggleSection':
        if (SECTIONS.has(m.name)) {
          const next = { ...open(), [m.name]: !open()[m.name] };
          store.update('jay.confluence.open', next);
          if (m.name === 'mine') { if (next.mine && on) minePoller.start(); else minePoller.stop(); }
          o.render();
        }
        return true;
      case 'moreMine': if (on) moreMine(c); return true;
      default: return false;
    }
  }

  /** The sidebar state's Confluence part: only what the page shows. */
  function state(account) {
    const c = s.conf;
    const stored = store.get('jay.space') || null;
    const t = c && c.tree && (!c.space || c.tree.spaceId === c.space.id) ? c.tree : null;
    const items = {};
    if (t) for (const i of t.items.values()) items[i.id] = { id: i.id, kind: i.kind, title: i.title, parentId: i.parentId, children: i.children, childrenLoaded: i.childrenLoaded, hasMore: !!i.next };
    const home = t && c ? homeOf(c.space, t) : null;
    let roots = t ? t.roots : [];
    if (home && home.childrenLoaded) {
      items[home.id] = { ...items[home.id], title: 'Overview', children: [], childrenLoaded: true, hasMore: false };
      roots = [home.id, ...home.children, ...roots.filter((k) => k !== home.id)];
    }
    return {
      side: side(), confluenceEnabled: enabled(),
      conf: {
        account, note: c ? c.note || pollNote() : null,
        spaces: c ? c.spaces.map((x) => ({ key: x.key, name: x.name, type: x.type })) : [],
        space: c && c.space ? { key: c.space.key, name: c.space.name } : stored ? { key: stored, name: null } : null,
        recentSpaces: recentSpaces(),
        roots, rootsHasMore: !!(t && (t.rootsNext || (home && home.next))), items,
        mentions: c && s.events ? c.mentions.list() : [],
        mine: c && c.mine ? { items: c.mine.items.map((x) => ({ id: x.id, title: x.title, spaceKey: x.spaceKey })), hasMore: c.mine.items.length < c.mine.total } : { items: [], hasMore: false },
        open: open(),
        loading: c ? { ...c.loading } : { spaces: false, tree: false, mine: false },
      },
    };
  }

  /** myself() answered: the page writer, then the tabs that were waiting. */
  function onSession(who) {
    const c = s.conf;
    if (!c || !c.api) return;
    c.writer = createPageWriter({ confluence: c.api, meId: who.accountId, now });
    if (c.available === true) pages.resumeWaiting();
  }

  return {
    build, start, stop, state, message, title, pages, onSession, confluence: confRef,
    badge: () => (s.conf && s.events && s.me ? s.conf.mentions.badge() : 0),
    /** Another account than before: what is held in memory was theirs. */
    forget() {
      const c = s.conf;
      if (!c) return;
      Object.assign(c, { mentions: newMentions(), tree: null, mine: null });
      if (c.available === true) { loadTree(c); if (open().mine) minePoller.kick(); }
    },
    /** jay.refresh (reload: the spaces and tree too, and a refused sign-in is asked again), or the window regaining focus. */
    kick(reload) {
      const c = s.conf;
      if (!c || !c.api) return;
      if (c.available === true) {
        for (const p of [tabPoller, mentionsPoller, minePoller]) p.kick();
        if (reload) { loadSpaces(c); loadTree(c); }
      } else if (reload && c.available === false) { c.available = null; c.note = null; o.render(); probePoller.start(); } else probePoller.kick();
    },
    settings(e) {
      if (e.affectsConfiguration('jay.agentFiles') && cfg('agentFiles', true) === false) pageMirror.clearFiles();
      if (e.affectsConfiguration('jay.confluence')) {
        if (s.running && s.auth) { build(s.auth); if (s.writer && s.me) onSession(s.me); start(); } else { stop(); s.conf = null; }
        title(); o.render();
      }
    },
    /** This window's part of a sign-out: the page tabs, the page files and the cached trees. */
    signOut() {
      stop(); notes = {};
      pages.disposeAll();
      s.conf = null;
      pageMirror.clearAll(); pageTree.clearAll();
    },
    /** After a sign-out, a poll that was in flight may have written a page file. */
    wipe() { pageMirror.clearAll(); },
    async openPage(url) {
      const c = s.conf;
      if (!s.running || !c || c.available !== true || typeof url !== 'string') return false;
      const hit = parsePageUrl(url, siteUrl());
      if (!hit) return false;
      try { return await pages.open(hit.pageId, { commentId: hit.commentId }); } catch (e) { log(e); return true; }
    },
    siteUrl: () => (s.running && siteUrl() ? siteUrl() : null),
    activePageFile: () => (cfg('agentFiles', true) === false ? null : pages.frontFile()),
    dispose() { stop(); pages.dispose(); },
  };
}

module.exports = { createConfluenceSide, NOT_YET, UNAVAILABLE };
