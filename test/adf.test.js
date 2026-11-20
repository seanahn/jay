'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { normalize, sameAdf, mentionsOf, toText, fromText } = require('../src/adf');
const rich = require('./fixtures/adf-rich.json');

const para = (text, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] });
const doc = (...content) => ({ type: 'doc', version: 1, content });

test('normalize ignores localId and empty attrs', () => {
  const a = doc(para('hi', { localId: 'x1' }), { type: 'taskList', attrs: { localId: 'y' }, content: [{ type: 'taskItem', attrs: { localId: 'z', state: 'DONE' }, content: [{ type: 'text', text: 't' }] }] });
  const b = doc(para('hi'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 't' }] }] });
  assert.deepStrictEqual(normalize(a), normalize(b));
  assert.ok(sameAdf(a, b));
  assert.ok(!sameAdf(a, doc(para('bye'))));
  assert.strictEqual(normalize(rich).content[1].attrs, undefined);
  assert.ok(rich.content[1].attrs.localId, 'input is not mutated');
});
test('normalize sorts marks within a text node', () => {
  const t = (marks) => doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks }] });
  assert.ok(sameAdf(t([{ type: 'strong' }, { type: 'em' }]), t([{ type: 'em' }, { type: 'strong' }])));
  assert.deepStrictEqual(normalize(t([{ type: 'strong' }, { type: 'em' }])).content[0].content[0].marks.map((m) => m.type), ['em', 'strong']);
});
test('sameAdf null vs empty doc', () => {
  assert.ok(sameAdf(null, doc()));
  assert.ok(sameAdf(undefined, { type: 'doc', version: 1 }));
  assert.ok(sameAdf(null, null));
  assert.ok(!sameAdf(null, doc(para('x'))));
});
test('mentionsOf dedupes', () => {
  assert.deepStrictEqual(mentionsOf(rich), ['acc-alex', 'acc-sam']);
  assert.deepStrictEqual(mentionsOf(null), []);
});
test('toText of adf-rich', () => {
  const expected = [
    '## Plan',
    'Hello bold slanted mono gone under red',
    'See the docs (https://example.atlassian.net/wiki/docs).',
    'Ping @Alex Kim and @Sam Lee and @Alex Kim',
    'Ship 🚀 on 2026-11-19 now IN REVIEW\nnext line [inlineCard]',
    '- one\n- two\n  1. a\n  2. b',
    '3. third\n4. fourth',
    '- [ ] write tests\n- [x] ship it',
    '    const a = 1;\n    return a;',
    '> Quoted wisdom',
    '---',
    '[table]',
    '[panel: Heads up]',
    '[expand: More details]',
    '[image]',
    '[macro: demo]',
    '[futureNode]',
    'Tail',
  ].join('\n\n');
  assert.strictEqual(toText(rich), expected);
  assert.strictEqual(toText(null), '');
});
test('fromText splits paragraphs on blank lines', () => {
  assert.deepStrictEqual(fromText('one\ntwo\n\n\nthree'), doc(
    { type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
    para('three')));
  assert.deepStrictEqual(fromText(''), doc());
  assert.strictEqual(toText(fromText('a\nb\n\nc')), 'a\nb\n\nc');
});
test('sameAdf ignores object key order', () => {
  const a = { type: 'doc', version: 1, content: [{ type: 'heading', attrs: { level: 2, x: 1 }, content: [{ type: 'text', text: 'h' }] }] };
  const b = { content: [{ content: [{ text: 'h', type: 'text' }], attrs: { x: 1, level: 2 }, type: 'heading' }], version: 1, type: 'doc' };
  assert.ok(sameAdf(a, b));
});
test('sameAdf is false for real differences', () => {
  const task = (state) => doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { state }, content: [{ type: 'text', text: 't' }] }] });
  assert.ok(!sameAdf(task('TODO'), task('DONE')));
  const txt = (marks) => doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', ...(marks ? { marks } : {}) }] });
  const link = (href) => txt([{ type: 'link', attrs: { href } }]);
  assert.ok(!sameAdf(link('https://example.atlassian.net/a'), link('https://example.atlassian.net/b')));
  const head = (level) => doc({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'h' }] });
  assert.ok(!sameAdf(head(1), head(2)));
  const men = (id) => doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { id, text: '@A' } }] });
  assert.ok(!sameAdf(men('acc-alex'), men('acc-sam')));
  assert.ok(!sameAdf(txt(), txt([{ type: 'strong' }])));
  assert.ok(!sameAdf(txt([{ type: 'strong' }]), txt([{ type: 'strong' }, { type: 'em' }])));
});
test('toText survives a date without a usable timestamp', () => {
  const d = (attrs) => doc({ type: 'paragraph', content: [{ type: 'text', text: 'on ' }, { type: 'date', ...(attrs ? { attrs } : {}) }] });
  assert.strictEqual(toText(d()), 'on [date]');
  assert.strictEqual(toText(d({ timestamp: 'soon' })), 'on [date]');
  assert.strictEqual(toText(d({ timestamp: '' })), 'on [date]');
  assert.strictEqual(toText(d({ timestamp: '1795131000000' })), 'on 2026-11-19');
});

test('normalize merges adjacent text with identical marks', () => {
  const p = (...content) => doc({ type: 'paragraph', content });
  const s = [{ type: 'strong' }, { type: 'em' }];
  assert.ok(sameAdf(p({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }), p({ type: 'text', text: 'ab' })));
  assert.ok(sameAdf(p({ type: 'text', text: 'a', marks: s }, { type: 'text', text: 'b', marks: [s[1], s[0]] }), p({ type: 'text', text: 'ab', marks: s })));
  assert.ok(!sameAdf(p({ type: 'text', text: 'a', marks: [s[0]] }, { type: 'text', text: 'b' }), p({ type: 'text', text: 'ab' })));
  assert.ok(!sameAdf(p({ type: 'text', text: 'a', marks: [s[0]] }, { type: 'text', text: 'b', marks: [s[1]] }), p({ type: 'text', text: 'ab', marks: [s[0]] })));
  const input = p({ type: 'text', text: 'a' }, { type: 'text', text: 'b' });
  normalize(input);
  assert.strictEqual(input.content[0].content.length, 2, 'input is not mutated');
});
