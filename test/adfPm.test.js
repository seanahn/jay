'use strict';
const test = require('node:test'); const assert = require('node:assert');
const model = require('prosemirror-model');
const { EditorState, TextSelection } = require('prosemirror-state');
const { splitBlock } = require('prosemirror-commands');
const { makeAdfPm } = require('../media/adfPm');
const { sameAdf } = require('../src/adf');
const rich = require('./fixtures/adf-rich.json');

const { schema, fromAdf, toAdf } = makeAdfPm(model);
const clone = (x) => JSON.parse(JSON.stringify(x));
const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const roundTrip = (x) => toAdf(fromAdf(x));
function hasUndefined(v) {
  if (Array.isArray(v)) return v.some(hasUndefined);
  if (v && typeof v === 'object') return Object.keys(v).some((k) => v[k] === undefined || hasUndefined(v[k]));
  return v === undefined;
}
// Position of the nth top-level child of a PM doc.
function topPos(pmDoc, index) { let pos = 0; for (let i = 0; i < index; i++) pos += pmDoc.child(i).nodeSize; return pos; }

test('round trip of adf-rich equals the input under sameAdf', () => {
  const input = clone(rich);
  const out = roundTrip(input);
  assert.ok(sameAdf(out, rich), JSON.stringify(out));
  assert.deepStrictEqual(input, rich, 'input is not mutated');
  assert.ok(!hasUndefined(out), 'no undefined values');
  fromAdf(rich).check();
});

test('round trip keeps localIds and empty attrs exactly', () => {
  const out = roundTrip(rich);
  assert.deepStrictEqual(out.content[1].attrs, { localId: 'p-1' });
  assert.deepStrictEqual(out.content[7].attrs, { localId: 'tl-1' });
  assert.deepStrictEqual(out.content[7].content[1].attrs, { localId: 'ti-2', state: 'DONE' });
  assert.deepStrictEqual(out.content[4].content[5].attrs, { text: 'IN REVIEW', color: 'blue', localId: 'st-1' });
  assert.deepStrictEqual(out.content[3].content[1].attrs, { id: 'acc-alex', text: '@Alex Kim', accessLevel: '' });
  assert.deepStrictEqual(out.content[out.content.length - 1], rich.content[rich.content.length - 1]);
});

test('unknown nodes survive an edit elsewhere in the document', () => {
  const pmDoc = fromAdf(rich);
  const state = EditorState.create({ schema, doc: pmDoc });
  const tr = state.tr.insertText('Well, ', topPos(pmDoc, 1) + 1);
  const out = toAdf(state.apply(tr).doc);
  assert.strictEqual(out.content[1].content[0].text, 'Well, Hello ');
  for (const type of ['table', 'panel', 'futureNode', 'expand', 'mediaSingle', 'extension']) {
    assert.deepStrictEqual(out.content.find((n) => n.type === type), rich.content.find((n) => n.type === type), type);
  }
  assert.deepStrictEqual(out.content[4].content[9], rich.content[4].content[9], 'inline card');
});

test('deleting an atom removes exactly that node', () => {
  const pmDoc = fromAdf(rich);
  const i = rich.content.findIndex((n) => n.type === 'table');
  const at = topPos(pmDoc, i);
  assert.strictEqual(pmDoc.child(i).type.name, 'atomBlock');
  const state = EditorState.create({ schema, doc: pmDoc });
  const out = toAdf(state.apply(state.tr.delete(at, at + pmDoc.child(i).nodeSize)).doc);
  const expected = clone(rich); expected.content.splice(i, 1);
  assert.ok(sameAdf(out, expected));
  assert.strictEqual(out.content.length, rich.content.length - 1);
});

test('a mention created by the schema serializes to ADF mention attrs id and text', () => {
  const m = schema.nodes.mention.create({ id: 'acc-new', text: '@New Person' });
  const out = toAdf(schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hi '), m])]));
  assert.deepStrictEqual(out, doc(para(text('hi '), { type: 'mention', attrs: { id: 'acc-new', text: '@New Person' } })));
});

test('new nodes made by the schema emit no undefined or null attrs', () => {
  const s = schema;
  const pm = s.node('doc', null, [
    s.node('heading', null, [s.text('T')]),
    s.node('orderedList', null, [s.node('listItem', null, [s.node('paragraph', null, [s.text('x', [s.marks.link.create({ href: 'https://example.atlassian.net' })])])])]),
    s.node('taskList', null, [s.node('taskItem', null, [s.text('do')])]),
    s.node('codeBlock', null, [s.text('c')]),
    s.node('paragraph'),
  ]);
  let n = 0;
  const { toAdf: toAdfIds } = makeAdfPm(model, { newId: () => 'id-' + ++n });
  assert.deepStrictEqual(toAdfIds(pm), doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('T')] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('x', [{ type: 'link', attrs: { href: 'https://example.atlassian.net' } }]))] }] },
    { type: 'taskList', attrs: { localId: 'id-1' }, content: [{ type: 'taskItem', attrs: { state: 'TODO', localId: 'id-2' }, content: [text('do')] }] },
    { type: 'codeBlock', content: [text('c')] },
    { type: 'paragraph', content: [] },
  ));
});

