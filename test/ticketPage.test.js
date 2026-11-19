'use strict';
// The ticket tab's page scripts, run in jsdom with the real ProseMirror bundle and a fake acquireVsCodeApi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'media', f), 'utf8');
const SCRIPTS = ['prosemirror.js', 'adfPm.js', 'ticketEditor.js', 'ticket.js'].map(read);

const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });
const ME = { accountId: 'acc-sean', displayName: 'Sean Example' };
const ALEX = { accountId: 'acc-alex', displayName: 'Alex Kim' };

function issue(o = {}) {
  return {
    key: 'DEMO-1', type: 'Task', summary: 'Write the checklist', status: { name: 'Open', category: 'new' }, assignee: ALEX, reporter: ALEX,
    priority: { id: '3', name: 'Medium' }, duedate: '2027-01-15', labels: ['FY2027Q3', 'docs'], parentKey: 'DEMO-5',
    created: '2026-11-02T13:21:00.000Z', updated: '2026-11-18T09:05:00.000Z',
    description: doc(p(t('Cover QA. '), { type: 'mention', attrs: { id: 'acc-sean', text: '@Sean Example' } })), ...o,
  };
}
const comment = (id, who, body) => ({ id, author: who, created: '2026-11-17T14:19:00.000Z', updated: '2026-11-17T14:19:00.000Z', body });
function render(o = {}) {
  return {
    type: 'render', issue: issue(o.issue), total: 2, path: [{ key: 'DEMO-5', summary: 'The epic' }], me: ME,
    priorities: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }], browseUrl: 'https://example.atlassian.net/browse/DEMO-1',
    comments: o.comments || [comment('10', ALEX, doc(p(t('From Alex')))), comment('11', ME, doc(p(t('From me'))))],
  };
}

function page() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; const posted = []; let saved;
  w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s) => { saved = s; } });
  for (const s of SCRIPTS) w.eval(s);
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const of = (type) => posted.filter((m) => m.type === type);
  return { w, d: w.document, posted, send, click, of, saved: () => saved };
}
const viewIn = (el) => el.querySelector('.jay-editor').pmView;
const typeInto = (view, text) => view.dispatch(view.state.tr.insertText(text));

test('render shows path, fields, description and comments with no innerHTML of Jira text', () => {
  const x = page();
  assert.deepStrictEqual(x.posted[0], { type: 'ready' });
  x.send(render({ issue: { summary: '<img src=x onerror="window.pwned=1">Title' }, comments: [comment('10', { accountId: 'acc-alex', displayName: '<b>Alex</b>' }, doc(p(t('<script>window.pwned=2</script>'))))] }));
  assert.strictEqual(x.d.querySelector('.title-text').textContent, '<img src=x onerror="window.pwned=1">Title');
  assert.strictEqual(x.d.querySelector('img'), null);
  assert.strictEqual(x.d.querySelector('script'), null);
  assert.strictEqual(x.w.pwned, undefined);
  assert.deepStrictEqual([...x.d.querySelectorAll('.path .crumb')].map((c) => c.textContent), ['DEMO-5 The epic']);
  assert.strictEqual(x.d.querySelector('.key').textContent, 'DEMO-1');
  assert.strictEqual(x.d.querySelector('.assignee-name').textContent, 'Alex Kim');
  assert.strictEqual(x.d.querySelector('select.priority').value, '3');
  assert.strictEqual(x.d.querySelector('input.duedate').value, '2027-01-15');
  assert.strictEqual(x.d.querySelector('input.labels').value, 'FY2027Q3, docs');
  assert.match(x.d.querySelector('.description .body').textContent, /Cover QA\./);
  assert.ok(x.d.querySelector('.description .jay-mention.me'), 'a mention of me is marked');
  const c = x.d.querySelector('.comment');
  assert.strictEqual(c.querySelector('.author').textContent, '<b>Alex</b>');
  assert.strictEqual(c.querySelector('.body').textContent, '<script>window.pwned=2</script>');
  assert.ok(!SCRIPTS.slice(2).some((s) => /innerHTML|outerHTML|insertAdjacentHTML/.test(s)), 'the page scripts never use innerHTML');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(x.saved())), { key: 'DEMO-1' });
  assert.ok(x.of('getTransitions').length >= 1, 'transitions are fetched on open');
  x.click(x.d.querySelector('.path .crumb'));
  assert.deepStrictEqual(x.of('open'), [{ type: 'open', key: 'DEMO-5' }]);
});

