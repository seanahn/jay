'use strict';
// Each open Confluence page as a plain-text file under ~/.jay, and current.confluence as a copy of the one in front, so the agent
// beside jay can read it (the page version of mirror.js).
const fs = require('fs'); const path = require('path');
const { toText } = require('./adf');
const { atomic, stamp, oneLine } = require('./mirror');

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const indent = (text, pad) => text.split('\n').map((l) => (l ? pad + l : l));

function formatPage(view) {
  const { page } = view;
  const names = view.names || new Map();
  const nameOf = (id) => oneLine(names.get(id) || 'Unknown');
  const body = toText(page.adf);
  const v = page.version || {};
  const head = [
    `# Confluence page ${page.id}: ${oneLine(page.title)}`,
    `# ${page.webUrl}`,
    '# Written by jay; mirrors this page. Other pages: read their .confluence files or use a Confluence MCP server.',
  ];
  const facts = `Space: ${view.spaceKey} (${oneLine(view.spaceName)}) · Version: ${v.number} · Author: ${oneLine(view.authorName || 'unknown')} · Updated: ${stamp(v.createdAt)} by ${oneLine(view.editorName || 'unknown')}`;

  const block = (c, lead, pad) => [`${lead}[${stamp(c.createdAt)}] ${nameOf(c.authorId)}:`, ...indent(toText(c.adf), pad)].join('\n');
  const footer = view.footer || [];
  const total = view.footerTotal == null ? footer.length : view.footerTotal;
  const heading = footer.length < total ? `newest ${footer.length} of ${total}` : `${footer.length} of ${total}`;
  const footerBlocks = footer.map((c) => [block(c, '', '  '), ...(c.replies || []).map((r) => block(r, '  ↳ ', '      '))].join('\n'));

  const one = (c, lead) => `${lead}[${stamp(c.createdAt)}] ${nameOf(c.authorId)}: ${oneLine(toText(c.adf))}`;
  const inlineBlocks = (view.inline || []).map((c) => [`> ${oneLine(c.quote)}`, one(c, ''), ...(c.replies || []).map((r) => one(r, '  ↳ '))].join('\n'));

  const keys = [...new Set(body.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) || [])];
  const children = view.children || [];
  const out = [
    head.join('\n'), '',
    facts,
    ...((view.path || []).length ? [`Path: ${view.path.map((p) => oneLine(p.title)).join(' › ')}`] : []), '',
    '## Body', body || '(none)', '',
    `## Comments (${heading})`, ...(footerBlocks.length ? [footerBlocks.join('\n\n'), ''] : ['']),
  ];
  if (inlineBlocks.length) out.push('## Inline comments', inlineBlocks.join('\n\n'), '');
  if (children.length) out.push('## Children', ...children.map((c) => `- ${oneLine(c.title)} (${c.id})`), '');
  if (keys.length) out.push('## Jira keys', keys.join(', '), '');
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

/** @param enabled() whether files are written at all (setting jay.agentFiles) */
function createPageMirror({ dir, enabled = () => true }) {
  const pagesDir = path.join(dir, 'pages');
  const fileFor = (spaceKey, id) => path.join(pagesDir, `${safe(spaceKey)}-${safe(id)}.confluence`);
  const currentFile = path.join(dir, 'current.confluence');
  let current = null;

  /** Whether current.confluence still shows this page: another window may have taken it since. */
  function stillOurs(url) {
    try { return fs.readFileSync(currentFile, 'utf8').split('\n', 3).includes(`# ${url}`); } catch (_) { return true; }
  }

  function write(view) {
    if (!enabled()) return null;
    const file = fileFor(view.spaceKey, view.page.id);
    const text = formatPage(view);
    atomic(dir, file, text);
    if (current === file && stillOurs(view.page.webUrl)) atomic(dir, currentFile, text);
    return file;
  }
  function setCurrent(file) {
    if (!file || !enabled()) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }   // closed or signed out since
    current = file;
    atomic(dir, currentFile, text);
  }
  /** Removes the agent files only (jay.agentFiles turned off): page files and current.confluence. */
  function clearFiles() {
    let names = []; try { names = fs.readdirSync(pagesDir); } catch (_) { /* none */ }
    for (const n of names) if (n.endsWith('.confluence') || n.endsWith('.tmp')) { try { fs.unlinkSync(path.join(pagesDir, n)); } catch (_) { /* gone */ } }
    try { fs.rmdirSync(pagesDir); } catch (_) { /* not empty or gone */ }
    try { fs.unlinkSync(currentFile); } catch (_) { /* none */ }
    current = null;
  }

  return {
    write, setCurrent, clearFiles,
    closed(spaceKey, id) { try { fs.unlinkSync(fileFor(spaceKey, id)); } catch (_) { /* already gone */ } },
    pathFor(spaceKey, id) { const f = fileFor(spaceKey, id); return enabled() && fs.existsSync(f) ? f : null; },
    /** Signing out: everything jay wrote for pages. */
    clearAll: clearFiles,
  };
}

module.exports = { createPageMirror, formatPage };