test('unknown marks, duplicate marks and unknown mark attrs are kept', () => {
  const input = doc(para(
    text('a', [{ type: 'annotation', attrs: { id: 'n1', annotationType: 'inlineComment' } }, { type: 'strong' }, { type: 'annotation', attrs: { id: 'n2', annotationType: 'inlineComment' } }]),
    text('b', [{ type: 'link', attrs: { href: 'https://example.atlassian.net/x', title: 'X' } }, { type: 'strong', attrs: {} }]),
    text('c', [{ type: 'textColor', attrs: { color: '#00ff00' } }, { type: 'textColor', attrs: { color: '#0000ff' } }]),
    text('d', []),
  ));
  const out = roundTrip(input);
  assert.ok(sameAdf(out, input), JSON.stringify(out));
  assert.deepStrictEqual(out.content[0].content[0].marks.filter((m) => m.type === 'annotation'), input.content[0].content[0].marks.filter((m) => m.type === 'annotation'));
  assert.deepStrictEqual(out.content[0].content[3], text('d', []));
  const pm = fromAdf(input);
  assert.strictEqual(pm.child(0).child(0).marks.filter((m) => m.type.name === 'keptMark').length, 2);
});

test('atoms follow their context: inline in a paragraph, block at the top', () => {
  const card = { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/browse/DEMO-3' } };
  const pm = fromAdf(doc(card, para(text('x '), card)));
  assert.strictEqual(pm.child(0).type.name, 'atomBlock');
  assert.strictEqual(pm.child(1).child(1).type.name, 'atomInline');
  assert.deepStrictEqual(toAdf(pm), doc(card, para(text('x '), card)));
});

test('editable nodes in positions the schema cannot hold become atoms, whole', () => {
  const strayText = text('loose');
  const paraInList = { type: 'bulletList', content: [para(text('not in a listItem'))] };
  const headingInPara = para(text('a'), { type: 'heading', attrs: { level: 1 }, content: [text('h')] });
  const markedCode = { type: 'codeBlock', content: [text('x', [{ type: 'strong' }])] };
  const nested = { type: 'blockquote', content: [para(text('q')), paraInList] };
  const weird = { type: 'paragraph', attrs: 'oops', content: [] };
  const emptyText = para(text(''));
  const input = doc(strayText, paraInList, headingInPara, markedCode, nested, weird, emptyText, 42);
  const pm = fromAdf(input);
  pm.check();
  assert.deepStrictEqual(pm.content.content.map((n) => n.type.name), ['atomBlock', 'atomBlock', 'paragraph', 'atomBlock', 'blockquote', 'atomBlock', 'paragraph', 'atomBlock']);
  assert.strictEqual(pm.child(2).child(1).type.name, 'atomInline');
  assert.strictEqual(pm.child(4).child(1).type.name, 'atomBlock');
  assert.deepStrictEqual(toAdf(pm), input);
});

test('block marks, unknown keys, missing content and the document version survive', () => {
  const input = {
    type: 'doc', version: 2,
    content: [
      { type: 'paragraph', marks: [{ type: 'alignment', attrs: { align: 'center' } }], content: [text('mid')] },
      { type: 'paragraph' },
      { type: 'codeBlock', attrs: { language: null }, content: [] },
      { type: 'rule', attrs: {} },
      para({ type: 'hardBreak', attrs: { text: '\n' } }, { type: 'mention', attrs: { id: 'acc-z', text: '@Z' }, marks: [{ type: 'annotation', attrs: { id: 'n3' } }] }),
    ],
  };
  assert.deepStrictEqual(roundTrip(input), input);
  assert.deepStrictEqual(roundTrip({ type: 'doc', content: [] }), doc());
  assert.deepStrictEqual(roundTrip(null), doc());
});

test('atoms are emitted from their own copy of the JSON', () => {
  const input = clone(rich);
  const pm = fromAdf(input);
  input.content[11].attrs.layout = 'changed';
  const out = toAdf(pm);
  assert.strictEqual(out.content[11].attrs.layout, 'default');
  out.content[11].attrs.layout = 'again';
  assert.strictEqual(toAdf(pm).content[11].attrs.layout, 'default');
});

test('works as a page global', () => {
  const src = require('fs').readFileSync(require.resolve('../media/adfPm'), 'utf8');
  const window = {};
  new Function('window', 'module', src)(window, undefined);
  assert.strictEqual(typeof window.makeAdfPm, 'function');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require in the page file');
});

function localIds(adf) {
  const ids = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (v.attrs && v.attrs.localId != null) ids.push(v.attrs.localId); walk(v.content); }
  })(adf);
  return ids;
}
// Position just after the first occurrence of `needle` in text.
function posAfter(pmDoc, needle) {
  let found = null;
  pmDoc.descendants((node, pos) => {
    if (found == null && node.isText && node.text.includes(needle)) found = pos + node.text.indexOf(needle) + needle.length;
  });
  return found;
}