test('atoms show as labeled chips; media offers Open in Jira', () => {
  const x = page();
  const adf = doc(
    { type: 'table', content: [] },
    { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up: read this first'))] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', type: 'file', collection: 'c' } }] },
    p(t('x '), { type: 'inlineCard', attrs: { url: 'https://example.com' } }),
  );
  x.send(render({ issue: { description: adf } }));
  const atoms = [...x.d.querySelectorAll('.description .body .jay-atom')].map((a) => a.textContent);
  assert.deepStrictEqual(atoms, ['[table]', '[panel: Heads up: read this first]', '[image] Open in Jira', '[inlineCard]']);
  x.click(x.d.querySelector('.description .jay-atom .open-jira'));
  assert.strictEqual(x.of('openExternal').length, 1);
});

test('edit description, Save posts save with ADF from the editor', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.description .edit'));
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: true });
  const view = viewIn(x.d.querySelector('.description'));
  assert.ok(view, 'an editor');
  view.dispatch(view.state.tr.insertText('New start. ', 1));
  x.click(x.d.querySelector('.description .save'));
  const [s] = x.of('save');
  assert.strictEqual(s.field, 'description');
  assert.deepStrictEqual(s.base, issue().description);
  assert.deepStrictEqual(s.value, doc(p(t('New start. Cover QA. '), { type: 'mention', attrs: { id: 'acc-sean', text: '@Sean Example' } })));
  x.send({ type: 'pending', op: 'description' });
  assert.ok(x.d.querySelector('.description .save').disabled);
  x.send({ type: 'result', op: 'description', result: { ok: true, value: s.value } });
  assert.strictEqual(x.d.querySelector('.description .jay-editor'), null, 'ok leaves edit mode');
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: false });
});

test('an emptied description saves as an empty doc; Cancel discards', () => {
  const x = page(); x.send(render({ issue: { description: null } }));
  x.click(x.d.querySelector('.description .edit'));
  const view = viewIn(x.d.querySelector('.description'));
  assert.strictEqual(view.state.doc.childCount, 1, 'one empty paragraph for a cursor');
  x.click(x.d.querySelector('.description .save'));
  assert.deepStrictEqual(x.of('save')[0].value, doc());
  x.click(x.d.querySelector('.description .cancel'));
  assert.strictEqual(x.d.querySelector('.description .jay-editor'), null);
});

test('conflict result keeps the draft and shows Reload', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.description .edit'));
  typeInto(viewIn(x.d.querySelector('.description')), 'DRAFT');
  x.click(x.d.querySelector('.description .save'));
  x.send({ type: 'pending', op: 'description' });
  x.send({ type: 'result', op: 'description', result: { ok: false, kind: 'conflict', message: 'Changed in Jira since you opened it' } });
  const sec = x.d.querySelector('.description');
  assert.match(sec.querySelector('.status-msg').textContent, /Changed in Jira since you opened it/);
  assert.match(viewIn(sec).state.doc.textContent, /DRAFT/);
  assert.ok(!sec.querySelector('.save').disabled);
  x.click(sec.querySelector('.reload'));
  assert.strictEqual(x.of('reload').length, 1);
  x.send(render({ issue: { description: doc(p(t('Theirs'))), updated: '2026-11-18T10:00:00.000Z' } }));
  const after = x.d.querySelector('.description');
  assert.ok(viewIn(after), 'still editing after Reload');
  assert.match(viewIn(after).state.doc.textContent, /DRAFT/);
});

