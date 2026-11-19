'use strict';
// What catches Sean's eye: mentions, comments on his tickets and new epics, remembered in ~/.jay/seen.json (design 101).
const fs = require('fs'); const path = require('path');
const { mentionsOf } = require('./adf');

function createEvents({ file, now = Date.now }) {
  // Events are timestamps (mentionAt, commentAt, newEpics[key]); one shows while it is later than the ticket's seen time. That is
  // what lets several windows merge their states in save() without a cleared event coming back.
  const load = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        return { tickets: raw.tickets || {}, views: raw.views || {}, newEpics: raw.newEpics && !Array.isArray(raw.newEpics) ? raw.newEpics : {} };
      }
    } catch (_) { /* no file yet, or unreadable: start fresh */ }
    return { tickets: {}, views: {}, newEpics: {} };
  };
  let data = load();
  const seenAt = (key) => { const t = data.tickets[key]; return t && t.seen != null ? t.seen : -Infinity; };
  const lit = (at, key) => at != null && at > seenAt(key);

  const ticket = (key) => data.tickets[key] || null;

  function observe(issue, comments, { meId, mineKeys }) {
    merge();
    const key = issue.key;
    let t = ticket(key);
    const first = !t;
    if (first) t = data.tickets[key] = { baseline: now(), seen: null, mentionAt: null, commentAt: null, descMention: null };
    const cutoff = t.seen == null ? t.baseline : t.seen;
    for (const c of comments || []) {
      if (!c.author || c.author.accountId === meId) continue;
      if (!(Date.parse(c.created) > cutoff)) continue;
      if (mentionsOf(c.body).includes(meId)) t.mentionAt = Math.max(t.mentionAt || 0, Date.parse(c.created));
      else if (mineKeys && mineKeys.has(key)) t.commentAt = Math.max(t.commentAt || 0, Date.parse(c.created));
    }
    // Only the change from no mention to a mention counts: who edited the description is unknown. The first read is the
    // baseline and never lights; an issue read without its description (undefined) says nothing about it.
    if (issue.description === undefined) return;
    const has = mentionsOf(issue.description).includes(meId);
    const at = Number.isFinite(Date.parse(issue.updated)) ? Date.parse(issue.updated) : now();
    if (t.descMention === false && has) t.mentionAt = Math.max(t.mentionAt || 0, at);
    t.descMention = has; t.descAt = at;
  }

  function observeEpics(viewKey, epicKeys) {
    merge();
    const known = data.views[viewKey];
    if (known) for (const k of epicKeys) if (!known.includes(k) && data.newEpics[k] == null) data.newEpics[k] = now();
    data.views[viewKey] = [...new Set([...(known || []), ...epicKeys])];
  }

  function seen(key) {
    const t = ticket(key);
    if (t) { t.seen = now(); t.mentionAt = null; t.commentAt = null; } else data.tickets[key] = { baseline: now(), seen: now(), mentionAt: null, commentAt: null, descMention: null };
    delete data.newEpics[key];
  }

  function state(key) {
    const t = ticket(key);
    return { mention: !!t && lit(t.mentionAt, key), comment: !!t && lit(t.commentAt, key), newEpic: lit(data.newEpics[key], key) };
  }

  function rollup(node) {
    const s = state(node.key);
    let mention = s.mention; let bold = s.mention || s.comment || s.newEpic;
    for (const c of node.children || []) { const r = rollup(c); mention = mention || r.mention; bold = bold || r.bold; }
    return { mention, bold };
  }

  const badge = () => Object.keys(data.tickets).filter((k) => state(k).mention || state(k).comment).length;

  const maxOf = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
  /** Another window may have saved since we loaded: merge its file into ours, so neither's clears or sightings are lost. */
  function merge() {
    const disk = load();
    for (const [key, d] of Object.entries(disk.tickets)) {
      const t = data.tickets[key];
      if (!t) { data.tickets[key] = d; continue; }
      t.baseline = Math.min(t.baseline, d.baseline == null ? t.baseline : d.baseline);
      t.seen = maxOf(t.seen, d.seen); t.mentionAt = maxOf(t.mentionAt, d.mentionAt); t.commentAt = maxOf(t.commentAt, d.commentAt);
      // the more recent observation of the description wins; on a tie a mention wins
      if (d.descMention != null && (t.descMention == null || (d.descAt || 0) > (t.descAt || 0) || ((d.descAt || 0) === (t.descAt || 0) && d.descMention))) {
        t.descMention = d.descMention; t.descAt = d.descAt;
      }
    }
    for (const [view, keys] of Object.entries(disk.views)) data.views[view] = [...new Set([...(data.views[view] || []), ...keys])];
    for (const [k, at] of Object.entries(disk.newEpics)) data.newEpics[k] = maxOf(data.newEpics[k], at);
  }

  function save() {
    merge();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  return { observe, observeEpics, seen, state, rollup, badge, save };
}

module.exports = { createEvents };
