'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createMirror, formatIssue } = require('../src/mirror');

const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).toISOString();
const browseUrl = (k) => `https://example.atlassian.net/browse/${k}`;
const person = (name) => ({ accountId: 'acc-' + name.split(' ')[0].toLowerCase(), displayName: name });
const doc = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const iss = (key, o = {}) => ({
  key, type: 'Task', isEpic: false, isSubtask: false, summary: `Summary ${key}`, status: { name: 'Open', category: 'new' },
  assignee: null, reporter: null, priority: null, duedate: null, labels: [], parentKey: null,
  created: local(2026, 11, 2, 13, 21), updated: local(2026, 11, 18, 9, 5), description: null, ...o,
});
const alex = person('Alex Kim'); const sam = person('Sam Lee');
const comment = (id, who, created, t) => ({ id, author: who, created, updated: created, body: doc(t) });

function ticket() {
  return iss('DEMO-12', {
    summary: 'Write the release checklist', status: { name: 'In Progress', category: 'indeterminate' }, assignee: alex, reporter: sam,
    priority: { id: '2', name: 'High' }, duedate: '2027-01-15', labels: ['FY2027Q3'], parentKey: 'DEMO-1', description: doc('Cover QA and docs.'),
  });
}
const chain = () => ({
  path: [iss('DEMO-1', { type: 'Epic', isEpic: true, summary: 'Ship the release', assignee: alex })],
  children: [iss('DEMO-31', { summary: 'Draft the rollback steps', parentKey: 'DEMO-12' })],
  siblings: [iss('DEMO-13', { summary: 'Book the release window', status: { name: 'Done', category: 'done' }, assignee: sam, parentKey: 'DEMO-1' })],
  tree: [],
});

const EXPECTED = `# Jira Task DEMO-12: Write the release checklist
# https://example.atlassian.net/browse/DEMO-12
# Written by jay; mirrors this ticket. Other tickets: read their .jira files or use a Jira MCP server with the keys below.

Status: In Progress · Assignee: Alex Kim · Reporter: Sam Lee · Priority: High · Due: 2027-01-15
Labels: FY2027Q3
Created: 2026-11-02 13:21 · Updated: 2026-11-18 09:05

## Tree
Epic   DEMO-1   Open         Alex Kim     Ship the release
Task > DEMO-12  In Progress  Alex Kim     Write the release checklist   ← this ticket
Child  DEMO-31  Open         unassigned   Draft the rollback steps
Sibling DEMO-13 Done         Sam Lee      Book the release window

## Description
Cover QA and docs.

## Comments (2 of 2)
[2026-11-17 14:19] Sam Lee:
  First line
  second line

[2026-11-17 15:00] Alex Kim:
  Thanks
`;

test('issue file matches the format exactly', () => {
  const cs = [comment('1', sam, local(2026, 11, 17, 14, 19), 'First line\nsecond line'), comment('2', alex, local(2026, 11, 17, 15, 0), 'Thanks')];
  assert.strictEqual(formatIssue(ticket(), cs, 2, chain(), browseUrl), EXPECTED);
});

test('epic file lists the whole tree', () => {
  const epic = iss('DEMO-1', { type: 'Epic', isEpic: true, summary: 'Ship the release', assignee: alex, description: null });
  const ch = { path: [], children: [], siblings: [], tree: [
    iss('DEMO-2', { summary: 'A task', parentKey: 'DEMO-1' }),
    iss('DEMO-3', { type: 'Sub-task', isSubtask: true, summary: 'A sub-task', parentKey: 'DEMO-2' }),
    iss('DEMO-4', { summary: 'Another', parentKey: 'DEMO-1' }),
  ] };
  const out = formatIssue(epic, [], 0, ch, browseUrl);
  assert.ok(out.includes('## Tree\nEpic > DEMO-1   Open         Alex Kim     Ship the release   ← this ticket\n'
    + 'Child  DEMO-2   Open         unassigned   A task\n'
    + '  Child DEMO-3  Open         unassigned   A sub-task\n'
    + 'Child  DEMO-4   Open         unassigned   Another\n\n'), out);
  assert.ok(out.includes('## Description\n(none)\n'));
  assert.ok(out.includes('## Comments (0 of 0)'));
});

test('comments capped header', () => {
  const cs = Array.from({ length: 50 }, (_, i) => comment(String(i), sam, local(2026, 11, 17, 14, 19), 'x'));
  assert.ok(formatIssue(ticket(), cs, 73, chain(), browseUrl).includes('## Comments (newest 50 of 73)\n'));
});