test('splitting a taskItem and a paragraph emits unique localIds', () => {
  let n = 0;
  const api = makeAdfPm(model, { newId: () => 'fresh-' + ++n });
  let state = EditorState.create({ schema: api.schema, doc: api.fromAdf(rich) });
  for (const needle of ['write', 'Hello']) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posAfter(state.doc, needle))));
    assert.ok(splitBlock(state, (tr) => { state = state.apply(tr); }), 'split ' + needle);
  }
  const out = api.toAdf(state.doc);
  const ids = localIds(out);
  assert.strictEqual(new Set(ids).size, ids.length, JSON.stringify(ids));
  // The first node in document order keeps the original id; the later copy gets a fresh one.
  assert.deepStrictEqual(out.content[1].attrs, { localId: 'p-1' });
  assert.strictEqual(out.content[2].attrs.localId.startsWith('fresh-'), true);
  const items = out.content[8].content;
  assert.deepStrictEqual(items.map((i) => i.content[0].text), ['write', ' tests', 'ship it']);
  assert.strictEqual(items[0].attrs.localId, 'ti-1');
  assert.ok(items[1].attrs.localId.startsWith('fresh-'));
  assert.strictEqual(items[1].attrs.state, 'TODO');
  // Ids inside atoms count as taken but atoms are never rewritten.
  assert.deepStrictEqual(out.content.find((x) => x.type === 'futureNode'), rich.content.find((x) => x.type === 'futureNode'));
});

test('the default id generator gives UUID-shaped unique ids', () => {
  const { schema: s, toAdf: t } = makeAdfPm(model);
  const out = t(s.node('doc', null, [s.node('taskList', null, [s.node('taskItem', null, [s.text('a')]), s.node('taskItem', null, [s.text('b')])])]));
  const ids = localIds(out);
  assert.strictEqual(ids.length, 3);
  assert.strictEqual(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a taskItem missing state gets TODO', () => {
  const input = doc({ type: 'taskList', attrs: { localId: 'l' }, content: [{ type: 'taskItem', attrs: { localId: 'i' }, content: [text('x')] }] });
  assert.deepStrictEqual(roundTrip(input).content[0].content[0].attrs, { localId: 'i', state: 'TODO' });
});

test('an atom cannot be created without its original ADF', () => {
  assert.throws(() => schema.nodes.atomBlock.create());
  assert.throws(() => schema.nodes.atomInline.create());
  assert.throws(() => schema.nodes.atomBlock.create({ adf: null }));
  assert.throws(() => fromAdf(doc(para(text('a')), null)), /not an ADF document/);
});

// ---- the clipboard: copy and paste inside the editor, through the page's own ProseMirror bundle in jsdom ----
const { JSDOM } = require('jsdom');
const readMedia = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'media', f), 'utf8');
function clipboard() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(readMedia('prosemirror.js')); w.eval(readMedia('adfPm.js'));
  const pm = w.makeAdfPm(w.PM.model);
  const view = new w.PM.view.EditorView(w.document.body.appendChild(w.document.createElement('div')),
    { state: w.PM.state.EditorState.create({ schema: pm.schema, doc: pm.fromAdf(null) }) });
  /** Pastes html (as the clipboard has it) into an empty document; returns the ADF. */
  function paste(html, text = '') {
    view.updateState(w.PM.state.EditorState.create({ schema: pm.schema, doc: pm.fromAdf(null) }));
    const slice = w.PM.view.__parseFromClipboard(view, text, html, false, view.state.doc.resolve(0));
    view.dispatch(view.state.tr.replaceSelection(slice));
    return JSON.parse(JSON.stringify(pm.toAdf(view.state.doc)));
  }
  /** Copies the whole of adf, as the editor would put it on the clipboard. */
  function copy(adf) {
    view.updateState(w.PM.state.EditorState.create({ schema: pm.schema, doc: pm.fromAdf(adf) }));
    const d = view.state.doc;
    const { dom: html, text } = view.serializeForClipboard(d.slice(0, d.content.size));
    return { html: html.innerHTML, text, dom: html };
  }
  return { w, pm, copy, paste };
}
const types = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => types(x, out));
  else if (v && typeof v === 'object') { if (typeof v.type === 'string') out.add(v.type); types(v.content, out); types(v.marks, out); }
  return out;
};

