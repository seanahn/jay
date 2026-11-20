'use strict';
// The Jira Cloud REST calls jay needs, normalized to the shapes the rest of the extension uses.
const FIELDS = 'summary,status,assignee,reporter,issuetype,parent,labels,priority,duedate,timetracking,created,updated';
const R = '/rest/api/3';

const person = (u) => (u ? { accountId: u.accountId, displayName: u.displayName } : null);

// description is left undefined when the search didn't ask for it, so callers can tell "not fetched" from "empty"
function issueOf(raw, withDescription = true) {
  const f = raw.fields || {}; const t = f.issuetype || {}; const s = f.status || {};
  return {
    key: raw.key, id: raw.id, type: t.name, isEpic: t.hierarchyLevel === 1, isSubtask: !!t.subtask,
    summary: f.summary,
    status: { name: s.name, category: s.statusCategory && s.statusCategory.key },
    assignee: person(f.assignee), reporter: person(f.reporter),
    priority: f.priority ? { id: f.priority.id, name: f.priority.name } : null,
    estimate: (f.timetracking && f.timetracking.originalEstimate) || null,
    duedate: f.duedate || null, labels: f.labels || [], parentKey: f.parent ? f.parent.key : null,
    created: f.created, updated: f.updated, description: withDescription ? f.description || null : undefined,
  };
}
const commentOf = (c) => ({ id: c.id, author: person(c.author), created: c.created, updated: c.updated, body: c.body });

const AGILE = '/rest/agile/1.0';
const NOT_A_SIGN_IN = { refresh: false };   // the Agile API: a refusal means "no Jira Software scopes", never "sign in again"

function createApi(http, auth) {
  const issuePath = (key) => `${R}/issue/${encodeURIComponent(key)}`;
  // every page of an Agile API list (startAt / isLast)
  // from: the first startAt; a page that says it is last, or an empty one, ends it
  async function agilePages(path, query, from = 0) {
    const out = [];
    for (let at = from; ;) {
      const page = (await http.get(path, { ...query, startAt: at, maxResults: 50 }, NOT_A_SIGN_IN)) || {};
      const values = page.values || [];
      out.push(...values); at += values.length;
      if (page.isLast || !values.length || (Number.isFinite(page.total) && at >= page.total)) return { out, page };
    }
  }
  return {
    myself: async () => { const u = await http.get(`${R}/myself`); return { ...person(u), emailAddress: u.emailAddress || null }; },
    async projects() {
      const out = [];
      for (;;) {
        const page = await http.get(`${R}/project/search`, { startAt: out.length, maxResults: 50 });
        const values = page.values || [];
        out.push(...values.map((p) => ({ key: p.key, name: p.name })));
        if (page.isLast || !values.length) return out;
      }
    },
    // max (optional): stop paging once that many are in, and never ask for more than are still missing
    async search(jql, { fields = FIELDS, max } = {}) {
      const out = []; let token;
      do {
        const body = { jql, fields: fields.split(','), maxResults: max ? Math.min(100, max - out.length) : 100 };
        if (token) body.nextPageToken = token;
        const page = await http.send('POST', `${R}/search/jql`, body, { read: true });
        out.push(...(page.issues || []).map((r) => issueOf(r, body.fields.includes('description'))));
        token = page.nextPageToken;
      } while (token && !(max && out.length >= max));
      return max ? out.slice(0, max) : out;
    },
    async issue(key) { return issueOf(await http.get(issuePath(key), { fields: FIELDS + ',description' })); },
    async field(key, name) { return ((await http.get(issuePath(key), { fields: name })).fields || {})[name]; },
    async comments(key, { newest = 50 } = {}) {
      const r = await http.get(`${issuePath(key)}/comment`, { orderBy: '-created', maxResults: newest });
      return { comments: (r.comments || []).map(commentOf).reverse(), total: r.total };
    },
    async comment(key, id) { return commentOf(await http.get(`${issuePath(key)}/comment/${encodeURIComponent(id)}`)); },
    async transitions(key) {
      const r = await http.get(`${issuePath(key)}/transitions`, { expand: 'transitions.fields' });
      return (r.transitions || []).map((t) => ({
        id: t.id, name: t.name,
        to: { name: t.to && t.to.name, category: t.to && t.to.statusCategory && t.to.statusCategory.key },
        hasScreen: Object.values(t.fields || {}).some((x) => x && x.required),
      }));
    },
    async assignable(key, query) { return (await http.get(`${R}/user/assignable/search`, { issueKey: key, query })).map(person); },
    async users(query) { return (await http.get(`${R}/user/search`, { query })).map(person); },
    async boards(projectKey) {
      return (await agilePages(`${AGILE}/board`, { projectKeyOrId: projectKey })).out.map((b) => ({ id: b.id, name: b.name, type: b.type }));
    },
    // Active and future sprints in full. Closed ones only from the end of the list, where Jira puts the most recent: the first
    // page tells the total, then one page from the end; a board's whole history would be read every 15 minutes otherwise.
    async sprints(boardId) {
      const path = `${AGILE}/board/${encodeURIComponent(boardId)}/sprint`;
      const open = (await agilePages(path, { state: 'active,future' })).out;
      const first = await http.get(path, { state: 'closed', startAt: 0, maxResults: 50 }, NOT_A_SIGN_IN) || {};
      const closed = first.values || [];
      if (!first.isLast && closed.length && Number.isFinite(first.total) && first.total > closed.length) {
        const size = first.maxResults || closed.length;
        closed.push(...(await agilePages(path, { state: 'closed' }, Math.max(closed.length, first.total - size))).out);
      } else if (!first.isLast && closed.length && !Number.isFinite(first.total)) {
        closed.push(...(await agilePages(path, { state: 'closed' }, closed.length)).out);   // no total given: read on
      }
      return [...open, ...closed].map((x) => ({ id: x.id, name: x.name, state: x.state, startDate: x.startDate || null, endDate: x.endDate || null }));
    },
    async versions(projectKey) {
      return ((await http.get(`${R}/project/${encodeURIComponent(projectKey)}/versions`)) || [])
        .map((v) => ({ id: String(v.id), name: v.name, released: !!v.released, archived: !!v.archived, releaseDate: v.releaseDate || null }));
    },
    async priorities() { return (await http.get(`${R}/priority`)).map((p) => ({ id: p.id, name: p.name })); },
    async setFields(key, fields) { await http.send('PUT', issuePath(key), { fields }); },
    async transition(key, id) { await http.send('POST', `${issuePath(key)}/transitions`, { transition: { id } }); },
    async addComment(key, adf) { return commentOf(await http.send('POST', `${issuePath(key)}/comment`, { body: adf })); },
    async editComment(key, id, adf) { return commentOf(await http.send('PUT', `${issuePath(key)}/comment/${encodeURIComponent(id)}`, { body: adf })); },
    async remoteLinks(key) { return ((await http.get(`${issuePath(key)}/remotelink`)) || []).map((l) => ({ url: l.object.url, title: l.object.title || l.object.url })); },
    browseUrl: (key) => auth.siteUrl() + '/browse/' + key,
  };
}

module.exports = { FIELDS, createApi };
