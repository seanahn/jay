'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { createPoller, UNFOCUSED_FACTOR, BACKOFF_START_MS, BACKOFF_MAX_MS } = require('../src/poller');

/** Timers the test fires by hand: `delays` records what was asked for, `fire()` runs the pending one. */
function fakeTimers() {
  const t = { delays: [], pending: null, set(fn, ms) { t.delays.push(ms); t.pending = fn; return ms; }, clear() { t.pending = null; }, async fire() { const f = t.pending; t.pending = null; await f(); } };
  return t;
}
/** An HTTP failure as the Jira client will raise it: a status and an optional Retry-After in ms. */
function httpError(status, retryAfterMs) { return Object.assign(new Error('HTTP ' + status), { status, retryAfterMs }); }
const settle = () => new Promise((r) => setImmediate(r));

test('constants', () => { assert.deepStrictEqual([UNFOCUSED_FACTOR, BACKOFF_START_MS, BACKOFF_MAX_MS], [4, 5000, 300000]); });

test('focused interval', async () => {
  const timers = fakeTimers(); let runs = 0;
  const p = createPoller({ run: async () => { runs++; }, everyMs: 5000, isFocused: () => true, timers });
  p.start(); await settle();
  assert.strictEqual(runs, 1, 'start runs at once');
  assert.deepStrictEqual(timers.delays, [5000]);
  await timers.fire(); await settle();
  assert.strictEqual(runs, 2);
  p.stop();
  assert.strictEqual(timers.pending, null);
});

test('unfocused interval is 4x', async () => {
  const timers = fakeTimers();
  const p = createPoller({ run: async () => {}, everyMs: 5000, isFocused: () => false, timers });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [20000]);
  p.stop();
});

test('no overlap', async () => {
  const timers = fakeTimers(); let runs = 0, release;
  const p = createPoller({ run: () => { runs++; return new Promise((r) => { release = r; }); }, everyMs: 5000, isFocused: () => true, timers });
  p.start(); await settle();
  p.kick(); p.kick(); await settle();
  assert.strictEqual(runs, 1);
  release(); await settle();
  assert.deepStrictEqual(timers.delays, [5000]);
  p.kick(); await settle();
  assert.strictEqual(runs, 2, 'kick between runs runs now');
  p.stop();
});

test('429 waits retry-after then resets', async () => {
  const timers = fakeTimers(); const notes = []; let n = 0;
  const p = createPoller({ run: async () => { if (n++ === 0) throw httpError(429, 7000); }, everyMs: 5000, isFocused: () => true, onThrottle: (x) => notes.push(x), timers });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [7000]);
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [7000, 5000]);
  assert.deepStrictEqual(notes, ['Jira is throttling, retrying', null]);
  p.stop();
});

test('a Retry-After of 0 or shorter than the backoff waits the backoff', async () => {
  const timers = fakeTimers();
  const after = [0, 2000, 30000, 1000];
  const p = createPoller({ run: async () => { throw httpError(429, after.shift()); }, everyMs: 5000, isFocused: () => true, timers });
  p.start(); await settle();
  for (let i = 0; i < 3; i++) { await timers.fire(); await settle(); }
  assert.deepStrictEqual(timers.delays.slice(0, 4), [5000, 10000, 30000, 40000]);
  p.stop();
});

test('503 without retry-after backs off exponentially', async () => {
  const timers = fakeTimers();
  const p = createPoller({ run: async () => { throw httpError(503, null); }, everyMs: 5000, isFocused: () => true, timers });
  p.start(); await settle();
  for (let i = 0; i < 8; i++) { await timers.fire(); await settle(); }
  assert.deepStrictEqual(timers.delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  p.stop();
});

test('other errors keep the normal interval', async () => {
  const timers = fakeTimers(); const errs = [];
  const p = createPoller({ run: async () => { throw new Error('boom'); }, everyMs: 5000, isFocused: () => true, onError: (e) => errs.push(e.message), timers });
  p.start(); await settle();
  assert.deepStrictEqual(timers.delays, [5000]);
  assert.deepStrictEqual(errs, ['boom']);
  p.stop();
});

test('stopped poller does not reschedule after its run ends', async () => {
  const timers = fakeTimers(); let release;
  const p = createPoller({ run: () => new Promise((r) => { release = r; }), everyMs: 5000, isFocused: () => true, timers });
  p.start(); await settle();
  p.stop(); release(); await settle();
  assert.deepStrictEqual(timers.delays, []);
});

test('offline backs off without the throttle note', async () => {
  const timers = fakeTimers(); const notes = [];
  const offline = Object.assign(new Error('Offline'), { name: 'Offline' });
  const p = createPoller({ run: async () => { throw offline; }, everyMs: 5000, isFocused: () => true, onThrottle: (x) => notes.push(x), timers });
  p.start(); await settle();
  await timers.fire(); await settle();
  assert.deepStrictEqual(timers.delays, [5000, 10000]);
  assert.deepStrictEqual(notes, [], 'offline is not throttling');
  p.stop();
});
