'use strict';
// Confluence Cloud, v2 API (search is v1). Paths start at /api/v2 or /rest/api: http's base already ends in /wiki.
const { JiraError } = require('./http');

const FORMAT = 'atlas_doc_format';
const person = (p) => (p ? { accountId: p.accountId, displayName: p.displayName } : null);
const cursorOf = (r) => {
  const next = r && r._links && r._links.next;
  if (!next) return null;
  try { return new URL(next, 'https://x.invalid').searchParams.get('cursor') || null; } catch { return null; }
};
const parseAdf = (b) => {
  const v = b && b[FORMAT] ? b[FORMAT].value : b && b.representation === FORMAT ? b.value : null;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
};
const bodyOf = (adf) => ({ representation: FORMAT, value: JSON.stringify(adf) });
const versionOf = (v) => ({ number: v.number, authorId: v.authorId || null, createdAt: v.createdAt || null });
const spaceOf = (s) => ({ id: s.id, key: s.key, name: s.name, type: s.type, homepageId: s.homepageId || null });
const kindOf = (k) => (k === 'inline' ? 'inline' : 'footer');
const TOP_COMMENTS = 50;

function createConfluence(http, auth) {
  const wiki = (rel) => (rel ? auth.siteUrl() + '/wiki' + rel : null);
  const pageOf = (r, extra = {}) => ({
    id: r.id, spaceId: r.spaceId, title: r.title, status: r.status, subtype: r.subtype || null,
    version: r.version ? versionOf(r.version) : null, authorId: r.authorId || null, createdAt: r.createdAt || null, parentId: r.parentId || null,
    adf: parseAdf(r.body), webUrl: wiki(r._links && r._links.webui), tinyUrl: wiki(r._links && r._links.tinyui),
    ancestors: [], editor: null, ...extra,
  });
  const itemOf = (kind) => (i) => ({ id: i.id, kind: kind || i.type, title: i.title, position: i.position !== undefined ? i.position : i.childPosition });
  const list = async (path, query, kind) => { const r = await http.get(path, query); return { items: (r.results || []).map(itemOf(kind)), next: cursorOf(r) }; };

  const commentOf = (kind) => (c) => {
    const out = { id: c.id, kind, authorId: c.version ? c.version.authorId || null : null, createdAt: c.version ? c.version.createdAt || null : null,
      version: c.version ? c.version.number : null, adf: parseAdf(c.body), replies: [] };
    if (kind === 'inline') { out.quote = (c.properties && c.properties['inline-original-selection']) || null; out.resolved = c.resolutionStatus === 'resolved'; }
    return out;
  };
  async function allPages(path, query) {
    const out = [];
    for (let cursor; ;) {
      const r = await http.get(path, { ...query, limit: 100, cursor });
      out.push(...(r.results || []));
      cursor = cursorOf(r);
      if (!cursor) return out;
    }
  }
  async function comments(pageId, kind) {
    const q = { 'body-format': FORMAT };
    const raw = await allPages(`/api/v2/pages/${pageId}/${kind}-comments`, q);
    const top = raw.map(commentOf(kind)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-TOP_COMMENTS);
    for (const c of top) c.replies = (await allPages(`/api/v2/${kind}-comments/${c.id}/children`, q)).map(commentOf(kind));
    top.total = raw.length;   // how many top-level comments the page has, for "newest 50 of M"
    return top;
  }

  const spaces = new Map(); const people = new Map();
  return {
    async spaces({ cursor } = {}) {
      const r = await http.get('/api/v2/spaces', { limit: 250, sort: 'name', cursor });
      return { items: (r.results || []).map(spaceOf), next: cursorOf(r) };
    },
    async spaceByKey(key) { const r = await http.get('/api/v2/spaces', { keys: key }); return r.results && r.results[0] ? spaceOf(r.results[0]) : null; },
    async space(id) {
      if (!spaces.has(id)) spaces.set(id, spaceOf(await http.get(`/api/v2/spaces/${encodeURIComponent(id)}`)));
      return spaces.get(id);
    },
    async titles(ids) {
      const out = new Map();
      for (let i = 0; i < ids.length; i += 250) {
        const r = await http.get('/api/v2/pages', { id: ids.slice(i, i + 250).join(','), limit: 250 });
        for (const p of r.results || []) out.set(p.id, p.title);
      }
      return out;
    },

    rootItems: (spaceId, { cursor } = {}) => list(`/api/v2/spaces/${encodeURIComponent(spaceId)}/pages`, { depth: 'root', status: 'current', limit: 250, cursor }, 'page'),
    children: (id, kind, { cursor } = {}) => list(`/api/v2/${kind}s/${encodeURIComponent(id)}/direct-children`, { limit: 250, cursor }),

    async page(id) {
      const p = `/api/v2/pages/${encodeURIComponent(id)}`;
      const [raw, anc, props] = await Promise.all([
        http.get(p, { 'body-format': FORMAT, 'include-version': true }), http.get(p + '/ancestors'), http.get(p + '/properties', { key: 'editor' })]);
      const prop = (props.results || []).find((x) => x.key === 'editor');
      return pageOf(raw, { ancestors: (anc.results || []).map((a) => ({ id: a.id })), editor: prop && prop.value ? prop.value : null });
    },
    async pageVersion(id, n) {
      try { return versionOf(await http.get(`/api/v2/pages/${encodeURIComponent(id)}/versions/${n}`)); }
      catch (e) { if (e instanceof JiraError && e.status === 404) return null; throw e; }
    },
    async currentVersion(id) { return (await http.get(`/api/v2/pages/${encodeURIComponent(id)}`)).version.number; },
    async pageAt(id, n) { const r = await http.get(`/api/v2/pages/${encodeURIComponent(id)}`, { version: n, 'body-format': FORMAT }); return { title: r.title, adf: parseAdf(r.body) }; },
    async updatePage(id, { title, adf, version }) {
      return pageOf(await http.send('PUT', `/api/v2/pages/${encodeURIComponent(id)}`, { id, status: 'current', title, body: bodyOf(adf), version: { number: version, message: '' } }));
    },

    footerComments: (pageId) => comments(pageId, 'footer'),
    inlineComments: (pageId) => comments(pageId, 'inline'),
    async addFooterComment(pageId, adf) { return commentOf('footer')(await http.send('POST', '/api/v2/footer-comments', { pageId, body: bodyOf(adf) })); },
    async reply(parentId, kind, adf) { return commentOf(kindOf(kind))(await http.send('POST', `/api/v2/${kindOf(kind)}-comments`, { parentCommentId: parentId, body: bodyOf(adf) })); },
    async comment(id, kind) { return commentOf(kindOf(kind))(await http.get(`/api/v2/${kindOf(kind)}-comments/${encodeURIComponent(id)}`, { 'body-format': FORMAT })); },
    async editComment(id, kind, adf, version) {
      return commentOf(kindOf(kind))(await http.send('PUT', `/api/v2/${kindOf(kind)}-comments/${encodeURIComponent(id)}`, { version: { number: version }, body: bodyOf(adf) }));
    },

    async users(accountIds) {
      const need = [...new Set(accountIds)].filter((a) => !people.has(a));
      for (let i = 0; i < need.length; i += 100) {
        const r = await http.send('POST', '/api/v2/users-bulk', { accountIds: need.slice(i, i + 100) }, { read: true });
        for (const u of (r && r.results) || []) people.set(u.accountId, { accountId: u.accountId, displayName: u.displayName });
      }
      return new Map(accountIds.filter((a) => people.has(a)).map((a) => [a, people.get(a)]));
    },

    async search(cql, { limit = 25, start = 0 } = {}) {
      const r = await http.get('/rest/api/search', { cql, limit, start, expand: 'content.version,content.space,content.container' });
      const items = (r.results || []).map((h) => {
        const c = h.content || {};
        return { id: c.id || null, type: c.type || h.entityType || null, title: c.title || h.title, spaceKey: c.space ? c.space.key : null,
          pageId: c.type === 'comment' ? (c.container ? c.container.id : null) : c.id || null, lastModified: h.lastModified || null,
          by: person(c.version && c.version.by), webUrl: wiki((c._links && c._links.webui) || h.url) };
      });
      return { items, total: r.totalSize !== undefined ? r.totalSize : items.length };
    },
    async probe() { await http.get('/api/v2/spaces', { limit: 1 }); return true; },
  };
}

module.exports = { createConfluence };