test('failed result shows Retry; Retry resends the same draft', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.description .edit'));
  typeInto(viewIn(x.d.querySelector('.description')), 'DRAFT');
  x.click(x.d.querySelector('.description .save'));
  x.send({ type: 'pending', op: 'description' });
  x.send({ type: 'result', op: 'description', result: { ok: false, kind: 'failed', message: 'Offline — not sent' } });
  const sec = x.d.querySelector('.description');
  assert.match(sec.querySelector('.status-msg').textContent, /Offline — not sent/);
  x.click(sec.querySelector('.retry'));
  const saves = x.of('save');
  assert.strictEqual(saves.length, 2);
  assert.deepStrictEqual(saves[1], saves[0]);
  // busy keeps the draft and says why nothing was sent, with no Retry; rejected shows the message
  x.send({ type: 'result', op: 'description', result: { ok: false, kind: 'busy', message: 'Another change to this ticket is still being saved' } });
  assert.ok(viewIn(x.d.querySelector('.description')));
  assert.strictEqual(sec.querySelector('.status-msg').textContent, 'Another change to this ticket is still being saved');
  assert.strictEqual(sec.querySelector('.status-msg').hidden, false);
  assert.strictEqual(sec.querySelector('.status-msg .retry'), null);
  x.send({ type: 'result', op: 'description', result: { ok: false, kind: 'rejected', message: 'Jira said no' } });
  assert.match(x.d.querySelector('.description .status-msg').textContent, /Jira said no/);
  assert.match(viewIn(x.d.querySelector('.description')).state.doc.textContent, /DRAFT/);
});

test('transition with hasScreen shows Open in Jira and sends nothing', () => {
  const x = page(); x.send(render());
  x.send({ type: 'transitions', list: [{ id: '21', name: 'Start', to: { name: 'In Progress' }, hasScreen: false }, { id: '31', name: 'Resolve', to: { name: 'Done' }, hasScreen: true }] });
  const sel = x.d.querySelector('select.status');
  sel.value = '31'; sel.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  assert.strictEqual(x.of('transition').length, 0);
  assert.match(x.d.querySelector('.fields').textContent, /Needs more fields/);
  x.click(x.d.querySelector('.fields .needs-screen .open-jira'));
  assert.strictEqual(x.of('openExternal').length, 1);
  sel.value = '21'; sel.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  assert.deepStrictEqual(x.of('transition'), [{ type: 'transition', id: '21' }]);
});

test('pickers send set and assignMe straight away', () => {
  const x = page(); x.send(render());
  const pr = x.d.querySelector('select.priority'); pr.value = '2'; pr.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  const due = x.d.querySelector('input.duedate'); due.focus(); due.value = '2027-02-01'; due.dispatchEvent(new x.w.Event('blur'));
  const lab = x.d.querySelector('input.labels'); lab.focus(); lab.value = 'docs, new ,docs'; lab.dispatchEvent(new x.w.Event('blur'));
  x.click(x.d.querySelector('.assign-me'));
  assert.deepStrictEqual(x.of('set'), [{ type: 'set', field: 'priority', value: '2' }, { type: 'set', field: 'duedate', value: '2027-02-01' }, { type: 'set', field: 'labels', value: ['docs', 'new'] }]);
  assert.strictEqual(x.of('assignMe').length, 1);
  x.click(x.d.querySelector('.assign-me'));
  assert.strictEqual(x.of('assignMe').length, 1, 'nothing more while it is pending');
  x.send({ type: 'result', op: 'assignee', result: { ok: true, value: ME } });
  const q = x.d.querySelector('input.assignee-search'); q.value = 'al'; q.dispatchEvent(new x.w.Event('input', { bubbles: true }));
  const [s] = x.of('searchUsers');
  assert.deepStrictEqual({ query: s.query, assignable: s.assignable }, { query: 'al', assignable: true });
  x.send({ type: 'users', requestId: s.requestId, users: [ALEX] });
  x.click(x.d.querySelector('.assignee-results button'));
  assert.deepStrictEqual(x.of('set').pop(), { type: 'set', field: 'assignee', value: 'acc-alex' });
});

