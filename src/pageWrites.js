'use strict';
// The safety layer for every Confluence page save and comment: one pending write per page, the page version
// as the conflict check, read-back after a timeout, and never a second send of the same write.
// Same rules as writes.js (101's Jira writer), which supplies the shared guard.
const { sameAdf } = require('./adf');
const { makeGuard, fail, OWN_COMMENT_WINDOW_MS } = require('./writes');

const conflict = () => fail('conflict', 'Changed in Confluence since you opened it');
const is409 = (e) => !!e && e.name === 'JiraError' && e.status === 409;

function createPageWriter({ confluence, meId, now = Date.now }) {
  const { busy, exclusive, guarded } = makeGuard({ product: 'Confluence', noun: 'page' });
  const run = (pageId, spec) => exclusive(pageId, () => guarded({ map: (e) => (is409(e) ? conflict() : null), ...spec }));
  const listFor = (kind, pageId) => (kind === 'inline' ? confluence.inlineComments(pageId) : confluence.footerComments(pageId));
  const idsOf = (list) => { const out = new Set(); const walk = (c) => { out.add(c.id); (c.replies || []).forEach(walk); }; list.forEach(walk); return out; };
  const mineRecent = (c, before, adf) => !before.has(c.id) && c.authorId === meId
    && Math.abs(now() - Date.parse(c.createdAt)) <= OWN_COMMENT_WINDOW_MS && sameAdf(c.adf, adf);
  const snapshot = async (pageId, kind) => { try { return idsOf(await listFor(kind, pageId)); } catch (_) { return new Set(); } };

  return {
    pending: (pageId) => busy.has(pageId),

    // No pre-read: the version number is the conflict check (a stale base gets a 409).
    savePage(pageId, { title, adf, baseVersion }) {
      const next = baseVersion + 1;
      return run(pageId, {
        send: () => confluence.updatePage(pageId, { title, adf, version: next }),
        verify: async () => {
          // Read version `next` by number, never "latest": someone else may have saved after us.
          const v = await confluence.pageVersion(pageId, next);
          if (!v || v.authorId !== meId) return null;
          const at = await confluence.pageAt(pageId, next);
          return at.title === title && sameAdf(at.adf, adf) ? { ok: true, value: { version: next } } : null;
        },
        done: (page) => ({ ok: true, value: { version: (page && page.version && page.version.number) || next } }),
      });
    },

    addComment(pageId, adf) {
      return exclusive(pageId, async () => {
        const before = await snapshot(pageId, 'footer');
        return guarded({
          send: () => confluence.addFooterComment(pageId, adf),
          verify: async () => {
            const hit = (await confluence.footerComments(pageId)).find((c) => mineRecent(c, before, adf));
            return hit ? { ok: true, value: hit } : null;
          },
          done: (c) => ({ ok: true, value: c }),
        });
      });
    },

    reply(pageId, parentId, kind, adf) {
      return exclusive(pageId, async () => {
        const before = await snapshot(pageId, kind);
        return guarded({
          send: () => confluence.reply(parentId, kind, adf),
          verify: async () => {
            const parent = (await listFor(kind, pageId)).find((c) => c.id === parentId);
            const hit = parent && (parent.replies || []).find((c) => mineRecent(c, before, adf));
            return hit ? { ok: true, value: hit } : null;
          },
          done: (c) => ({ ok: true, value: c }),
        });
      });
    },

    editComment(pageId, id, kind, adf, baseVersion, loadedAdf) {
      return run(pageId, {
        pre: async () => {
          const c = await confluence.comment(id, kind);
          if (c.authorId !== meId) return fail('rejected', 'You can only edit your own comments');
          return sameAdf(c.adf, loadedAdf) ? null : conflict();
        },
        send: () => confluence.editComment(id, kind, adf, baseVersion + 1),
        verify: async () => { const c = await confluence.comment(id, kind); return sameAdf(c.adf, adf) ? { ok: true, value: c } : null; },
        done: (c) => ({ ok: true, value: c }),
      });
    },
  };
}

module.exports = { createPageWriter };
