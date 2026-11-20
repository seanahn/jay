'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createEvents } = require('../src/events');
const { createMentions } = require('../src/mentions');

const ME = 'acc-ann';
const ANN = { accountId: ME, displayName: 'Ann Example' };
const BO = { accountId: 'acc-bo', displayName: 'Bo Sample' };
const hit = (id, o = {}) => ({ id, type: 'page', title: `Page ${id}`, spaceKey: 'DEMO', pageId: id, lastModified: '2026-11-20T10:00:00.000Z', by: BO,
  webUrl: `https://example.atlassian.net/wiki/spaces/DEMO/pages/${id}`, ...o });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-men-')), 'seen.json');
function make(file = tmp()) {
  const clock = { t: Date.parse('2026-11-20T12:00:00Z') };
  const events = createEvents({ file, now: () => clock.t });
  return { events, clock, file, mentions: createMentions({ events, meId: ME }) };
}

test('the first observe ever is the baseline: nothing lights', () => {
  const { mentions } = make();
  mentions.observe([hit('1001'), hit('1002')]);
  assert.deepStrictEqual(mentions.list(), []);
  assert.strictEqual(mentions.badge(), 0);
});

test('a new id lights, newest first, with who mentioned me; seen clears it', () => {
  const { mentions, clock } = make();
  mentions.observe([hit('1001')]);
  clock.t += 60000;
  const c = hit('5001', { type: 'comment', title: 'Re: Plan', pageId: '1002', lastModified: '2026-11-20T11:00:00.000Z' });
  mentions.observe([hit('1003', { lastModified: '2026-11-20T11:30:00.000Z' }), c, hit('1001')]);
  assert.deepStrictEqual(mentions.list(), [
    { id: '1003', pageId: '1003', title: 'Page 1003', byName: 'Bo Sample', at: '2026-11-20T11:30:00.000Z', lit: true },
    { id: '5001', pageId: '1002', title: 'Re: Plan', byName: 'Bo Sample', at: '2026-11-20T11:00:00.000Z', lit: true },
  ]);
  assert.strictEqual(mentions.badge(), 2);
  clock.t += 1000; mentions.seen('5001');
  assert.deepStrictEqual(mentions.list().map((m) => m.id), ['1003']);
  assert.strictEqual(mentions.badge(), 1);
  assert.strictEqual(mentions.hit('5001').type, 'comment', 'the hit is still known, for opening it');
});

test('content I wrote or last edited does not light; nor does an edit to a known id', () => {
  const { mentions, clock } = make();
  mentions.observe([hit('1001')]);
  clock.t += 60000;
  mentions.observe([hit('1001', { lastModified: '2026-11-20T11:59:00.000Z', title: 'Edited' }), hit('1004', { by: ANN })]);
  assert.strictEqual(mentions.badge(), 0);
  clock.t += 60000;
  mentions.observe([hit('1004', { by: BO })]);
  assert.strictEqual(mentions.badge(), 0, 'known since it was mine: an edit by someone else does not light it');
});

test('a lit mention stays lit across observes; seen marks it once and a re-observe does not relight', () => {
  const { mentions, clock } = make();
  mentions.observe([]);
  clock.t += 1000; mentions.observe([hit('1005')]);
  clock.t += 1000; mentions.observe([hit('1005')]);
  assert.strictEqual(mentions.badge(), 1);
  clock.t += 1000; mentions.seen('1005');
  clock.t += 1000; mentions.observe([hit('1005', { lastModified: '2026-11-20T12:30:00.000Z' })]);
  assert.strictEqual(mentions.badge(), 0);
});

test('seenPage clears every lit mention on that page, the page and its comments', () => {
  const { mentions, clock } = make();
  mentions.observe([]);
  clock.t += 1000;
  mentions.observe([hit('1006'), hit('5002', { type: 'comment', pageId: '1006' }), hit('1007')]);
  assert.strictEqual(mentions.badge(), 3);
  clock.t += 1000; mentions.seenPage('1006');
  assert.deepStrictEqual(mentions.list().map((m) => m.id), ['1007']);
});

test('the state is kept in seen.json under confluence, and the baseline survives a restart', () => {
  const a = make();
  a.mentions.observe([hit('1001')]);
  a.events.save();
  const raw = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  assert.deepStrictEqual(Object.keys(raw.confluence).sort(), ['baseline', 'known', 'lit', 'seen']);
  assert.ok(raw.confluence.known['1001']);
  const b = make(a.file);
  b.clock.t += 1000;
  b.mentions.observe([hit('1001'), hit('1008')]);
  assert.deepStrictEqual(b.mentions.list().map((m) => m.id), ['1008'], 'not a second baseline');
});

test('two windows on one seen.json: a mention cleared in one does not come back from the other', () => {
  const file = tmp();
  const a = make(file); const b = make(file);
  a.mentions.observe([]); a.events.save();
  a.clock.t += 1000; b.clock.t += 1000;
  a.mentions.observe([hit('1009')]); a.events.save();
  b.mentions.observe([hit('1009')]); b.events.save();
  assert.strictEqual(b.mentions.badge(), 1, 'b sees it lit too: a baseline was already on disk');
  a.clock.t += 1000; a.mentions.seen('1009'); a.events.save();
  b.clock.t += 2000; b.mentions.observe([hit('1009')]); b.events.save();
  assert.strictEqual(b.mentions.badge(), 0, "a's clear reached b");
  a.mentions.observe([hit('1009')]);
  assert.strictEqual(a.mentions.badge(), 0, "b's save did not bring it back");
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.confluence.seen['1009'] >= raw.confluence.lit['1009']);
});