test('@ opens the user list and inserts a mention', () => {
  const x = page(); x.send(render());
  const box = x.d.querySelector('.new-comment');
  assert.ok(box.querySelector('.comment-btn').disabled, 'an empty comment cannot be posted');
  const view = viewIn(box);
  typeInto(view, 'Hi @al');
  const s = x.of('searchUsers').pop();
  assert.deepStrictEqual({ query: s.query, assignable: s.assignable }, { query: 'al', assignable: false });
  x.send({ type: 'users', requestId: s.requestId, users: [ALEX] });
  const item = x.d.querySelector('.mention-list button');
  assert.strictEqual(item.textContent, 'Alex Kim');
  x.click(item);
  assert.strictEqual(x.d.querySelector('.mention-list'), null);
  assert.ok(!box.querySelector('.comment-btn').disabled);
  x.click(box.querySelector('.comment-btn'));
  const [c] = x.of('comment');
  assert.deepStrictEqual(c.adf.content[0].content.slice(0, 2), [t('Hi '), { type: 'mention', attrs: { id: 'acc-alex', text: '@Alex Kim' } }]);
  x.send({ type: 'pending', op: 'comment' });
  x.send({ type: 'result', op: 'comment', result: { ok: true, value: {} } });
  assert.strictEqual(viewIn(x.d.querySelector('.new-comment')).state.doc.textContent, '', 'a posted comment clears the box');
});

test('own comment has Edit, others\' do not', () => {
  const x = page(); x.send(render());
  const [theirs, mine] = x.d.querySelectorAll('.comments .comment');
  assert.strictEqual(theirs.querySelector('.edit'), null);
  x.click(mine.querySelector('.edit'));
  const view = viewIn(x.d.querySelectorAll('.comments .comment')[1]);
  typeInto(view, '!');
  x.click(x.d.querySelectorAll('.comments .comment')[1].querySelector('.save'));
  const [e] = x.of('editComment');
  assert.strictEqual(e.id, '11');
  assert.strictEqual(e.adf.content[0].content[0].text.includes('From me'), true);
});

test('title edits as text; stale and loadError show Reload', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.title .edit'));
  const input = x.d.querySelector('.title input');
  input.value = 'New title';
  x.click(x.d.querySelector('.title .save'));
  assert.deepStrictEqual(x.of('save'), [{ type: 'save', field: 'summary', value: 'New title', base: 'Write the checklist' }]);
  x.send({ type: 'stale' });
  assert.match(x.d.querySelector('.banner').textContent, /changed in Jira/i);
  x.click(x.d.querySelector('.banner .reload'));
  x.send({ type: 'loadError', message: 'Issue does not exist' });
  assert.match(x.d.querySelector('.banner').textContent, /Issue does not exist/);
  assert.ok(x.of('reload').length >= 1);
});

test('marks never land on inline atoms; an editor shows them as chips', () => {
  const x = page();
  x.send(render({ comments: [comment('11', ME, doc(p(t('see '), { type: 'inlineCard', attrs: { url: 'https://example.com' } }, t(' here'))))] }));
  x.click(x.d.querySelector('.comments .comment .edit'));
  const view = viewIn(x.d.querySelector('.comments .comment'));
  assert.strictEqual(x.d.querySelector('.comment .jay-editor .jay-atom').textContent, '[inlineCard]');
  assert.strictEqual(x.d.querySelector('.comment .jay-editor .jay-atom').getAttribute('contenteditable'), 'false');
  const strong = view.state.schema.marks.strong;
  view.dispatch(view.state.tr.addMark(0, view.state.doc.content.size, strong.create()));
  const inl = [];
  view.state.doc.descendants((n) => { if (n.type.name === 'atomInline') inl.push(n.marks.length); });
  assert.deepStrictEqual(inl, [0]);
  x.click(x.d.querySelector('.comments .comment .save'));
  assert.deepStrictEqual(x.of('editComment')[0].adf.content[0].content[1], { type: 'inlineCard', attrs: { url: 'https://example.com' } });
});