test('copy and paste in the editor keeps atoms, mentions and marks', () => {
  const c = clipboard();
  const input = doc(
    { type: 'table', attrs: { layout: 'default' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('cell'))] }] }] },
    para(text('Ping '), { type: 'mention', attrs: { id: 'acc-alex', text: '@Alex Kim', accessLevel: '' } }, text(' see '),
      { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/browse/DEMO-9' } }, text(' '),
      text('bold', [{ type: 'strong' }]), text(' and '), text('a link', [{ type: 'link', attrs: { href: 'https://example.atlassian.net/wiki' } }]), text(' '),
      text('noted', [{ type: 'annotation', attrs: { id: 'ann-1', annotationType: 'inlineComment' } }]), text(' '),
      { type: 'date', attrs: { timestamp: '1798761600000' } }, text(' '), { type: 'status', attrs: { text: 'DONE', color: 'green', localId: 'st-9' } },
      text(' '), { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }),
  );
  const out = c.paste(c.copy(input).html);
  assert.ok(sameAdf(out, input), JSON.stringify(out));
});

test('copy and paste of the whole rich fixture comes back the same', () => {
  const c = clipboard();
  const out = c.paste(c.copy(rich).html);
  assert.ok(sameAdf(out, rich), JSON.stringify(out));
});

test('the copied HTML is safe: atoms and mentions render as text, their ADF rides in attributes', () => {
  const c = clipboard();
  const { dom } = c.copy(doc(para({ type: 'mention', attrs: { id: 'acc-x', text: '<img src=x onerror="window.pwned=1">' } })));
  assert.strictEqual(dom.querySelector('img'), null);
  assert.strictEqual(dom.querySelector('.jay-mention').textContent, '<img src=x onerror="window.pwned=1">');
});

test('pasted HTML whose data-adf is not ADF JSON makes no atom', () => {
  const c = clipboard();
  const out = c.paste('<div class="jay-atom" data-type="table" data-adf="{not json">[table]</div>'
    + '<div class="jay-atom" data-adf="&quot;just a string&quot;">[x]</div>'
    + '<p>a <span class="jay-atom" data-adf="[1,2]">[y]</span> <span class="jay-atom">[z]</span> '
    + '<span class="jay-kept-mark" data-adf="nope">kept</span></p>');
  const t = types(out);
  for (const bad of ['table', 'unknown']) assert.ok(!t.has(bad), bad + ' in ' + JSON.stringify(out));
  assert.deepStrictEqual([...t].sort(), ['doc', 'paragraph', 'text']);
});

test('pasting Google Docs\' wrapper <b style="font-weight:normal"> is not bold, a real bold still is', () => {
  const c = clipboard();
  const marksOf = (o) => JSON.stringify(o);
  assert.ok(!marksOf(c.paste('<b style="font-weight:normal"><p>x</p></b>')).includes('strong'));
  assert.ok(!marksOf(c.paste('<b style="font-weight:normal" id="docs-internal-guid-1"><span>x</span></b>')).includes('strong'));
  assert.ok(marksOf(c.paste('<p>a <b>x</b></p>')).includes('strong'));
  assert.ok(marksOf(c.paste('<p><span style="font-weight:700">x</span></p>')).includes('strong'));
  assert.ok(!marksOf(c.paste('<p><span style="font-weight:400">x</span></p>')).includes('strong'));
});