function fresh() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-mir-')), 'home'); }
const mode = (p) => fs.statSync(p).mode & 0o777;

test('files are 600 in a 700 dir; clearAll removes issues, current, cache and seen', () => {
  const dir = fresh(); const m = createMirror({ dir, browseUrl });
  const p = m.write(ticket(), [], 0, chain());
  assert.strictEqual(p, path.join(dir, 'issues', 'DEMO-12.jira'));
  assert.strictEqual(m.pathFor('DEMO-12'), p);
  m.setCurrent(p);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'current.jira'), 'utf8'), fs.readFileSync(p, 'utf8'));
  for (const d of [dir, path.join(dir, 'issues')]) assert.strictEqual(mode(d), 0o700);
  for (const f of [p, path.join(dir, 'current.jira')]) assert.strictEqual(mode(f), 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'issues')), ['DEMO-12.jira'], 'no temp files left');
  fs.mkdirSync(path.join(dir, 'cache')); fs.writeFileSync(path.join(dir, 'cache', 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'seen.json'), '{}');
  m.write(iss('DEMO-5'), [], 0, { path: [], children: [], siblings: [], tree: [] });
  m.closed('DEMO-5');
  assert.strictEqual(fs.existsSync(path.join(dir, 'issues', 'DEMO-5.jira')), false);
  assert.strictEqual(m.pathFor('DEMO-5'), null);
  m.clearAll();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('current follows a rewrite of the ticket in front, not of others', () => {
  const dir = fresh(); const m = createMirror({ dir, browseUrl });
  const p = m.write(ticket(), [], 0, chain()); m.setCurrent(p);
  m.write(ticket(), [comment('1', sam, local(2026, 11, 17, 14, 19), 'new')], 1, chain());
  assert.ok(fs.readFileSync(path.join(dir, 'current.jira'), 'utf8').includes('  new'));
  const before = fs.readFileSync(path.join(dir, 'current.jira'), 'utf8');
  m.write(iss('DEMO-5'), [], 0, { path: [], children: [], siblings: [], tree: [] });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'current.jira'), 'utf8'), before);
});

test('enabled false writes nothing and pathFor is null', () => {
  const dir = fresh(); const m = createMirror({ dir, enabled: () => false, browseUrl });
  assert.strictEqual(m.write(ticket(), [], 0, chain()), null);
  m.setCurrent(path.join(dir, 'x'));
  assert.strictEqual(m.pathFor('DEMO-12'), null);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('current.jira taken by another window is left alone by a rewrite', () => {
  const dir = fresh(); const m = createMirror({ dir, browseUrl });
  const p = m.write(ticket(), [], 0, chain()); m.setCurrent(p);
  const other = formatIssue(iss('DEMO-5'), [], 0, { path: [], children: [], siblings: [], tree: [] }, browseUrl);
  fs.writeFileSync(path.join(dir, 'current.jira'), other);
  m.write(ticket(), [], 0, chain());
  assert.strictEqual(fs.readFileSync(path.join(dir, 'current.jira'), 'utf8'), other);
});

test('setCurrent is a no-op when the issue file is gone', () => {
  const dir = fresh(); const m = createMirror({ dir, browseUrl });
  const p = m.write(ticket(), [], 0, chain()); m.closed('DEMO-12');
  assert.doesNotThrow(() => m.setCurrent(p));
  assert.strictEqual(fs.existsSync(path.join(dir, 'current.jira')), false);
});

test('Confluence pages section after the description, and none without pages', () => {
  const base = formatIssue(ticket(), [], 0, chain(), browseUrl);
  assert.strictEqual(formatIssue(ticket(), [], 0, chain(), browseUrl, []), base);
  const out = formatIssue(ticket(), [], 0, chain(), browseUrl, [{ url: 'https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Plan', title: 'Release plan' }]);
  assert.ok(out.includes('Cover QA and docs.\n\n## Confluence pages\n- Release plan — https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Plan\n\n## Comments'), out);
});

test('a Confluence page URL or title with a newline stays on one line', () => {
  const out = formatIssue(ticket(), [], 0, chain(), browseUrl, [{ url: 'https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Plan\n## Comments (fake)', title: 'Release\nplan' }]);
  assert.ok(out.includes('## Confluence pages\n- Release plan — https://example.atlassian.net/wiki/spaces/DEMO/pages/1001/Plan ## Comments (fake)\n\n## Comments'), out);
});