test('the save carries the base captured at edit start, even after an intervening render', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.description .edit'));
  x.click(x.d.querySelector('.title .edit'));
  x.click(x.d.querySelectorAll('.comments .comment')[1].querySelector('.edit'));
  typeInto(viewIn(x.d.querySelector('.description')), 'DRAFT');
  // another write lands and the host re-renders with a colleague's newer text
  x.send(render({ issue: { summary: 'Their title', description: doc(p(t('Theirs'))), updated: '2026-11-18T10:00:00.000Z' }, comments: [comment('11', ME, doc(p(t('Theirs too'))))] }));
  x.click(x.d.querySelector('.description .save'));
  x.click(x.d.querySelector('.title .save'));
  x.click(x.d.querySelector('.comments .comment .save'));
  assert.deepStrictEqual(x.of('save').map((m) => m.base), [issue().description, 'Write the checklist']);
  assert.deepStrictEqual(x.of('editComment')[0].base, doc(p(t('From me'))));
  // Reload on the conflict re-bases to what Jira has now
  x.send({ type: 'result', op: 'description', result: { ok: false, kind: 'conflict', message: 'Changed in Jira since you opened it' } });
  x.click(x.d.querySelector('.description .reload'));
  x.send(render({ issue: { description: doc(p(t('Theirs'))), updated: '2026-11-18T10:00:00.000Z' } }));
  x.click(x.d.querySelector('.description .save'));
  assert.deepStrictEqual(x.of('save').pop().base, doc(p(t('Theirs'))));
  assert.match(viewIn(x.d.querySelector('.description')).state.doc.textContent, /DRAFT/);
});

test('Edit buttons wait for the first render; title Save is off while empty', () => {
  const x = page();
  assert.ok(x.d.querySelector('.title .edit').disabled);
  assert.ok(x.d.querySelector('.description .edit').disabled);
  x.send(render());
  assert.ok(!x.d.querySelector('.description .edit').disabled);
  x.click(x.d.querySelector('.title .edit'));
  const input = x.d.querySelector('.title input');
  input.value = '   '; input.dispatchEvent(new x.w.Event('input'));
  assert.ok(x.d.querySelector('.title .save').disabled);
  input.value = 'T'; input.dispatchEvent(new x.w.Event('input'));
  assert.ok(!x.d.querySelector('.title .save').disabled);
});

test('selects ignore arrow-key steps and commit on Enter, once', () => {
  const x = page(); x.send(render());
  x.send({ type: 'transitions', list: [{ id: '21', name: 'Start', to: { name: 'In Progress' }, hasScreen: false }] });
  const key = (el, k) => el.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const change = (el) => el.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  const st = x.d.querySelector('select.status');
  key(st, 'ArrowDown'); st.value = '21'; change(st);
  assert.strictEqual(x.of('transition').length, 0, 'an arrow step sends nothing');
  key(st, 'Enter');
  assert.deepStrictEqual(x.of('transition'), [{ type: 'transition', id: '21' }]);
  const pr = x.d.querySelector('select.priority');
  key(pr, 'ArrowUp'); pr.value = '2'; change(pr);
  assert.strictEqual(x.of('set').length, 0);
  key(pr, 'Enter'); key(pr, 'Enter');
  assert.deepStrictEqual(x.of('set'), [{ type: 'set', field: 'priority', value: '2' }], 'Enter sends once: the value is now pending');
});

