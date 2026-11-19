'use strict';
// Atlassian Document Format helpers: a canonical form for comparing documents, the people a document mentions, and a plain-text
// rendering for agents. toText and fromText are lossy by design; normalize and sameAdf are the lossless comparison.
const emptyDoc = () => ({ type: 'doc', version: 1, content: [] });

function normNode(n) {
  if (!n || typeof n !== 'object') return n;
  const out = { ...n };
  if (out.attrs) {
    const { localId, ...rest } = out.attrs;
    if (Object.keys(rest).length) out.attrs = rest; else delete out.attrs;
  }
  if (out.marks) out.marks = out.marks.map((m) => normNode(m)).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  if (out.content) out.content = mergeText(out.content.map(normNode));
  return out;
}
// Adjacent plain text nodes with the same (sorted) marks read as one, the way ProseMirror joins them.
const plainText = (n) => n && n.type === 'text' && typeof n.text === 'string' && Object.keys(n).every((k) => k === 'type' || k === 'text' || k === 'marks');
function mergeText(list) {
  const out = [];
  for (const n of list) {
    const prev = out[out.length - 1];
    if (plainText(prev) && plainText(n) && canon(prev.marks) === canon(n.marks)) out[out.length - 1] = { ...prev, text: prev.text + n.text };
    else out.push(n);
  }
  return out;
}
function normalize(adf) {
  const d = normNode(adf || emptyDoc());
  return { ...d, content: d.content || [] };
}
// Canonical JSON: object keys sorted recursively, so key order never matters.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function sameAdf(a, b) { return canon(normalize(a)) === canon(normalize(b)); }

function mentionsOf(adf) {
  const ids = new Set();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mention' && n.attrs && n.attrs.id) ids.add(n.attrs.id);
    (n.content || []).forEach(walk);
  })(adf);
  return [...ids];
}

const kids = (n) => n.content || [];
const indent = (s, pad) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');

function inline(n) {
  const a = n.attrs || {};
  switch (n.type) {
    case 'text': {
      const link = (n.marks || []).find((m) => m.type === 'link');
      return link && link.attrs && link.attrs.href ? `${n.text} (${link.attrs.href})` : n.text || '';
    }
    case 'hardBreak': return '\n';
    case 'mention': { const t = String(a.text || ''); return t.startsWith('@') ? t : '@' + t; }
    case 'emoji': return a.text || a.shortName || '';
    case 'date': {
      const d = new Date(Number(a.timestamp));
      return a.timestamp == null || a.timestamp === '' || Number.isNaN(d.getTime()) ? '[date]' : d.toISOString().slice(0, 10);
    }
    case 'status': return a.text || '';
    default: return `[${n.type}]`;
  }
}
const inlines = (n) => kids(n).map(inline).join('');

function listText(n, marker) {
  return kids(n).map((item, i) => {
    const m = marker(item, i);
    const body = item.type === 'taskItem' ? inlines(item) : kids(item).map(block).join('\n');
    return m + indent(body, ' '.repeat(m.length)).slice(m.length);
  }).join('\n');
}

function block(n) {
  const a = n.attrs || {};
  switch (n.type) {
    case 'paragraph': return inlines(n);
    case 'heading': return '#'.repeat(a.level || 1) + ' ' + inlines(n);
    case 'bulletList': return listText(n, () => '- ');
    case 'orderedList': return listText(n, (_, i) => `${(a.order == null ? 1 : a.order) + i}. `);
    case 'taskList': return listText(n, (item) => ((item.attrs || {}).state === 'DONE' ? '- [x] ' : '- [ ] '));
    case 'codeBlock': return indent(inlines(n), '    ');
    case 'blockquote': return indent(kids(n).map(block).join('\n'), '> ');
    case 'rule': return '---';
    case 'table': return '[table]';
    case 'panel': return `[panel: ${kids(n).map(block).join('\n').split('\n')[0]}]`;
    case 'expand': return `[expand: ${a.title || ''}]`;
    case 'mediaSingle': case 'mediaGroup': case 'media': return '[image]';
    default: return `[${n.type}]`;
  }
}
function toText(adf) { return adf ? kids(adf).map(block).join('\n\n') : ''; }

function fromText(text) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim());
  return {
    type: 'doc', version: 1,
    content: paras.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
  };
}

module.exports = { normalize, sameAdf, mentionsOf, toText, fromText };
