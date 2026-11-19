'use strict';
// The ticket page's ProseMirror side: read-only rendering of ADF, and the editor used for the description and comments
// (history, keymap, lists, input rules, @-mentions; atoms as labeled chips). Loaded after prosemirror.js and adfPm.js,
// before ticket.js, as window.jayEditor. Jira text reaches the DOM only through ProseMirror's serializer and textContent.
(function () {
  const PM = window.PM;
  const { schema, fromAdf, toAdf } = window.makeAdfPm(PM.model);
  const { EditorState, Plugin } = PM.state;
  const { EditorView } = PM.view;
  const { DOMSerializer } = PM.model;
  const { undo, redo, history } = PM.history;
  const { keymap } = PM.keymap;
  const { baseKeymap, toggleMark } = PM.commands;
  const { splitListItem, liftListItem, sinkListItem } = PM.schemaList;
  const { inputRules, wrappingInputRule, textblockTypeInputRule } = PM.inputrules;
  const MEDIA = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---- atoms and mentions ----
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const typeOf = (adf) => (isObj(adf) && typeof adf.type === 'string' ? adf.type : 'unknown');
  function textOf(n) {
    if (!isObj(n)) return '';
    if (typeof n.text === 'string') return n.text;
    return Array.isArray(n.content) ? n.content.map(textOf).join('') : '';
  }
  /** The first non-empty line of text inside an ADF node, shortened. */
  function firstLine(adf) {
    const blocks = isObj(adf) && Array.isArray(adf.content) ? adf.content : [];
    for (const b of blocks) {
      const s = textOf(b).trim().split('\n')[0];
      if (s) return s.length > 60 ? s.slice(0, 59) + '…' : s;
    }
    return '';
  }
  /** A chip (inline) or box (block) labeling an atom; media gets an "Open in Jira" button. */
  function atomDom(adf, inline, onOpenJira) {
    const type = typeOf(adf);
    const dom = el(inline ? 'span' : 'div', 'jay-atom ' + (inline ? 'jay-atom-inline' : 'jay-atom-block'));
    dom.setAttribute('data-type', type);
    dom.setAttribute('contenteditable', 'false');
    if (MEDIA.has(type)) {
      dom.appendChild(document.createTextNode('[image] '));
      const b = el('button', 'open-jira', 'Open in Jira');
      b.type = 'button';
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (onOpenJira) onOpenJira(); });
      dom.appendChild(b);
    } else if (type === 'panel') {
      const line = firstLine(adf);
      dom.textContent = line ? `[panel: ${line}]` : '[panel]';
    } else dom.textContent = `[${type}]`;
    return dom;
  }
  function mentionDom(node, meId) {
    const dom = el('span', 'jay-mention' + (meId && node.attrs.id === meId ? ' me' : ''), node.attrs.text == null ? '@' : String(node.attrs.text));
    dom.setAttribute('contenteditable', 'false');
    return dom;
  }

  // ---- read-only rendering ----
  /** ADF as DOM, through ProseMirror's serializer; never an HTML string. */
  function renderAdf(adf, { meId, onOpenJira } = {}) {
    let doc;
    try { doc = fromAdf(adf); } catch (_) { return el('div', 'jay-unreadable', '[content jay cannot show: Open in Jira]'); }
    const base = DOMSerializer.fromSchema(schema);
    const nodes = Object.assign({}, base.nodes, {
      atomBlock: (n) => atomDom(n.attrs.adf, false, onOpenJira),
      atomInline: (n) => atomDom(n.attrs.adf, true, onOpenJira),
      mention: (n) => mentionDom(n, meId),
    });
    const ser = new DOMSerializer(nodes, base.marks);
    const out = el('div', 'jay-doc');
    out.appendChild(ser.serializeFragment(doc.content, { document }));
    return out;
  }

  // ---- the editor ----
  const isBlank = (doc) => doc.childCount === 1 && doc.firstChild.type === schema.nodes.paragraph && doc.firstChild.content.size === 0;
  function isEmptyDoc(doc) {
    let empty = true;
    doc.descendants((n) => {
      if (!empty) return false;
      if (n.isText) { if (n.text.trim()) empty = false; } else if (n.isLeaf && n.type !== schema.nodes.hardBreak) empty = false;
      return true;
    });
    return empty;
  }

  // Marks never apply to atomInline nodes: their own ADF is emitted unchanged, so a mark on one would be a lie.
  const atomMarks = new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged || t.steps.length)) return null;
      let tr = null;
      state.doc.descendants((n, pos) => {
        if (n.type === schema.nodes.atomInline && n.marks.length) { tr = tr || state.tr; tr.removeMark(pos, pos + n.nodeSize, null); }
      });
      return tr;
    },
  });

  function rules() {
    const n = schema.nodes;
    return inputRules({ rules: [
      wrappingInputRule(/^\s*([-+*])\s$/, n.bulletList),
      wrappingInputRule(/^(\d+)\.\s$/, n.orderedList, (m) => ({ order: Number(m[1]) === 1 ? null : Number(m[1]) }), (m, node) => node.childCount + (node.attrs.order || 1) === Number(m[1])),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (m) => ({ level: m[1].length })),
      textblockTypeInputRule(/^```$/, n.codeBlock),
    ] });
  }

  /** Typing @ (after a space or at the start) opens a user list; picking one inserts a mention node. */
  function mentionPlugin(wrap, searchUsers) {
    let open = null; let list = null; let users = []; let hi = 0; let dismissed = null;
    function close() { open = null; users = []; if (list) { list.remove(); list = null; } }
    function draw(view) {
      if (!list) { list = el('div', 'mention-list'); wrap.appendChild(list); }
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!users.length) { list.appendChild(el('div', 'mention-empty', open && open.searching ? 'Searching…' : 'No one found')); return; }
      users.forEach((u, i) => {
        const b = el('button', i === hi ? 'hi' : '', u.displayName || '');
        b.type = 'button';
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => { e.preventDefault(); pick(view, u); });
        list.appendChild(b);
      });
    }
    function pick(view, u) {
      if (!open) return;
      const { from } = open; const to = view.state.selection.from;
      const node = schema.nodes.mention.create({ id: u.accountId, text: '@' + (u.displayName || '') });
      close();
      view.dispatch(view.state.tr.replaceWith(from, to, [node, schema.text(' ')]).scrollIntoView());
      view.focus();
    }
    function check(view) {
      const sel = view.state.selection;
      if (!sel.empty) { close(); return; }
      const $f = sel.$from;
      if (!$f.parent.inlineContent || $f.parent.type.spec.code) { close(); return; }
      const before = $f.parent.textBetween(Math.max(0, $f.parentOffset - 40), $f.parentOffset, null, '￼');
      const m = /(^|\s)@([^\s@￼]{0,30})$/.exec(before);
      if (!m) { close(); dismissed = null; return; }
      const from = $f.pos - m[2].length - 1; const query = m[2];
      if (dismissed === from) return;
      if (open && open.from === from && open.query === query) return;
      open = { from, query, searching: true }; users = []; hi = 0;
      draw(view);
      const mine = open;
      searchUsers(query, (found) => {
        if (open !== mine) return;
        open.searching = false; users = (found || []).filter((u) => u && u.accountId); hi = 0;
        draw(view);
      });
    }
    return new Plugin({
      view: (view) => ({ update: (v) => check(v), destroy: close }),
      props: {
        handleKeyDown(view, e) {
          if (!open) return false;
          if (e.key === 'Escape') { dismissed = open.from; close(); return true; }
          if (!users.length) return false;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { hi = (hi + (e.key === 'ArrowDown' ? 1 : users.length - 1)) % users.length; draw(view); return true; }
          if (e.key === 'Enter' || e.key === 'Tab') { pick(view, users[hi]); return true; }
          return false;
        },
      },
    });
  }

  /**
   * An editor in `mount` holding `adf` (null: empty).
   * @param o.onSubmit()  Mod-Enter     @param o.onCancel()  Escape     @param o.onChange()  after each change
   * @param o.searchUsers(query, cb)    for @-mentions     @param o.onOpenJira()  a media chip's button
   * @returns { view, toAdf(), isEmpty(), destroy() }
   */
  function createEditor(mount, adf, o = {}) {
    let doc = fromAdf(adf);
    if (doc.childCount === 0) doc = doc.type.create(doc.attrs, schema.nodes.paragraph.create());
    const wrap = el('div', 'jay-editor');
    mount.appendChild(wrap);
    const run = (fn) => () => { if (fn) fn(); return true; };
    const n = schema.nodes;
    const state = EditorState.create({
      doc,
      plugins: [
        mentionPlugin(wrap, o.searchUsers || ((q, cb) => cb([]))),
        rules(),
        keymap({
          'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo,
          'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em),
          'Mod-Enter': run(o.onSubmit), Escape: run(o.onCancel),
          Enter: splitListItem(n.listItem), 'Mod-[': liftListItem(n.listItem), 'Mod-]': sinkListItem(n.listItem),
        }),
        keymap(baseKeymap),
        history(), PM.dropcursor.dropCursor(), PM.gapcursor.gapCursor(), atomMarks,
      ],
    });
    const atomView = (inline) => (node) => {
      const dom = atomDom(node.attrs.adf, inline, o.onOpenJira);
      return { dom, ignoreMutation: () => true, stopEvent: (e) => !!(e.target && e.target.closest && e.target.closest('.open-jira')) };
    };
    const view = new EditorView(wrap, {
      state,
      nodeViews: {
        atomBlock: atomView(false), atomInline: atomView(true),
        mention: (node) => ({ dom: mentionDom(node, null), ignoreMutation: () => true }),
      },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged && o.onChange) o.onChange();
      },
    });
    wrap.pmView = view;
    return {
      view,
      toAdf() {
        const out = toAdf(view.state.doc);
        if (isBlank(view.state.doc)) out.content = [];
        return out;
      },
      isEmpty: () => isEmptyDoc(view.state.doc),
      destroy() { view.destroy(); wrap.remove(); },
    };
  }

  window.jayEditor = { renderAdf, createEditor, el };
})();
