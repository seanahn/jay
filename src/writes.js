'use strict';
// The safety layer for every write to Jira: one pending write per ticket, a pre-save conflict check,
// read-back after a timeout, and never a second send of the same write.
const { sameAdf } = require('./adf');

const OWN_COMMENT_WINDOW_MS = 5 * 60 * 1000;
const fail = (kind, message, extra) => ({ ok: false, kind, message, ...extra });
const sameLabels = (a, b) => Array.isArray(a) && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
const KNOWN = new Set(['JiraError', 'Offline', 'SignInNeeded', 'ConfluenceUnavailable']);

// Maps a thrown error to a Result. `phase` is 'read' (pre-save, nothing sent) or 'write'.
function mapError(e, phase, product = 'Jira') {
  const name = e && e.name;
  if (name === 'ConfluenceUnavailable') return fail('failed', "Confluence isn't available with this sign-in");
  // a refused sign-in is failed, with Retry (design 101: refresh once, then failed); the write is never resent by itself
  if (name === 'SignInNeeded') return fail('failed', 'Sign in again, then Retry');
  if (name === 'Offline') return fail('failed', phase === 'read' ? 'Offline — not sent' : 'Offline');
  if (name === 'Timeout') return fail('failed', phase === 'read' ? 'Timed out — not sent' : 'Timed out; not confirmed');
  if (name === 'JiraError') {
    const s = e.status;
    if (s === 429) {
      const ms = e.retryAfterMs;
      const msg = ms == null ? `${product} is busy; try again shortly` : `${product} is busy; try again in ${Math.ceil(ms / 1000)} s`;
      return fail('failed', msg, { retryAfterMs: ms == null ? null : ms });
    }
    if (s === 401) return fail('failed', `${product} refused the sign-in (401); not saved`);
    if (s >= 500) return fail('failed', `${product} had a problem (${s})`);
    const joined = (e.messages || []).join('; ');
    return fail('rejected', joined || `${product} rejected the change (${s})`);
  }
  return fail('failed', (e && e.message) || 'Failed');
}

// The shared guard: exclusive per key (flag set before any await) and a guarded send that never resends.
// `noun` is only for the busy message; `map(e)` may turn a known error into a Result before mapError.
function makeGuard({ product = 'Jira', noun = 'ticket' } = {}) {
  const busy = new Set();

  // Runs fn as the only write to key. The flag is set before any await and cleared in finally.
  async function exclusive(key, fn) {
    if (busy.has(key)) return fail('busy', `Another change to this ${noun} is still being saved`);
    busy.add(key);
    try { return await fn(); } finally { busy.delete(key); }
  }

  // `pre` does the pre-save read and returns a failure Result or null; `send` does the one write;
  // `verify` re-reads after a timeout and returns an ok Result or null; `done` builds the ok Result.
  async function guarded({ pre, send, verify, done, map }) {
    // A Timeout, or any unexpected error after sending (such as an unreadable 2xx body), may mean the write landed:
    // re-read rather than report failure, so the caller never resends a write that is already there.
    if (pre) {
      let stop;
      try { stop = await pre(); } catch (e) { return mapError(e, 'read', product); }
      if (stop) return stop;
    }
    let sent;
    try { sent = await send(); } catch (e) {
      if (verify && !(e && KNOWN.has(e.name))) {
        try { const v = await verify(); if (v) return v; } catch (_) { /* read-back failed: fall through */ }
      }
      return (map && map(e)) || mapError(e, 'write', product);
    }
    return done(sent);
  }

  return { busy, exclusive, guarded };
}

function createWriter({ api, meId, now = Date.now }) {
  const { busy, exclusive, guarded } = makeGuard();

  const readBack = async (fn) => { try { return await fn(); } catch (_) { return null; } };
  const conflict = () => fail('conflict', 'Changed in Jira since you opened it');

  return {
    pending: (key) => busy.has(key),

    saveText(key, field, value, loaded) {
      const same = field === 'summary' ? (a, b) => a === b : sameAdf;
      return exclusive(key, () => guarded({
        pre: async () => (same(await api.field(key, field), loaded) ? null : conflict()),
        send: () => api.setFields(key, { [field]: value }),
        verify: async () => { const cur = await api.field(key, field); return same(cur, value) ? { ok: true, value: cur } : null; },
        done: async () => ({ ok: true, value: await readBack(() => api.field(key, field)) }),
      }));
    },

    addComment(key, adf) {
      return exclusive(key, async () => {
        let before = new Set();
        try { before = new Set((await api.comments(key)).comments.map((c) => c.id)); } catch (_) { /* proceed with no snapshot */ }
        return guarded({
        send: () => api.addComment(key, adf),
        verify: async () => {
          const { comments } = await api.comments(key);
          const t = now();
          const hit = comments.find((c) => {
            const age = t - Date.parse(c.created);
            return !before.has(c.id) && c.author && c.author.accountId === meId && Math.abs(age) <= OWN_COMMENT_WINDOW_MS && sameAdf(c.body, adf);
          });
          return hit ? { ok: true, value: hit } : null;
        },
        done: (c) => ({ ok: true, value: c }),
        });
      });
    },

    editComment(key, id, adf, loadedBody) {
      return exclusive(key, () => guarded({
        pre: async () => {
          const c = await api.comment(key, id);
          if (!c.author || c.author.accountId !== meId) return fail('rejected', 'You can only edit your own comments');
          return sameAdf(c.body, loadedBody) ? null : conflict();
        },
        send: () => api.editComment(key, id, adf),
        verify: async () => { const c = await api.comment(key, id); return sameAdf(c.body, adf) ? { ok: true, value: c } : null; },
        done: (c) => ({ ok: true, value: c }),
      }));
    },

    setField(key, field, value) {
      let jira, same;
      if (field === 'assignee') { jira = value == null ? null : { accountId: value }; same = (cur) => (cur ? cur.accountId : null) === (value == null ? null : value); }
      else if (field === 'priority') { jira = { id: value }; same = (cur) => !!cur && cur.id === value; }
      else if (field === 'duedate') { jira = value == null ? null : value; same = (cur) => (cur == null ? null : cur) === jira; }
      else if (field === 'labels') { jira = value; same = (cur) => sameLabels(cur, value); }
      else return Promise.resolve(fail('rejected', `Unknown field ${field}`));
      return exclusive(key, () => guarded({
        send: () => api.setFields(key, { [field]: jira }),
        verify: async () => { const cur = await api.field(key, field); return same(cur) ? { ok: true, value: cur } : null; },
        done: async () => ({ ok: true, value: await readBack(() => api.field(key, field)) }),
      }));
    },

    transition(key, transitionId) {
      return exclusive(key, () => guarded({
        send: () => api.transition(key, transitionId),
        done: () => ({ ok: true, value: null }),
      }));
    },
  };
}

module.exports = { createWriter, makeGuard, mapError, fail, OWN_COMMENT_WINDOW_MS };
