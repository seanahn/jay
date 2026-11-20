'use strict';
// Confluence @mentions of Sean (design 102, "Mentions"). CQL returns the content that mentions him now, not mention events:
// a mention is new when an id appears that wasn't there before. The first search ever is the baseline. Later edits to
// known ids never light. Content he wrote or last edited is skipped. The state is seen.json's confluence section
// (events.conf()), merged across windows; what each hit is (title, page, who) is kept in memory from the last search.

/**
 * @param events  { conf(), now() } (events.js): the shared state, changed in place; the caller saves
 * @param meId    Sean's accountId, or a function returning it
 */
function createMentions({ events, meId, now }) {
  if (!now) now = events.now || Date.now;   // the events' clock by default, so seen and lit compare on one clock
  const me = () => (typeof meId === 'function' ? meId() : meId);
  let hits = new Map();   // id -> Hit, from the last observe
  const isLit = (c, id) => c.lit[id] != null && c.lit[id] > (c.seen[id] == null ? -Infinity : c.seen[id]);

  function observe(list) {
    const c = events.conf();
    const t = now();
    const first = c.baseline == null;
    if (first) c.baseline = t;
    hits = new Map();
    for (const h of list || []) {
      if (!h || h.id == null) continue;
      const id = String(h.id);
      hits.set(id, h);
      if (c.known[id] != null) continue;
      c.known[id] = t;
      if (!first && !(h.by && h.by.accountId === me())) c.lit[id] = t;
    }
  }

  /** Lit mentions among the last search's hits, newest first. */
  function list() {
    const c = events.conf();
    const out = [];
    for (const [id, h] of hits) {
      if (!isLit(c, id)) continue;
      out.push({ id, pageId: h.pageId == null ? null : String(h.pageId), title: h.title || '', byName: h.by ? h.by.displayName || null : null,
        at: h.lastModified || null, lit: true, _t: c.lit[id] });
    }
    const time = (m) => { const v = Date.parse(m.at); return Number.isFinite(v) ? v : m._t; };
    out.sort((a, b) => time(b) - time(a) || b._t - a._t);
    return out.map(({ _t, ...m }) => m);
  }

  function seen(id) { const c = events.conf(); c.seen[String(id)] = now(); }
  /** A page Sean is looking at has no unseen mentions left: the page's own and its comments'. */
  function seenPage(pageId) {
    const c = events.conf(); const t = now();
    for (const [id, h] of hits) if (String(h.pageId) === String(pageId) && isLit(c, id)) c.seen[id] = t;
  }

  return {
    observe, list, seen, seenPage,
    badge: () => list().length,
    /** The hit for an id from the last search, or null. */
    hit: (id) => hits.get(String(id)) || null,
  };
}

module.exports = { createMentions };
