'use strict';
// ADF <-> ProseMirror for the ticket page. makeAdfPm(model) takes the prosemirror-model namespace (window.PM.model in the
// page, the prosemirror-model package in tests) and returns { schema, fromAdf, toAdf }. Nothing is ever dropped:
// - ADF nodes jay does not edit, and editable nodes in places the schema cannot hold, become atoms (atomBlock or
//   atomInline, chosen by the context they appear in) whose attrs.adf is a private copy of the original JSON, emitted as is;
// - marks jay does not edit become a keptMark carrying the original mark JSON;
// - ADF attrs and keys an editable node or mark carries but jay does not model ride along in its `extra` attr.
// Loaded as CommonJS in tests and as a plain script in the page, so it loads nothing itself.
(function (root) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Attrs each editable type models directly, with their defaults for nodes created in the editor.
  const NODE_ATTRS = {
    heading: { level: 1 }, orderedList: { order: null }, taskItem: { state: 'TODO' }, codeBlock: { language: null },
    mention: { id: null, text: null }, emoji: { shortName: null, text: null }, date: { timestamp: null },
    status: { text: null, color: null },
  };
  const MARK_ATTRS = { link: { href: null }, textColor: { color: null } };
  const EDIT_NODES = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
    'codeBlock', 'blockquote', 'rule', 'hardBreak', 'mention', 'emoji', 'date', 'status']);
  const EDIT_MARKS = new Set(['strong', 'em', 'code', 'strike', 'underline', 'link', 'textColor']);

  const safeHref = (h) => (typeof h === 'string' && /^(https?:|mailto:)/i.test(h.trim()) ? h : null);
  const safeColor = (c) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(c) ? c : null);
  const str = (v) => (v == null ? '' : String(v));
  function dayOf(ts) {
    const d = new Date(Number(ts));
    return ts == null || ts === '' || Number.isNaN(d.getTime()) ? '[date]' : d.toISOString().slice(0, 10);
  }
  const typeOf = (adf) => (isObj(adf) && typeof adf.type === 'string' ? adf.type : 'unknown');

  // A UUID-v4-shaped id: crypto.randomUUID where the runtime has it, Math.random otherwise.
  function randomId() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-' + '89ab'[Math.floor(Math.random() * 4)] + hex(3) + '-' + hex(12);
  }
  // Every localId inside a stretch of ADF JSON (used for atoms, which are never rewritten).
  function collectIds(v, seen) {
    if (Array.isArray(v)) v.forEach((x) => collectIds(x, seen));
    else if (isObj(v)) {
      if (isObj(v.attrs) && v.attrs.localId != null) seen.add(v.attrs.localId);
      collectIds(v.content, seen);
    }
  }

  // ProseMirror turns missing attrs into null, so an atom made without its original ADF is caught here.
  function requireAdf(v) { if (v == null) throw new RangeError('an atom needs its original ADF'); }

  function makeAdfPm(model, opts) {
    const { Schema, Fragment } = model;
    const newId = (opts && opts.newId) || randomId;
    const attrSpec = (defaults) => {
      const a = { extra: { default: null } };
      for (const k of Object.keys(defaults || {})) a[k] = { default: defaults[k] };
      return a;
    };
    const node = (name, spec) => ({ ...spec, attrs: attrSpec(NODE_ATTRS[name]) });
    const mark = (name, spec) => ({ ...spec, attrs: attrSpec(MARK_ATTRS[name]) });

    // ---- the clipboard: toDOM writes what a node or mark is into data-* attributes, parseDOM reads it back, so copy
    // and paste inside the editor keep atoms, mentions, marks and `extra` (design 101, "The ticket tab"). Values go
    // through ProseMirror's DOM spec as attributes, never as HTML. Anything unreadable is not matched.
    const readJson = (v) => { if (typeof v !== 'string') return undefined; try { return JSON.parse(v); } catch (_) { return undefined; } };
    const adfOf = (dom) => { const v = readJson(dom.getAttribute('data-adf')); return isObj(v) && typeof v.type === 'string' ? v : null; };
    const OWN_KEYS = ['type', 'attrs', 'content', 'marks', 'text'];   // never taken from a pasted `extra.rest`
    function extraOf(dom) {
      const v = readJson(dom.getAttribute('data-extra'));
      if (!isObj(v) || (v.attrs !== undefined && !isObj(v.attrs)) || (v.rest !== undefined && !isObj(v.rest))) return null;
      const out = {};
      if (v.attrs) out.attrs = v.attrs;
      if (v.rest) { const r = {}; for (const k of Object.keys(v.rest)) if (!OWN_KEYS.includes(k)) r[k] = v.rest[k]; if (Object.keys(r).length) out.rest = r; }
      if (v.noContent === true) out.noContent = true;
      return Object.keys(out).length ? out : null;
    }
    /** DOM attrs for n (a node or mark): its own, plus data-extra when it carries extra. */
    const dom = (n, attrs) => (n.attrs.extra != null ? { ...(attrs || {}), 'data-extra': JSON.stringify(n.attrs.extra) } : attrs || {});
    /** A parse rule whose attrs are get(dom) (false: no match) and the element's extra. */
    const rule = (tag, get, more) => ({ tag, ...more, getAttrs: (d) => { const a = get ? get(d) : {}; return a === false ? false : { ...a, extra: extraOf(d) }; } });
    const attr = (d, name) => (d.hasAttribute(name) ? d.getAttribute(name) : null);
    const atomRule = (tag) => ({ tag, getAttrs: (d) => { const adf = adfOf(d); return adf ? { adf } : false; } });

    const schema = new Schema({
      nodes: {
        doc: node('doc', { content: 'block*' }),
        paragraph: node('paragraph', { content: 'inline*', group: 'block', toDOM: (n) => ['p', dom(n), 0], parseDOM: [rule('p')] }),
        heading: node('heading', {
          content: 'inline*', group: 'block', defining: true,
          toDOM: (n) => ['h' + Math.min(6, Math.max(1, Number(n.attrs.level) || 1)), dom(n), 0],
          parseDOM: [1, 2, 3, 4, 5, 6].map((level) => rule('h' + level, () => ({ level }))),
        }),
        bulletList: node('bulletList', { content: 'listItem+', group: 'block', toDOM: (n) => ['ul', dom(n), 0], parseDOM: [rule('ul')] }),
        orderedList: node('orderedList', {
          content: 'listItem+', group: 'block',
          toDOM: (n) => ['ol', dom(n, Number.isFinite(Number(n.attrs.order)) && n.attrs.order != null ? { start: String(Number(n.attrs.order)) } : {}), 0],
          parseDOM: [rule('ol', (d) => { const v = attr(d, 'start'); return { order: v != null && Number.isFinite(Number(v)) ? Number(v) : null }; })],
        }),
        listItem: node('listItem', { content: 'block+', defining: true, toDOM: (n) => ['li', dom(n), 0], parseDOM: [rule('li')] }),
        taskList: node('taskList', {
          content: '(taskItem | taskList)+', group: 'block', toDOM: (n) => ['ul', dom(n, { class: 'jay-tasks' }), 0], parseDOM: [rule('ul.jay-tasks', null, { priority: 60 })],
        }),
        taskItem: node('taskItem', {
          content: 'inline*', defining: true,
          toDOM: (n) => ['li', dom(n, { class: 'jay-task', 'data-state': n.attrs.state === 'DONE' ? 'DONE' : 'TODO' }), 0],
          parseDOM: [rule('li.jay-task', (d) => ({ state: d.getAttribute('data-state') === 'DONE' ? 'DONE' : 'TODO' }), { priority: 60 })],
        }),
        codeBlock: node('codeBlock', {
          content: 'text*', marks: '', group: 'block', code: true, defining: true,
          toDOM: (n) => ['pre', dom(n, { 'data-language': n.attrs.language }), ['code', 0]],
          parseDOM: [rule('pre', (d) => ({ language: attr(d, 'data-language') }), { preserveWhitespace: 'full' })],
        }),
        blockquote: node('blockquote', { content: 'block+', group: 'block', defining: true, toDOM: (n) => ['blockquote', dom(n), 0], parseDOM: [rule('blockquote')] }),
        rule: node('rule', { group: 'block', toDOM: (n) => ['hr', dom(n)], parseDOM: [rule('hr')] }),
        atomBlock: {
          group: 'block', atom: true, selectable: true, attrs: { adf: { validate: requireAdf } },
          toDOM: (n) => ['div', { class: 'jay-atom', 'data-type': typeOf(n.attrs.adf), 'data-adf': JSON.stringify(n.attrs.adf) }, '[' + typeOf(n.attrs.adf) + ']'],
          parseDOM: [atomRule('div.jay-atom')],
        },
        text: { group: 'inline' },
        hardBreak: node('hardBreak', { inline: true, group: 'inline', selectable: false, toDOM: (n) => ['br', dom(n)], parseDOM: [rule('br')] }),
        mention: node('mention', {
          inline: true, group: 'inline', atom: true,
          toDOM: (n) => ['span', dom(n, { class: 'jay-mention', 'data-id': n.attrs.id, 'data-text': n.attrs.text }), str(n.attrs.text)],
          parseDOM: [rule('span.jay-mention', (d) => (d.hasAttribute('data-id') ? { id: d.getAttribute('data-id'), text: attr(d, 'data-text') } : false))],
        }),
        emoji: node('emoji', {
          inline: true, group: 'inline', atom: true,
          toDOM: (n) => ['span', dom(n, { class: 'jay-emoji', 'data-short-name': n.attrs.shortName, 'data-text': n.attrs.text }), str(n.attrs.text || n.attrs.shortName)],
          parseDOM: [rule('span.jay-emoji', (d) => (d.hasAttribute('data-short-name') || d.hasAttribute('data-text') ? { shortName: attr(d, 'data-short-name'), text: attr(d, 'data-text') } : false))],
        }),
        date: node('date', {
          inline: true, group: 'inline', atom: true,
          toDOM: (n) => ['span', dom(n, { class: 'jay-date', 'data-timestamp': n.attrs.timestamp == null ? null : String(n.attrs.timestamp) }), dayOf(n.attrs.timestamp)],
          parseDOM: [rule('span.jay-date', (d) => (d.hasAttribute('data-timestamp') ? { timestamp: d.getAttribute('data-timestamp') } : false))],
        }),
        status: node('status', {
          inline: true, group: 'inline', atom: true,
          toDOM: (n) => ['span', dom(n, { class: 'jay-status', 'data-color': str(n.attrs.color), 'data-text': n.attrs.text }), str(n.attrs.text)],
          parseDOM: [rule('span.jay-status', (d) => (d.hasAttribute('data-text') ? { text: d.getAttribute('data-text'), color: attr(d, 'data-color') || null } : false))],
        }),
        atomInline: {
          inline: true, group: 'inline', atom: true, selectable: true, attrs: { adf: { validate: requireAdf } },
          toDOM: (n) => ['span', { class: 'jay-atom', 'data-type': typeOf(n.attrs.adf), 'data-adf': JSON.stringify(n.attrs.adf) }, '[' + typeOf(n.attrs.adf) + ']'],
          parseDOM: [atomRule('span.jay-atom')],
        },
      },
      marks: {
        strong: mark('strong', { toDOM: (m) => ['strong', dom(m), 0], parseDOM: [
          rule('strong'),
          // Google Docs wraps a paste in <b style="font-weight:normal">: not bold
          rule('b', (d) => (d.style.fontWeight === 'normal' ? false : {})),
          rule('*', (d) => (/^(bold|bolder)$/.test(d.style.fontWeight) || +d.style.fontWeight >= 600 ? {} : false), { consuming: false }),
        ] }),
        em: mark('em', { toDOM: (m) => ['em', dom(m), 0], parseDOM: [rule('em'), rule('i')] }),
        code: mark('code', { toDOM: (m) => ['code', dom(m), 0], parseDOM: [rule('code')] }),
        strike: mark('strike', { toDOM: (m) => ['s', dom(m), 0], parseDOM: [rule('s'), rule('del'), rule('strike')] }),
        underline: mark('underline', { toDOM: (m) => ['u', dom(m), 0], parseDOM: [rule('u')] }),
        // href only when it is safe; data-href keeps the original either way, so a paste gives back the same link
        link: mark('link', {
          inclusive: false,
          toDOM: (m) => ['a', dom(m, { href: safeHref(m.attrs.href), 'data-href': m.attrs.href == null ? null : String(m.attrs.href) }), 0],
          parseDOM: [rule('a', (d) => { const href = d.hasAttribute('data-href') ? d.getAttribute('data-href') : safeHref(d.getAttribute('href')); return href ? { href } : false; })],
        }),
        textColor: mark('textColor', {
          toDOM: (m) => ['span', dom(m, { class: 'jay-color', 'data-color': m.attrs.color == null ? null : String(m.attrs.color), style: safeColor(m.attrs.color) ? 'color: ' + safeColor(m.attrs.color) : null }), 0],
          parseDOM: [rule('span.jay-color', (d) => (d.hasAttribute('data-color') ? { color: d.getAttribute('data-color') } : false))],
        }),
        // adf: the original ADF mark JSON, or null for the marker that the text had an empty marks array.
        keptMark: {
          attrs: { adf: { default: null } }, excludes: '', inclusive: false,
          toDOM: (m) => ['span', { class: 'jay-kept-mark', 'data-type': m.attrs.adf ? typeOf(m.attrs.adf) : '', 'data-adf': m.attrs.adf ? JSON.stringify(m.attrs.adf) : null }, 0],
          // no data-adf: the empty-marks marker; one that isn't ADF JSON: not a kept mark
          parseDOM: [{ tag: 'span.jay-kept-mark', getAttrs: (d) => { if (!d.hasAttribute('data-adf')) return { adf: null }; const adf = adfOf(d); return adf ? { adf } : false; } }],
        },
      },
    });

    // ---- ADF -> PM ----
    // Modeled attrs present and non-null become PM attrs; everything else the ADF object carries (other attrs, attrs
    // with null values, other top-level keys, a missing content array) goes into `extra`.
    function attrsFrom(j, modeled, skip, trackContent) {
      const attrs = {};
      for (const k of Object.keys(modeled)) attrs[k] = null;
      const extra = {};
      if (j.attrs !== undefined) {
        const rest = {};
        let any = false;
        for (const k of Object.keys(j.attrs)) {
          if (has(modeled, k) && j.attrs[k] != null) { attrs[k] = clone(j.attrs[k]); any = true; } else if (j.attrs[k] !== undefined) rest[k] = clone(j.attrs[k]);
        }
        if (Object.keys(rest).length || !any) extra.attrs = rest;
      }
      const rest = {};
      for (const k of Object.keys(j)) if (!skip.includes(k) && j[k] !== undefined) rest[k] = clone(j[k]);
      if (Object.keys(rest).length) extra.rest = rest;
      if (trackContent && j.content === undefined) extra.noContent = true;
      attrs.extra = Object.keys(extra).length ? extra : null;
      return attrs;
    }

    // The PM mark set for an inline ADF node, or null when its marks cannot be held losslessly.
    function marksFrom(j) {
      if (j.marks === undefined) return [];
      if (!Array.isArray(j.marks)) return null;
      if (!j.marks.length) return [schema.marks.keptMark.create({ adf: null })];
      let set = [];
      const used = new Set();
      for (const m of j.marks) {
        if (!isObj(m)) return null;
        let pm;
        if (EDIT_MARKS.has(m.type) && !used.has(m.type) && (m.attrs === undefined || isObj(m.attrs))) {
          used.add(m.type);
          pm = schema.marks[m.type].create(attrsFrom(m, MARK_ATTRS[m.type] || {}, ['type', 'attrs'], false));
        } else pm = schema.marks.keptMark.create({ adf: clone(m) });
        set = pm.addToSet(set);
      }
      return set.length === j.marks.length ? set : null;
    }

    const atom = (j, inline) => schema.nodes[inline ? 'atomInline' : 'atomBlock'].create({ adf: clone(j) });
    const isAtom = (n) => n.type === schema.nodes.atomBlock || n.type === schema.nodes.atomInline;
    const samples = { true: atom({}, true), false: atom({}, false) };

    function textFrom(j) {
      if (typeof j.text !== 'string' || j.text === '') return null;
      if (Object.keys(j).some((k) => k !== 'type' && k !== 'text' && k !== 'marks')) return null;
      const marks = marksFrom(j);
      return marks && schema.text(j.text, marks);
    }

    // Children of `type`, in the context its content gives them; null if the result is not valid content for it.
    function childrenFrom(type, list) {
      const inline = type.inlineContent;
      const holdsAtoms = type.validContent(Fragment.from(samples[inline]));
      const kids = list.map((c) => {
        const n = convert(c, inline);
        return holdsAtoms && !isAtom(n) && !type.validContent(Fragment.from(n)) ? atom(c, inline) : n;
      });
      const frag = Fragment.fromArray(kids);
      return type.validContent(frag) ? frag : null;
    }

    function convert(j, inline) {
      if (j == null) throw new Error('not an ADF document: a null node');
      if (!isObj(j) || typeof j.type !== 'string') return atom(j, inline);
      if (j.type === 'text') return (inline && textFrom(j)) || atom(j, inline);
      const type = EDIT_NODES.has(j.type) ? schema.nodes[j.type] : null;
      if (!type || type.isInline !== inline) return atom(j, inline);
      if (j.attrs !== undefined && !isObj(j.attrs)) return atom(j, inline);
      if (j.content !== undefined && !Array.isArray(j.content)) return atom(j, inline);
      let marks = [];
      if (inline && !(marks = marksFrom(j))) return atom(j, inline);
      if (type.isLeaf) {
        if (j.content && j.content.length) return atom(j, inline);
        return type.create(attrsFrom(j, NODE_ATTRS[j.type] || {}, inline ? ['type', 'attrs', 'marks'] : ['type', 'attrs'], false), null, marks);
      }
      const kids = childrenFrom(type, j.content || []);
      if (!kids) return atom(j, inline);
      return type.create(attrsFrom(j, NODE_ATTRS[j.type] || {}, inline ? ['type', 'attrs', 'content', 'marks'] : ['type', 'attrs', 'content'], true), kids, marks);
    }

    function fromAdf(adf) {
      const j = adf == null ? { type: 'doc', version: 1, content: [] } : adf;
      if (!isObj(j) || j.type !== 'doc' || (j.content !== undefined && !Array.isArray(j.content)) || (j.attrs !== undefined && !isObj(j.attrs))) {
        throw new Error('not an ADF document');
      }
      const type = schema.nodes.doc;
      const kids = childrenFrom(type, j.content || []);
      if (!kids) throw new Error('not an ADF document');
      return type.create(attrsFrom(j, {}, ['type', 'attrs', 'content'], false), kids);
    }

    // ---- PM -> ADF ----
    function attrsOut(attrs, modeled, extra) {
      let out = extra.attrs ? clone(extra.attrs) : null;
      for (const k of Object.keys(modeled)) if (attrs[k] != null) (out = out || {})[k] = clone(attrs[k]);
      return out;
    }
    function marksOut(marks) {
      if (!marks.length) return null;
      const out = [];
      for (const m of marks) {
        if (m.type === schema.marks.keptMark) { if (m.attrs.adf !== null) out.push(clone(m.attrs.adf)); continue; }
        const extra = m.attrs.extra || {};
        const o = { type: m.type.name, ...(extra.rest ? clone(extra.rest) : {}) };
        const a = attrsOut(m.attrs, MARK_ATTRS[m.type.name] || {}, extra);
        if (a) o.attrs = a;
        out.push(o);
      }
      return out;
    }
    // Nodes Jira requires a localId on, and the attrs it requires alongside.
    const NEEDS_ID = { taskList: {}, taskItem: { state: 'TODO' } };
    function freshId(seen) {
      let id;
      do id = newId(); while (seen.has(id));
      return id;
    }
    // Walks in document order: the first node with a localId keeps it, a later node with the same one (a split or a
    // paste copies attrs) gets a fresh id, and taskList/taskItem always get one.
    function nodeOut(n, seen) {
      if (isAtom(n)) { const adf = clone(n.attrs.adf); collectIds(adf, seen); return adf; }
      if (n.isText) {
        const o = { type: 'text', text: n.text };
        const ms = marksOut(n.marks);
        if (ms) o.marks = ms;
        return o;
      }
      const extra = n.attrs.extra || {};
      const o = { type: n.type.name, ...(extra.rest ? clone(extra.rest) : {}) };
      const a = attrsOut(n.attrs, NODE_ATTRS[n.type.name] || {}, extra);
      if (a) o.attrs = a;
      const needs = NEEDS_ID[n.type.name];
      if (needs) {
        o.attrs = o.attrs || {};
        for (const k of Object.keys(needs)) if (o.attrs[k] == null) o.attrs[k] = needs[k];
        if (o.attrs.localId == null) o.attrs.localId = freshId(seen);
      }
      if (o.attrs && o.attrs.localId != null) {
        if (seen.has(o.attrs.localId)) o.attrs.localId = freshId(seen);
        seen.add(o.attrs.localId);
      }
      if (n.isInline) { const ms = marksOut(n.marks); if (ms) o.marks = ms; }
      if (!n.isLeaf && (n.childCount || !extra.noContent)) {
        o.content = [];
        n.forEach((c) => { o.content.push(nodeOut(c, seen)); });
      }
      return o;
    }
    function toAdf(doc) {
      const o = nodeOut(doc, new Set());
      if (o.version == null) o.version = 1;
      if (!o.content) o.content = [];
      return o;
    }

    return { schema, fromAdf, toAdf };
  }

  if (typeof module === 'object' && module && module.exports) module.exports = { makeAdfPm };
  if (root) root.makeAdfPm = makeAdfPm;
})(typeof window !== 'undefined' ? window : undefined);