test('due date sends on blur only when changed; a busy result resets the control', () => {
  const x = page(); x.send(render());
  const due = x.d.querySelector('input.duedate'); due.focus();
  due.value = '0002-01-15'; due.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  assert.strictEqual(x.of('set').length, 0, 'typing (change) sends nothing');
  due.value = '2027-01-15'; due.dispatchEvent(new x.w.Event('blur'));
  assert.strictEqual(x.of('set').length, 0, 'unchanged from Jira: nothing');
  due.value = '2027-03-01'; due.dispatchEvent(new x.w.Event('blur'));
  assert.deepStrictEqual(x.of('set'), [{ type: 'set', field: 'duedate', value: '2027-03-01' }]);
  x.send({ type: 'pending', op: 'duedate' });
  x.send({ type: 'result', op: 'duedate', result: { ok: false, kind: 'busy', message: 'b' } });
  assert.strictEqual(due.value, '2027-01-15');
  const pr = x.d.querySelector('select.priority'); pr.value = '2'; pr.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  x.send({ type: 'result', op: 'priority', result: { ok: false, kind: 'rejected', message: 'no' } });
  assert.strictEqual(pr.value, '3');
});

test('labels do not send when the webview itself loses focus', () => {
  const x = page(); x.send(render());
  const lab = x.d.querySelector('input.labels');
  lab.value = 'other';
  lab.dispatchEvent(new x.w.Event('blur'));   // nothing in the page has focus: the window lost it
  assert.strictEqual(x.of('set').length, 0);
  lab.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepStrictEqual(x.of('set'), [{ type: 'set', field: 'labels', value: ['other'] }]);
});

const conflict = { ok: false, kind: 'conflict', message: 'Changed in Jira since you opened it' };
const jiraNow = (sec) => { const b = sec.querySelector('.jira-now'); return b && !b.hidden ? b : null; };

test('a conflict Reload re-bases only that draft and shows what Jira has now', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.title .edit'));
  x.click(x.d.querySelector('.description .edit'));
  typeInto(viewIn(x.d.querySelector('.description')), 'DRAFT');
  x.click(x.d.querySelector('.description .save'));
  x.send({ type: 'pending', op: 'description' });
  x.send({ type: 'result', op: 'description', result: conflict });
  x.click(x.d.querySelector('.description .reload'));
  // a colleague changed both the description and the title
  x.send(render({ issue: { summary: 'Their title', description: doc(p(t('Theirs'))), updated: '2026-11-18T10:00:00.000Z' } }));
  const now = jiraNow(x.d.querySelector('.description'));
  assert.ok(now, 'Jira now has: shown with the description draft');
  assert.match(now.querySelector('summary').textContent, /Jira now has/);
  assert.strictEqual(now.querySelector('.body').textContent, 'Theirs');
  assert.strictEqual(now.open, true, 'open, so what Jira has now is visible without a click');
  assert.strictEqual(jiraNow(x.d.querySelector('.title')), null, 'the title had no conflict: nothing shown');
  assert.match(viewIn(x.d.querySelector('.description')).state.doc.textContent, /DRAFT/);
  x.click(x.d.querySelector('.title .save'));
  x.click(x.d.querySelector('.description .save'));
  const saves = x.of('save');
  assert.strictEqual(saves[1].field, 'summary');
  assert.strictEqual(saves[1].base, 'Write the checklist', 'the title keeps its original base, so the host reports its conflict');
  assert.deepStrictEqual(saves[2].base, doc(p(t('Theirs'))));
  x.send({ type: 'result', op: 'description', result: { ok: true, value: saves[2].value } });
  assert.strictEqual(jiraNow(x.d.querySelector('.description')), null, 'gone after a successful save');
});

