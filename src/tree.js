'use strict';
// The epic -> task -> sub-task tree behind the sidebar, and the chain of a ticket for the agent file (design 101, "The sidebar").
const keyParts = (k) => { const i = String(k).lastIndexOf('-'); return [String(k).slice(0, i), Number(String(k).slice(i + 1))]; };
function cmpKey(a, b) {
  const [pa, na] = keyParts(a), [pb, nb] = keyParts(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
}
const byKeyAsc = (a, b) => cmpKey(a.key, b.key);
function byDueThenKeyDesc(a, b) {
  if (a.duedate !== b.duedate) { if (!a.duedate) return 1; if (!b.duedate) return -1; return a.duedate < b.duedate ? -1 : 1; }
  return cmpKey(b.key, a.key);
}

function isPlaceholder(assignee, placeholders) {
  return !!assignee && (placeholders || []).some((p) => p === assignee.displayName || p === assignee.accountId);
}

const firstName = (a) => (a ? String(a.displayName || '').trim().split(/\s+/)[0] || '-' : '-');
// the extra sidebar columns of an issue
const columnsOf = (i) => ({
  type: i.type || null, priority: (i.priority && i.priority.name) || null, due: i.duedate || null, labels: i.labels || [], estimate: i.estimate || null,
});
// what the row tooltip shows, and who has the ticket: 'none' when unassigned or assigned to a placeholder
const tipOf = (i, meId, placeholders) => ({
  assignee: (i.assignee && i.assignee.displayName) || null, statusName: (i.status && i.status.name) || null,
  owner: !i.assignee || isPlaceholder(i.assignee, placeholders) ? 'none' : i.assignee.accountId === meId ? 'me' : 'other',
});
const kids = (children, key) => (children.get(key) || []).slice().sort(byKeyAsc);

function nodeOf(issue, kind, children, meId, placeholders) {
  const cat = issue.status && issue.status.category;
  return {
    key: issue.key, summary: issue.summary, who: firstName(issue.assignee), ...columnsOf(issue), ...tipOf(issue, meId, placeholders),
    status: cat === 'new' ? null : (issue.status && issue.status.name) || null, done: cat === 'done',
    mine: !!issue.assignee && issue.assignee.accountId === meId, kind,
    children: kids(children, issue.key).map((c) => nodeOf(c, c.isSubtask ? 'subtask' : 'task', children, meId, placeholders)),
  };
}
const hasMine = (n) => n.mine || n.children.some(hasMine);

// In sprint and version modes, member tasks without an epic sit under this key in `children` (design 101, "Periods").
const NOEPIC = '__noepic__';

function buildTree({ epics, children, meId, mode, placeholders }) {
  const sorted = epics.slice().sort(byDueThenKeyDesc);
  const claimed = new Map(sorted.map((e) => [e, !(!e.assignee || isPlaceholder(e.assignee, placeholders))]));
  const nodes = new Map(sorted.map((e) => [e, nodeOf(e, 'epic', children, meId, placeholders)]));
  const loose = kids(children, NOEPIC).map((c) => nodeOf(c, c.isSubtask ? 'subtask' : 'task', children, meId, placeholders));
  const noEpic = (list) => (list.length ? [{ id: 'noepic', title: 'No epic', nodes: list }] : []);
  if (mode !== 'all') {
    const mine = sorted.map((e) => nodes.get(e)).filter(hasMine);
    return { groups: [...(mine.length ? [{ id: 'mine', title: null, nodes: mine }] : []), ...noEpic(loose.filter(hasMine))] };
  }
  const pick = (c) => sorted.filter((e) => claimed.get(e) === c).map((e) => nodes.get(e));
  const groups = [{ id: 'unclaimed', title: 'Unclaimed', nodes: pick(false) }, { id: 'claimed', title: 'Claimed', nodes: pick(true) }];
  return { groups: [...groups.filter((g) => g.nodes.length), ...noEpic(loose)] };
}

function chainOf(key, index) {
  const self = index.get(key);
  const all = [...index.values()];
  const childrenOf = (k) => all.filter((i) => i.parentKey === k).sort(byKeyAsc);
  const path = [];
  for (let p = self && self.parentKey && index.get(self.parentKey); p && path.length < 10; p = p.parentKey && index.get(p.parentKey)) path.unshift(p);
  const descend = (k) => childrenOf(k).flatMap((c) => [c, ...descend(c.key)]);
  return {
    path, children: childrenOf(key),
    siblings: self && self.parentKey ? childrenOf(self.parentKey).filter((i) => i.key !== key) : [],
    tree: self && self.isEpic ? descend(key) : [],
  };
}

module.exports = { NOEPIC, buildTree, isPlaceholder, chainOf, firstName, columnsOf, tipOf };
