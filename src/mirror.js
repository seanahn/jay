'use strict';
// Each open ticket as a plain-text file under ~/.jay, and current.jira as a copy of the one in front, so the agent beside jay
// can read it (design 101, "How the agent knows the ticket in front").
const fs = require('fs'); const path = require('path');
const { toText } = require('./adf');

const pad = (n) => String(n).padStart(2, '0');
function stamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const oneLine = (x) => String(x == null ? '' : x).replace(/[\r\n\u2028\u2029]+/g, ' ');
const safeKey = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, '_');
const who = (p, none) => (p && p.displayName ? oneLine(p.displayName) : none);

// Fixed columns: role and key share 16 characters (a long role eats into the key's padding), status 13, assignee 13.
function row(role, issue, marker, indent = '') {
  const head = (`${indent}${role} `).padEnd(7) + issue.key;
  const status = ((issue.status && issue.status.name) || '').padEnd(12) + ' ';
  const line = `${(head + ' ').padEnd(16)}${oneLine(status).padEnd(13)}${who(issue.assignee, 'unassigned').concat(' ').padEnd(13)}${oneLine(issue.summary)}`;
  return marker ? `${line}   ← this ticket` : line;
}

function treeLines(issue, chain) {
  const lines = (chain.path || []).map((p) => row(p.type || 'Parent', p));
  lines.push(row(`${issue.type || 'Task'} >`, issue, true));
  if (issue.isEpic) {
    const depth = new Map([[issue.key, -1]]);
    for (const c of chain.tree || []) {
      const d = (depth.has(c.parentKey) ? depth.get(c.parentKey) : -1) + 1;
      depth.set(c.key, d);
      lines.push(row('Child', c, false, '  '.repeat(d)));
    }
  } else {
    for (const c of chain.children || []) lines.push(row('Child', c));
    for (const s of chain.siblings || []) lines.push(row('Sibling', s));
  }
  return lines;
}

function formatIssue(issue, comments, total, chain, browseUrl, pages) {
  const head = [
    `# Jira ${oneLine(issue.type || 'Issue')} ${issue.key}: ${oneLine(issue.summary)}`,
    `# ${browseUrl(issue.key)}`,
    '# Written by jay; mirrors this ticket. Other tickets: read their .jira files or use a Jira MCP server with the keys below.',
  ];
  const facts = [`Status: ${oneLine(issue.status && issue.status.name)}`, `Assignee: ${who(issue.assignee, 'unassigned')}`, `Reporter: ${who(issue.reporter, 'unknown')}`];
  if (issue.priority && issue.priority.name) facts.push(`Priority: ${oneLine(issue.priority.name)}`);
  if (issue.duedate) facts.push(`Due: ${issue.duedate}`);
  const cs = comments || [];
  const heading = cs.length < total ? `newest ${cs.length} of ${total}` : `${cs.length} of ${total}`;
  const blocks = cs.map((c) => {
    const body = toText(c.body);
    return [`[${stamp(c.created)}] ${who(c.author, 'Unknown')}:`, ...(body ? body.split('\n').map((l) => (l ? '  ' + l : l)) : [])].join('\n');
  });
  return [
    head.join('\n'), '',
    facts.join(' · '),
    `Labels: ${(issue.labels || []).map(oneLine).join(', ') || 'none'}`,
    `Created: ${stamp(issue.created)} · Updated: ${stamp(issue.updated)}`, '',
    '## Tree', ...treeLines(issue, chain || {}), '',
    '## Description', toText(issue.description) || '(none)', '',
    ...(pages && pages.length ? ['## Confluence pages', ...pages.map((p) => `- ${oneLine(p.title)} — ${oneLine(p.url)}`), ''] : []),
    `## Comments (${heading})`, ...(blocks.length ? [blocks.join('\n\n')] : []),
  ].join('\n') + '\n';
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); }
/** Writes text to file (inside dir) through a temp file and a rename, directories 700, file 600. */
function atomicWrite(dir, file, text) {
  ensureDir(dir); ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** @param enabled() whether files are written at all (setting jay.agentFiles) */
function createMirror({ dir, enabled = () => true, browseUrl }) {
  const issuesDir = path.join(dir, 'issues');
  const fileFor = (key) => path.join(issuesDir, `${safeKey(key)}.jira`);
  let current = null;

  const atomic = (file, text) => atomicWrite(dir, file, text);
  /** Whether current.jira still shows this ticket: another window may have taken it since. */
  function stillOurs(key) {
    try { return fs.readFileSync(path.join(dir, 'current.jira'), 'utf8').split('\n', 3).includes(`# ${browseUrl(key)}`); } catch (_) { return true; }
  }

  function write(issue, comments, total, chain, pages) {
    if (!enabled()) return null;
    const file = fileFor(issue.key);
    const text = formatIssue(issue, comments, total, chain, browseUrl, pages);
    atomic(file, text);
    if (current === file && stillOurs(issue.key)) atomic(path.join(dir, 'current.jira'), text);
    return file;
  }
  function setCurrent(file) {
    if (!file || !enabled()) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }   // closed or signed out since
    current = file;
    atomic(path.join(dir, 'current.jira'), text);
  }

  /** Removes the agent files only (jay.agentFiles turned off): issue files and current.jira. */
  function clearFiles() {
    let names = []; try { names = fs.readdirSync(issuesDir); } catch (_) { /* none */ }
    for (const n of names) if (n.endsWith('.jira') || n.endsWith('.tmp')) { try { fs.unlinkSync(path.join(issuesDir, n)); } catch (_) { /* gone */ } }
    try { fs.rmdirSync(issuesDir); } catch (_) { /* not empty or gone */ }
    try { fs.unlinkSync(path.join(dir, 'current.jira')); } catch (_) { /* none */ }
    current = null;
  }

  return {
    write, setCurrent,
    closed(key) { try { fs.unlinkSync(fileFor(key)); } catch (_) { /* already gone */ } },
    pathFor(key) { const f = fileFor(key); return enabled() && fs.existsSync(f) ? f : null; },
    clearFiles,
    /** Removes everything jay wrote under dir (signing out): issue files, current.jira, the cache and seen.json. */
    clearAll() {
      clearFiles();
      try { fs.unlinkSync(path.join(dir, 'seen.json')); } catch (_) { /* none */ }
      try { fs.rmSync(path.join(dir, 'cache'), { recursive: true, force: true }); } catch (_) { /* none */ }
    },
  };
}

module.exports = { createMirror, formatIssue, stamp, oneLine, atomic: atomicWrite };