test('Jira now has: goes away on Cancel', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelectorAll('.comments .comment')[1].querySelector('.edit'));
  x.click(x.d.querySelectorAll('.comments .comment')[1].querySelector('.save'));
  x.send({ type: 'result', op: 'comment:11', result: conflict });
  x.click(x.d.querySelectorAll('.comments .comment')[1].querySelector('.reload'));
  x.send(render({ comments: [comment('10', ALEX, doc(p(t('From Alex')))), comment('11', ME, doc(p(t('Edited elsewhere'))))] }));
  const mine = () => x.d.querySelectorAll('.comments .comment')[1];
  assert.strictEqual(jiraNow(mine()).querySelector('.body').textContent, 'Edited elsewhere');
  x.click(x.d.querySelector('.comments .comment-edit .save'));
  assert.deepStrictEqual(x.of('editComment').pop().base, doc(p(t('Edited elsewhere'))));
  x.send({ type: 'result', op: 'comment:11', result: { ok: false, kind: 'failed', message: 'Offline' } });
  x.click(mine().querySelector('.cancel'));
  assert.strictEqual(mine().querySelector('.jira-now'), null);
  // the description's block too
  x.click(x.d.querySelector('.description .edit'));
  x.click(x.d.querySelector('.description .save'));
  x.send({ type: 'result', op: 'description', result: conflict });
  x.click(x.d.querySelector('.description .reload'));
  x.send(render({ issue: { description: doc(p(t('Theirs'))) } }));
  assert.ok(jiraNow(x.d.querySelector('.description')));
  x.click(x.d.querySelector('.description .cancel'));
  assert.strictEqual(jiraNow(x.d.querySelector('.description')), null);
});

test('the stale banner Reload and a loadError re-base nothing', () => {
  const x = page(); x.send(render());
  x.click(x.d.querySelector('.description .edit'));
  x.send({ type: 'stale' });
  x.click(x.d.querySelector('.banner .reload'));
  x.send(render({ issue: { description: doc(p(t('Theirs'))) } }));
  x.click(x.d.querySelector('.description .save'));
  assert.deepStrictEqual(x.of('save').pop().base, issue().description);
  assert.strictEqual(jiraNow(x.d.querySelector('.description')), null);
  x.send({ type: 'result', op: 'description', result: conflict });
  x.click(x.d.querySelector('.description .reload'));
  x.send({ type: 'loadError', message: 'Offline' });
  x.send(render({ issue: { description: doc(p(t('Theirs'))) } }));
  x.click(x.d.querySelector('.description .save'));
  assert.deepStrictEqual(x.of('save').pop().base, issue().description, 'a failed reload cancels the re-base');
});

test('keys that open the select popup do not count as steps', () => {
  const x = page(); x.send(render());
  const key = (el, k, o) => el.dispatchEvent(new x.w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
  const pr = x.d.querySelector('select.priority');
  key(pr, 'ArrowDown'); key(pr, ' '); pr.value = '2'; pr.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  assert.deepStrictEqual(x.of('set'), [{ type: 'set', field: 'priority', value: '2' }]);
  x.send({ type: 'result', op: 'priority', result: { ok: true, value: null } });
  x.send({ type: 'transitions', list: [{ id: '21', name: 'Start', to: { name: 'In Progress' }, hasScreen: false }] });
  const st = x.d.querySelector('select.status');
  key(st, 'ArrowDown', { altKey: true }); st.value = '21'; st.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  key(st, 'F4');
  assert.deepStrictEqual(x.of('transition'), [{ type: 'transition', id: '21' }]);
});

test('field controls wait for the first render', () => {
  const x = page();
  for (const sel of ['.assign-me', 'input.assignee-search', 'select.status', 'select.priority', 'input.duedate', 'input.labels']) assert.ok(x.d.querySelector(sel).disabled, sel);
  x.send({ type: 'result', op: 'assignee', result: { ok: false, kind: 'failed', message: 'Not loaded yet' } });
  assert.ok(x.d.querySelector('.assign-me').disabled, 'a result before the render does not enable it');
  x.send(render());
  assert.ok(!x.d.querySelector('.assign-me').disabled);
  assert.ok(!x.d.querySelector('input.assignee-search').disabled);
});

test('waiting for sign-in shows a note with no Reload; the render hides it', () => {
  const x = page();
  x.send({ type: 'waiting', message: 'Waiting for sign-in…' });
  const banner = x.d.querySelector('.banner');
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(banner.textContent, 'Waiting for sign-in…');
  assert.strictEqual(banner.querySelector('button'), null);
  x.send(render());
  assert.strictEqual(banner.hidden, true);
});
