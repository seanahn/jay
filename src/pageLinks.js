'use strict';
// Confluence page URLs and tiny links. Pure: no network, no vscode.

function decodeTiny(tiny) {
  if (typeof tiny !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tiny)) return null;
  const b64 = tiny.replace(/-/g, '/').replace(/_/g, '+');
  const bytes = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n === 0n ? null : n.toString();
}

function parsePageUrl(url, site) {
  let u, s;
  try { u = new URL(url); s = new URL(site); } catch { return null; }
  if (u.protocol !== 'https:' || u.host.toLowerCase() !== s.host.toLowerCase()) return null;
  let pageId = null;
  let m;
  if ((m = /^\/wiki\/spaces\/[^/]+\/pages\/(?:edit-v2\/)?(\d+)(?:\/|$)/.exec(u.pathname))) pageId = m[1];
  else if (u.pathname === '/wiki/pages/viewpage.action') {
    const id = u.searchParams.get('pageId');
    if (id && /^\d+$/.test(id)) pageId = id;
  } else if ((m = /^\/wiki\/x\/([^/]+)\/?$/.exec(u.pathname))) pageId = decodeTiny(m[1]);
  if (!pageId) return null;
  const cid = u.searchParams.get('focusedCommentId');
  return cid && /^\d+$/.test(cid) ? { pageId, commentId: cid } : { pageId };
}

function confluenceLinksIn(adf, site) {
  const out = [];
  const add = (url) => {
    if (typeof url === 'string' && parsePageUrl(url, site) && !out.includes(url)) out.push(url);
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ((n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') && n.attrs) add(n.attrs.url);
    if (Array.isArray(n.marks)) for (const mk of n.marks) if (mk && mk.type === 'link' && mk.attrs) add(mk.attrs.href);
    if (n.type === 'text' && typeof n.text === 'string') {
      for (const m of n.text.matchAll(/https:\/\/[^\s<>"']+/g)) add(m[0].replace(/[.,;:!?)\]]+$/, ''));
    }
    if (n.content) walk(n.content);
  };
  walk(adf);
  return out;
}

module.exports = { parsePageUrl, decodeTiny, confluenceLinksIn };
