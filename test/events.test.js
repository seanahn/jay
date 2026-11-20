'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createEvents } = require('../src/events');

const ME = 'acc-me';
const T0 = Date.parse('2026-11-10T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (...c) => ({ type: 'paragraph', content: c });
const text = (t) => ({ type: 'text', text: t });
const mention = (id) => ({ type: 'mention', attrs: { id, text: '@x' } });
const issue = (key, description = null) => ({ key, description });
const comment = (id, who, created, body) => ({ id, author: { accountId: who, displayName: who }, created: iso(created), body });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-ev-')), 'seen.json');
function make(file = tmp()) {
  const clock = { t: T0 };
  const ev = createEvents({ file, now: () => clock.t });
  return { ev, clock, file };
}
const mineOf = (...k) => ({ meId: ME, mineKeys: new Set(k) });

test('old comments at first observation do not light up', () => {
  const { ev } = make();
  ev.observe(issue('DEMO-1'), [comment('1', 'acc-bob', T0 - 1000, doc(para(mention(ME))))], mineOf('DEMO-1'));
  assert.deepStrictEqual(ev.state('DEMO-1'), { mention: false, comment: false, newEpic: false });
  assert.strictEqual(ev.badge(), 0);
});

test('a new comment mentioning me sets mention; seen clears it', () => {
  const { ev, clock } = make();
  ev.observe(issue('DEMO-1'), [], mineOf());
  clock.t += 5000;
  const c = comment('1', 'acc-bob', clock.t - 1000, doc(para(text('hi '), mention(ME))));
  ev.observe(issue('DEMO-1'), [c], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, true);
  clock.t += 1000; ev.seen('DEMO-1');
  assert.strictEqual(ev.state('DEMO-1').mention, false);
  ev.observe(issue('DEMO-1'), [c], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, false, 'the same comment does not light up again');
});

test('a new comment on my ticket sets comment; on another\'s ticket nothing', () => {
  const { ev, clock } = make();
  ev.observe(issue('DEMO-1'), [], mineOf('DEMO-1')); ev.observe(issue('DEMO-2'), [], mineOf('DEMO-1'));
  clock.t += 5000;
  const c = comment('1', 'acc-bob', clock.t - 1000, doc(para(text('plain'))));
  ev.observe(issue('DEMO-1'), [c], mineOf('DEMO-1')); ev.observe(issue('DEMO-2'), [c], mineOf('DEMO-1'));
  assert.deepStrictEqual(ev.state('DEMO-1'), { mention: false, comment: true, newEpic: false });
  assert.deepStrictEqual(ev.state('DEMO-2'), { mention: false, comment: false, newEpic: false });
});

test('my own comment sets nothing', () => {
  const { ev, clock } = make();
  ev.observe(issue('DEMO-1'), [], mineOf('DEMO-1'));
  clock.t += 5000;
  ev.observe(issue('DEMO-1'), [comment('1', ME, clock.t - 1000, doc(para(mention(ME))))], mineOf('DEMO-1'));
  assert.strictEqual(ev.badge(), 0);
});

test('description mention appears: mention', () => {
  const { ev } = make();
  ev.observe(issue('DEMO-1', doc(para(text('no one')))), [], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, false);
  ev.observe(issue('DEMO-1', doc(para(mention(ME)))), [], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, true);
  const { ev: ev2 } = make();
  ev2.observe(issue('DEMO-2', doc(para(mention(ME)))), [], mineOf());
  assert.strictEqual(ev2.state('DEMO-2').mention, false, 'a mention present at first sight is not new');
});

test('first observeEpics is the baseline; a later new key is newEpic', () => {
  const { ev } = make();
  ev.observeEpics('all', ['DEMO-1', 'DEMO-2']);
  assert.strictEqual(ev.state('DEMO-1').newEpic, false);
  ev.observeEpics('all', ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  assert.strictEqual(ev.state('DEMO-3').newEpic, true);
  assert.strictEqual(ev.state('DEMO-1').newEpic, false);
  ev.observeEpics('all', ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  assert.strictEqual(ev.state('DEMO-3').newEpic, true);
  ev.seen('DEMO-3');
  assert.strictEqual(ev.state('DEMO-3').newEpic, false);
  ev.observeEpics('mine', ['DEMO-9']);
  assert.strictEqual(ev.state('DEMO-9').newEpic, false, 'each view has its own baseline');
});

test('rollup carries up; badge counts mention and comment, not newEpic', () => {
  const { ev, clock } = make();
  ev.observe(issue('DEMO-2'), [], mineOf('DEMO-2')); ev.observe(issue('DEMO-3'), [], mineOf('DEMO-2'));
  ev.observeEpics('all', ['DEMO-1']); ev.observeEpics('all', ['DEMO-1', 'DEMO-8']);
  clock.t += 5000;
  ev.observe(issue('DEMO-2'), [comment('1', 'acc-bob', clock.t - 1, doc(para(text('x'))))], mineOf('DEMO-2'));
  ev.observe(issue('DEMO-3'), [comment('2', 'acc-bob', clock.t - 1, doc(para(mention(ME))))], mineOf('DEMO-2'));
  const leaf = { key: 'DEMO-3', children: [] };
  const mid = { key: 'DEMO-2', children: [leaf] };
  const top = { key: 'DEMO-1', children: [mid] };
  assert.deepStrictEqual(ev.rollup(top), { mention: true, bold: true });
  assert.deepStrictEqual(ev.rollup(mid), { mention: true, bold: true });
  assert.deepStrictEqual(ev.rollup({ key: 'DEMO-2', children: [] }), { mention: false, bold: true });
  assert.deepStrictEqual(ev.rollup({ key: 'DEMO-5', children: [] }), { mention: false, bold: false });
  assert.strictEqual(ev.badge(), 2);
  assert.deepStrictEqual(ev.rollup({ key: 'DEMO-8', children: [] }), { mention: false, bold: true });
});

test('state survives a new createEvents on the same file', () => {
  const { ev, clock, file } = make();
  ev.observe(issue('DEMO-1'), [], mineOf('DEMO-1'));
  ev.observeEpics('all', ['DEMO-1']);
  clock.t += 5000;
  ev.observe(issue('DEMO-1'), [comment('1', 'acc-bob', clock.t - 1, doc(para(text('x'))))], mineOf('DEMO-1'));
  ev.observeEpics('all', ['DEMO-1', 'DEMO-4']);
  ev.save();
  const ev2 = createEvents({ file, now: () => clock.t });
  assert.strictEqual(ev2.state('DEMO-1').comment, true);
  assert.strictEqual(ev2.state('DEMO-4').newEpic, true);
  ev2.observeEpics('all', ['DEMO-1', 'DEMO-4', 'DEMO-5']);
  assert.strictEqual(ev2.state('DEMO-5').newEpic, true, 'the baseline persisted too');
  assert.strictEqual(createEvents({ file: path.join(os.tmpdir(), 'jay-nope', 'x.json') }).badge(), 0);
});

test('save is atomic and mode 600 in a 700 dir', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-ev-')), 'home');
  const { ev } = make(path.join(dir, 'seen.json'));
  ev.observe(issue('DEMO-1'), [], mineOf()); ev.save();
  assert.strictEqual(fs.statSync(path.join(dir, 'seen.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepStrictEqual(fs.readdirSync(dir), ['seen.json']);
});

test('two windows on one file: a clear in one survives the other\'s save', () => {
  const file = tmp(); const clock = { t: T0 };
  const mk = () => createEvents({ file, now: () => clock.t });
  const a = mk(); const b = mk();
  a.observe(issue('DEMO-1'), [], mineOf()); b.observe(issue('DEMO-1'), [], mineOf());
  clock.t += 5000;
  const c = comment('1', 'acc-bob', clock.t - 1000, doc(para(mention(ME))));
  a.observe(issue('DEMO-1'), [c], mineOf()); b.observe(issue('DEMO-1'), [c], mineOf());
  assert.strictEqual(b.state('DEMO-1').mention, true);
  clock.t += 1000; a.seen('DEMO-1'); a.save(); b.save();
  assert.strictEqual(mk().state('DEMO-1').mention, false);
  assert.strictEqual(b.state('DEMO-1').mention, false);
  assert.strictEqual(b.badge(), 0);
  a.observeEpics('all', ['DEMO-1']); a.save(); b.observeEpics('all', ['DEMO-1', 'DEMO-7']); b.save();
  a.observeEpics('all', ['DEMO-1', 'DEMO-7', 'DEMO-8']); a.save();
  assert.strictEqual(mk().state('DEMO-7').newEpic, true, 'epic sets are unioned');
});

test('two windows: a cleared description mention does not light up again', () => {
  const file = tmp(); const clock = { t: T0 };
  const mk = () => createEvents({ file, now: () => clock.t });
  const a = mk(); const b = mk();
  a.observe(issue('DEMO-1', doc(para(text('none')))), [], mineOf()); a.save(); b.observe(issue('DEMO-1', doc(para(text('none')))), [], mineOf());
  clock.t += 5000;
  const withMention = { ...issue('DEMO-1', doc(para(mention(ME)))), updated: iso(clock.t - 1000) };
  a.observe(withMention, [], mineOf());
  assert.strictEqual(a.state('DEMO-1').mention, true);
  clock.t += 1000; a.seen('DEMO-1'); a.save();
  clock.t += 1000; b.observe(withMention, [], mineOf());
  assert.strictEqual(b.state('DEMO-1').mention, false);
  b.save();
  assert.strictEqual(mk().state('DEMO-1').mention, false);
});

test('two windows: a cleared new epic does not light up again', () => {
  const file = tmp(); const clock = { t: T0 };
  const mk = () => createEvents({ file, now: () => clock.t });
  const a = mk(); const b = mk();
  a.observeEpics('all', ['DEMO-1']); a.save(); b.observeEpics('all', ['DEMO-1']);
  clock.t += 1000; a.observeEpics('all', ['DEMO-1', 'DEMO-2']); assert.strictEqual(a.state('DEMO-2').newEpic, true);
  clock.t += 1000; a.seen('DEMO-2'); a.save();
  clock.t += 1000; b.observeEpics('all', ['DEMO-1', 'DEMO-2']);
  assert.strictEqual(b.state('DEMO-2').newEpic, false);
  b.save(); assert.strictEqual(mk().state('DEMO-2').newEpic, false);
});

test('a removed description mention persists, and a re-added one lights', () => {
  const { ev, clock, file } = make();
  const d = (m, u) => ({ ...issue('DEMO-1', doc(para(m ? mention(ME) : text('none')))), updated: iso(u) });
  ev.observe(d(true, T0), [], mineOf()); ev.save();
  clock.t += 1000; ev.observe(d(false, T0 + 500), [], mineOf()); ev.save();
  assert.strictEqual(ev.state('DEMO-1').mention, false);
  clock.t += 1000; ev.observe(d(true, T0 + 1500), [], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, true);
  ev.save();
  assert.strictEqual(createEvents({ file, now: () => clock.t }).state('DEMO-1').mention, true);
});

test('description: an old mention never lights; one added after the baseline does; undefined says nothing', () => {
  const { ev, clock } = make();
  const mentioning = doc(para(mention(ME)));
  // already mentioning me at the first read: the baseline, so a later unrelated update doesn't light it
  ev.observe({ key: 'DEMO-1', description: mentioning, updated: iso(T0 - 1000) }, [], mineOf());
  clock.t = T0 + 60000;
  ev.observe({ key: 'DEMO-1', description: mentioning, updated: iso(T0 + 30000) }, [], mineOf());
  assert.strictEqual(ev.state('DEMO-1').mention, false);
  // not mentioning at the baseline, mentioning later: lights
  ev.observe({ key: 'DEMO-2', description: doc(para(text('hi'))), updated: iso(T0) }, [], mineOf());
  ev.observe({ key: 'DEMO-2', description: undefined, updated: iso(T0 + 1000) }, [], mineOf());   // read without it: no change
  ev.observe({ key: 'DEMO-2', description: mentioning, updated: iso(T0 + 50000) }, [], mineOf());
  assert.strictEqual(ev.state('DEMO-2').mention, true);
  // first read only without a description, then with a mention: that read is the baseline, so it stays dark
  ev.observe({ key: 'DEMO-3', description: undefined, updated: iso(T0) }, [], mineOf());
  clock.t = T0 + 120000;
  ev.observe({ key: 'DEMO-3', description: mentioning, updated: iso(T0 + 100000) }, [], mineOf());   // changed since the baseline
  assert.strictEqual(ev.state('DEMO-3').mention, false);
});

test('the confluence section: known is a union, lit and seen take the max, and the earliest baseline wins', () => {
  const file = tmp(); const clock = { t: T0 };
  const mk = () => createEvents({ file, now: () => clock.t });
  const a = mk(); const b = mk();
  Object.assign(a.conf(), { baseline: T0, known: { 1001: T0 }, lit: { 1001: T0 + 10 }, seen: {} }); a.save();
  const cb = b.conf();
  assert.strictEqual(cb.baseline, T0, 'merged from disk on access');
  cb.known['1002'] = T0 + 5; cb.lit['1002'] = T0 + 5; cb.seen['1001'] = T0 + 20; b.save();
  a.conf().lit['1001'] = T0 + 10; a.save();
  const c = mk().conf();
  assert.deepStrictEqual(Object.keys(c.known).sort(), ['1001', '1002']);
  assert.strictEqual(c.seen['1001'], T0 + 20, "b's clear survives a's later save");
  assert.strictEqual(c.lit['1002'], T0 + 5);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw).sort(), ['confluence', 'newEpics', 'tickets', 'views']);
  assert.strictEqual(a.badge(), 0, "the Jira badge doesn't count Confluence");
});

test('a seen.json without a confluence section starts one with no baseline', () => {
  const { ev } = make();
  assert.deepStrictEqual(ev.conf(), { baseline: null, known: {}, lit: {}, seen: {} });
});
