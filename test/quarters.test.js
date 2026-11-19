'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { quarterOf, quarterId, quarterLabel, shiftQuarter, quarterChoices, expandPattern, quarterMatches, quarterJql } = require('../src/quarters');

const d = (s) => new Date(s + 'T12:00:00');
test('quarterOf with a May fiscal year', () => {
  assert.deepStrictEqual(quarterOf(d('2026-11-19'), 5), { fy: 2027, q: 3 });
  assert.deepStrictEqual(quarterOf(d('2027-01-31'), 5), { fy: 2027, q: 3 });
  assert.deepStrictEqual(quarterOf(d('2027-02-01'), 5), { fy: 2027, q: 4 });
  assert.deepStrictEqual(quarterOf(d('2026-05-01'), 5), { fy: 2027, q: 1 });
  assert.deepStrictEqual(quarterOf(d('2026-04-30'), 5), { fy: 2026, q: 4 });
});
test('quarterOf with the calendar year', () => {
  assert.deepStrictEqual(quarterOf(d('2026-11-19'), 1), { fy: 2026, q: 4 });
  assert.deepStrictEqual(quarterOf(d('2026-01-01'), 1), { fy: 2026, q: 1 });
});
test('ids, labels and shifting', () => {
  assert.strictEqual(quarterId({ fy: 2027, q: 3 }), 'FY2027Q3'); assert.strictEqual(quarterLabel({ fy: 2027, q: 3 }), 'Q3 FY27');
  assert.deepStrictEqual(shiftQuarter({ fy: 2027, q: 4 }, 1), { fy: 2028, q: 1 });
  assert.deepStrictEqual(shiftQuarter({ fy: 2027, q: 1 }, -1), { fy: 2026, q: 4 });
});
test('quarterChoices follows now', () => {
  const a = quarterChoices(d('2026-11-19'), 5).map((c) => c.id);
  assert.deepStrictEqual(a, ['FY2027Q4', 'FY2027Q3', 'FY2027Q2', 'FY2027Q1', 'FY2026Q4', 'FY2026Q3', 'any']);
  assert.strictEqual(quarterChoices(d('2027-02-01'), 5)[1].id, 'FY2027Q4');
});
const P = ['label:FY{YYYY}Q{Q}', 'label:FY{YY}-Q{Q}', 'summary:[Q{Q}FY{YY}]'];
test('patterns', () => {
  assert.deepStrictEqual(expandPattern(P[0], { fy: 2027, q: 3 }), { kind: 'label', text: 'FY2027Q3' });
  assert.deepStrictEqual(expandPattern(P[2], { fy: 2027, q: 3 }), { kind: 'summary', text: '[Q3FY27]' });
  const Q = { fy: 2027, q: 3 };
  assert.ok(quarterMatches({ labels: ['FY27-Q3'], summary: 'x' }, Q, P));
  assert.ok(quarterMatches({ labels: [], summary: 'Backup plan [Q3FY27]' }, Q, P));
  assert.ok(!quarterMatches({ labels: ['FY2027Q2'], summary: 'Backup plan Q3FY27' }, Q, P));  // no brackets: no match
  assert.ok(quarterMatches({ labels: [], summary: 'x' }, 'any', P));
});
test('quarterJql', () => {
  assert.strictEqual(quarterJql({ fy: 2027, q: 3 }, P), '(labels in ("FY2027Q3", "FY27-Q3") OR summary ~ "\\"Q3FY27\\"")');
  assert.strictEqual(quarterJql('any', P), '');
});
