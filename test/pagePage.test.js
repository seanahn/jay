'use strict';
// The page tab's page scripts, run in jsdom with the real ProseMirror bundle and a fake acquireVsCodeApi.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'media', f), 'utf8');
const SCRIPTS = ['prosemirror.js', 'adfPm.js', 'ticketEditor.js', 'page.js'].map(read);
const SITE = 'https://example.atlassian.net';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });
const ME = { accountId: 'acc-ann', displayName: 'Ann Example' };

function pg(o = {}) {
  return {
    id: '1001', spaceId: '2001', title: 'Demo Home', status: 'current', subtype: null,
    version: { number: 12, authorId: 'acc-bo', createdAt: '2026-11-01T10:00:00.000Z' }, authorId: 'acc-ann', createdAt: '2025-01-02T03:04:05.000Z',
    adf: doc(p(t('Hello from DEMO'))), webUrl: `${SITE}/wiki/spaces/DEMO/pages/1001/Demo+Home`, ancestors: [{ id: '1000' }], editor: 'v2', ...o,
  };
}
function render(o = {}) {
  return {
    type: 'render', page: pg(o.page), space: { key: 'DEMO', name: 'Demo Space' },
    path: [{ id: '1000', title: 'Parent page', url: `${SITE}/wiki/spaces/DEMO/pages/1000` }],
    names: { 'acc-ann': 'Ann Example', 'acc-bo': 'Bo Sample' }, footer: o.footer || [], inline: o.inline || [], me: ME,
    editable: o.editable === undefined ? true : o.editable, readOnlyReason: o.readOnlyReason === undefined ? null : o.readOnlyReason,
    browseUrl: pg().webUrl,
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
  return { w, d: w.document, posted, send, click, of, saved: () => saved, q: (s) => w.document.querySelector(s) };
}
const viewIn = (el) => el.querySelector('.jay-editor').pmView;
const typeInto = (view, text) => view.dispatch(view.state.tr.insertText(text));

test('the header shows the path, title, author and updated time, and Open in Confluence', () => {
  const x = page();
  assert.deepStrictEqual(x.posted[0], { type: 'ready' });
  x.send(render());
  assert.deepStrictEqual([...x.d.querySelectorAll('.path > *')].map((c) => c.textContent), ['Demo Space', '›', 'Parent page']);
  assert.strictEqual(x.q('.title-text').textContent, 'Demo Home');
  const by = x.q('.byline').textContent;
  assert.match(by, /Ann Example/);
  assert.match(by, /Updated .*2026.* by Bo Sample/);
  assert.match(x.q('.body').textContent, /Hello from DEMO/);
  const open = x.q('.open-confluence');
  assert.strictEqual(open.textContent, 'Open in Confluence');
  x.click(open);
  assert.deepStrictEqual(x.of('openExternal'), [{ type: 'openExternal' }]);
  x.click(x.q('.path .crumb'));
  assert.deepStrictEqual(x.of('openPage'), [{ type: 'openPage', url: `${SITE}/wiki/spaces/DEMO/pages/1000` }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(x.saved())), { pageId: '1001' });
});

test('macros and layouts show as labeled blocks; links and media go through the host', () => {
  const x = page();
  const adf = doc(
    { type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'toc' } },
    { type: 'layoutSection', content: [{ type: 'layoutColumn', attrs: { width: 100 }, content: [p(t('x'))] }] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', type: 'file', collection: 'c' } }] },
    p({ type: 'text', text: 'other page', marks: [{ type: 'link', attrs: { href: `${SITE}/wiki/spaces/DEMO/pages/1002` } }] }),
  );
  x.send(render({ page: { adf } }));
  assert.deepStrictEqual([...x.d.querySelectorAll('.body .jay-atom')].map((a) => a.textContent), ['[macro: toc]', '[layout]', '[image] Open in Confluence']);
  x.click(x.q('.body a'));
  assert.deepStrictEqual(x.of('openPage'), [{ type: 'openPage', url: `${SITE}/wiki/spaces/DEMO/pages/1002` }]);
  x.click(x.q('.body .jay-atom .open-jira'));
  assert.deepStrictEqual(x.of('openExternal'), [{ type: 'openExternal' }]);
});

test('Edit, Save: the save carries the title, the body and base 12', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: true });
  const input = x.q('.title-input');
  assert.strictEqual(input.value, 'Demo Home');
  input.value = 'Demo Home, again';
  const view = viewIn(x.q('.page-body'));
  view.dispatch(view.state.tr.insertText('Well, ', 1));
  x.click(x.q('.page-body .save'));
  assert.deepStrictEqual(x.of('save'), [{ type: 'save', title: 'Demo Home, again', adf: doc(p(t('Well, Hello from DEMO'))), base: 12 }]);
  x.send({ type: 'pending', op: 'page' });
  assert.ok(x.q('.page-body .save').disabled);
  x.click(x.q('.page-body .save'));
  assert.strictEqual(x.of('save').length, 1, 'nothing more while pending');
  x.send({ type: 'result', op: 'page', result: { ok: true, value: { version: 13 } } });
  assert.ok(x.q('.page-body .jay-editor') === null, 'ok leaves edit mode');
  assert.ok(x.q('.title-edit').hidden);
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: false });
});

test('after an ok save, an edit started before the next render uses the saved version as its base', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  x.click(x.q('.page-body .save'));
  x.send({ type: 'pending', op: 'page' });
  x.send({ type: 'result', op: 'page', result: { ok: true, value: { version: 13 } } });
  x.click(x.q('.page-edit'));
  x.click(x.q('.page-body .save'));
  assert.strictEqual(x.of('save')[1].base, 13, 'not the 12 of the render before the save');
  x.send({ type: 'result', op: 'page', result: { ok: false, kind: 'rejected', message: 'no' } });
  x.click(x.q('.page-body .cancel'));
  x.send(render({ page: { version: { number: 15, authorId: 'acc-bo', createdAt: '2026-11-03T10:00:00.000Z' } } }));
  x.click(x.q('.page-edit'));
  x.click(x.q('.page-body .save'));
  assert.strictEqual(x.of('save')[2].base, 15, 'a later render is the base again');
});

test('a conflict keeps the draft; Reload shows "Confluence now has:" beside it and re-bases', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  typeInto(viewIn(x.q('.page-body')), 'DRAFT ');
  x.click(x.q('.page-body .save'));
  x.send({ type: 'pending', op: 'page' });
  x.send({ type: 'result', op: 'page', result: { ok: false, kind: 'conflict', message: 'Changed in Confluence since you opened it' } });
  const msg = x.q('.page-body .status-msg');
  assert.match(msg.textContent, /Changed in Confluence since you opened it/);
  assert.match(viewIn(x.q('.page-body')).state.doc.textContent, /DRAFT/);
  assert.ok(!x.q('.page-body .save').disabled);
  x.click(msg.querySelector('.reload'));
  assert.strictEqual(x.of('reload').length, 1);
  x.send(render({ page: { title: 'Their title', adf: doc(p(t('Theirs'))), version: { number: 14, authorId: 'acc-bo', createdAt: '2026-11-03T10:00:00.000Z' } } }));
  assert.match(viewIn(x.q('.page-body')).state.doc.textContent, /DRAFT/, 'the draft is kept');
  const theirs = x.q('.confluence-now');
  assert.ok(!theirs.hidden);
  assert.strictEqual(theirs.querySelector('summary').textContent, 'Confluence now has:');
  assert.match(theirs.textContent, /Their title/);
  assert.match(theirs.textContent, /Theirs/);
  x.click(x.q('.page-body .save'));
  assert.strictEqual(x.of('save').pop().base, 14);
});

test('a render while editing does not move the base; failed shows Retry with the same save', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  x.send(render({ page: { version: { number: 13, authorId: 'acc-bo', createdAt: '2026-11-03T10:00:00.000Z' } } }));
  x.click(x.q('.page-body .save'));
  assert.strictEqual(x.of('save')[0].base, 12);
  x.send({ type: 'result', op: 'page', result: { ok: false, kind: 'failed', message: 'Offline — not sent' } });
  x.click(x.q('.page-body .retry'));
  assert.deepStrictEqual(x.of('save')[1], x.of('save')[0]);
  x.click(x.q('.page-body .cancel'));
  assert.ok(x.q('.page-body .jay-editor') !== null, 'no Cancel while the retry is pending');
  x.send({ type: 'result', op: 'page', result: { ok: false, kind: 'rejected', message: 'Confluence said no' } });
  assert.match(x.q('.page-body .status-msg').textContent, /Confluence said no/);
  x.click(x.q('.page-body .cancel'));
  assert.ok(x.q('.page-body .jay-editor') === null, 'Cancel discards the draft');
});

test('stale shows "Updated in Confluence, Reload"; loadError and waiting show banners', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  typeInto(viewIn(x.q('.page-body')), 'DRAFT ');
  x.send({ type: 'stale' });
  assert.strictEqual(x.q('.banner').textContent, 'Updated in Confluence, Reload');
  x.click(x.q('.banner .reload'));
  assert.strictEqual(x.of('reload').length, 1);
  assert.match(viewIn(x.q('.page-body')).state.doc.textContent, /DRAFT/);
  x.send({ type: 'loadError', message: 'Page not found' });
  assert.match(x.q('.banner').textContent, /Page not found/);
  x.send({ type: 'waiting', message: 'Waiting for sign-in…' });
  assert.match(x.q('.banner').textContent, /Waiting for sign-in/);
});

test('editable false hides Edit; legacy, live and archived show Edit in Confluence; the sign-in reason is shown as is', () => {
  for (const reason of ['legacy', 'live', 'archived']) {
    const x = page(); x.send(render({ editable: false, readOnlyReason: reason }));
    assert.ok(x.q('.page-edit').hidden);
    const b = x.q('.edit-in-confluence');
    assert.ok(!b.hidden);
    assert.strictEqual(b.textContent, 'Edit in Confluence');
    x.click(b);
    assert.deepStrictEqual(x.of('openExternal'), [{ type: 'openExternal' }]);
    assert.ok(x.q('.read-only-note').hidden, reason);
  }
  const x = page(); x.send(render({ editable: false, readOnlyReason: "This sign-in can't edit Confluence" }));
  assert.ok(x.q('.page-edit').hidden);
  assert.ok(x.q('.edit-in-confluence').hidden);
  assert.strictEqual(x.q('.read-only-note').textContent, "This sign-in can't edit Confluence");
  // an editable render after a read-only one shows Edit again
  x.send(render());
  assert.ok(!x.q('.page-edit').hidden);
  assert.ok(x.q('.read-only-note').hidden);
});

test('no Confluence text through innerHTML: an <img onerror> title and names stay text', () => {
  const x = page();
  const evil = '<img src=x onerror="window.pwned=1">Title';
  x.send(Object.assign(render({ page: { title: evil, adf: doc(p(t('<script>window.pwned=2</script>'))) } }),
    { space: { key: 'DEMO', name: '<b>Space</b>' }, names: { 'acc-ann': '<i>Ann</i>', 'acc-bo': 'Bo' }, path: [{ id: '1000', title: '<img src=y onerror="window.pwned=3">', url: `${SITE}/wiki/x` }] }));
  assert.strictEqual(x.q('.title-text').textContent, evil);
  assert.ok(x.q('img') === null && x.q('script') === null && x.q('b') === null && x.q('i') === null, 'no markup from Confluence text');
  assert.strictEqual(x.w.pwned, undefined);
  assert.match(x.q('.byline').textContent, /<i>Ann<\/i>/);
  assert.match(x.q('.body').textContent, /<script>/);
  x.click(x.q('.page-edit'));
  assert.strictEqual(x.q('.title-input').value, evil);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(SCRIPTS[3]), 'the page script never uses innerHTML');
});

const cm = (id, who, text, o = {}) => ({ id, kind: 'footer', authorId: who, createdAt: '2026-11-02T10:00:00.000Z', version: 1, adf: doc(p(t(text))), replies: [], ...o });

test('footer comments are listed oldest first with replies nested under each; scrollTo marks one', () => {
  const x = page();
  x.send(render({ footer: [
    cm('c3', 'acc-bo', 'Later', { createdAt: '2026-11-04T10:00:00.000Z' }),
    cm('c1', 'acc-bo', 'Looks good', { replies: [cm('c2', 'acc-ann', 'Thanks'), cm('c9', 'acc-bo', 'Early reply', { createdAt: '2026-11-01T10:00:00.000Z' })] })] }));
  const items = [...x.d.querySelectorAll('.page-comments .comment')];
  assert.deepStrictEqual(items.map((i) => i.dataset.commentId), ['c1', 'c9', 'c2', 'c3']);
  assert.deepStrictEqual(items.map((i) => i.classList.contains('reply')), [false, true, true, false]);
  assert.match(items[0].textContent, /Bo Sample.*Looks good/);
  x.send({ type: 'scrollTo', commentId: 'c2' });
  assert.ok(items[2].classList.contains('target'));
  x.send({ type: 'scrollTo', commentId: 'c3' });
  assert.ok(!items[2].classList.contains('target') && items[3].classList.contains('target'));
});

test('inline comments sit under "Inline comments" with the quote and Resolved', () => {
  const x = page();
  x.send(render({ inline: [
    cm('i1', 'acc-bo', 'Typo?', { kind: 'inline', quote: 'Hello <b>x</b>', resolved: false, replies: [cm('i2', 'acc-ann', 'Fixed', { kind: 'inline' })] }),
    cm('i3', 'acc-bo', 'Old', { kind: 'inline', quote: 'World', resolved: true })] }));
  const titles = [...x.d.querySelectorAll('.comments-title')].map((e) => e.textContent);
  assert.deepStrictEqual(titles, ['Comments (0)', 'Inline comments (2)']);
  const quotes = [...x.d.querySelectorAll('blockquote')];
  assert.deepStrictEqual(quotes.map((q) => q.textContent), ['Hello <b>x</b>', 'World']);
  assert.ok(x.q('blockquote b') === null);
  const groups = [...x.d.querySelectorAll('.inline-group')];
  assert.ok(!groups[0].textContent.includes('Resolved'));
  assert.ok(groups[1].textContent.includes('Resolved'));
  assert.deepStrictEqual([...groups[0].querySelectorAll('.comment')].map((i) => i.dataset.commentId), ['i1', 'i2']);
  // no way to start a new inline comment
  assert.strictEqual(x.d.querySelectorAll('.new-comment').length, 1);
});

test('adding a comment posts comment { adf }, pending disables it, ok clears the editor', () => {
  const x = page(); x.send(render());
  const box = x.q('.new-comment');
  assert.ok(!box.hidden);
  assert.ok(box.querySelector('.comment-btn').disabled, 'empty comment can\'t be sent');
  typeInto(viewIn(box), 'Hi team');
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: true });
  x.click(box.querySelector('.comment-btn'));
  assert.deepStrictEqual(x.of('comment'), [{ type: 'comment', adf: doc(p(t('Hi team'))) }]);
  x.click(box.querySelector('.comment-btn'));
  assert.strictEqual(x.of('comment').length, 1, 'nothing while pending');
  x.send({ type: 'pending', op: 'comment' });
  x.send({ type: 'result', op: 'comment', result: { ok: false, kind: 'failed', message: 'Offline - not sent' } });
  assert.match(box.querySelector('.status-msg').textContent, /Offline/);
  assert.match(viewIn(box).state.doc.textContent, /Hi team/, 'the draft is kept');
  x.click(box.querySelector('.retry'));
  assert.deepStrictEqual(x.of('comment')[1], x.of('comment')[0]);
  x.send({ type: 'result', op: 'comment', result: { ok: true, value: {} } });
  assert.strictEqual(viewIn(box).state.doc.textContent, '');
  assert.deepStrictEqual(x.of('editing').pop(), { type: 'editing', on: false });
});

test('reply posts reply { parentId, kind } on footer and inline comments, not on replies', () => {
  const x = page();
  x.send(render({ footer: [cm('c1', 'acc-bo', 'Looks good', { replies: [cm('c2', 'acc-ann', 'Thanks')] })], inline: [cm('i1', 'acc-bo', 'Typo?', { kind: 'inline', quote: 'Hi' })] }));
  assert.strictEqual(x.d.querySelectorAll('.reply-btn').length, 2, 'replies have no Reply');
  const reply = (id) => x.q(`[data-comment-id="${id}"] .reply-btn`);
  x.click(reply('c1'));
  let box = x.q('[data-comment-id="c1"] .comment-reply');
  typeInto(viewIn(box), 'Ack');
  x.click(box.querySelector('.save'));
  assert.deepStrictEqual(x.of('reply'), [{ type: 'reply', parentId: 'c1', kind: 'footer', adf: doc(p(t('Ack'))) }]);
  x.send({ type: 'pending', op: 'reply:c1' });
  assert.ok(box.querySelector('.save').disabled);
  x.send({ type: 'result', op: 'reply:c1', result: { ok: true, value: {} } });
  assert.ok(x.q('.comment-reply') === null);
  x.click(reply('i1'));
  box = x.q('[data-comment-id="i1"] .comment-reply');
  typeInto(viewIn(box), 'Yes');
  x.click(box.querySelector('.save'));
  assert.deepStrictEqual(x.of('reply')[1], { type: 'reply', parentId: 'i1', kind: 'inline', adf: doc(p(t('Yes'))) });
});

test('Edit shows only on Ann\'s comments; the edit posts base (version) and loaded (its ADF)', () => {
  const x = page();
  const mine = cm('c2', 'acc-ann', 'Thanks', { version: 3 });
  const myInline = cm('i1', 'acc-ann', 'Mine inline', { kind: 'inline', quote: 'Hi', version: 5 });
  x.send(render({ footer: [cm('c1', 'acc-bo', 'Looks good', { replies: [mine] })], inline: [myInline, cm('i2', 'acc-bo', 'Theirs', { kind: 'inline', quote: 'Yo' })] }));
  assert.deepStrictEqual([...x.d.querySelectorAll('.comment .edit')].map((b) => b.closest('.comment').dataset.commentId), ['c2', 'i1']);
  x.click(x.q('[data-comment-id="c2"] .edit'));
  const box = x.q('[data-comment-id="c2"] .comment-edit');
  assert.match(viewIn(box).state.doc.textContent, /Thanks/);
  typeInto(viewIn(box), '!');
  x.click(box.querySelector('.save'));
  const sent = x.of('editComment')[0];
  assert.deepStrictEqual(sent, { type: 'editComment', id: 'c2', kind: 'footer', adf: doc(p(t('!Thanks'))), base: 3, loaded: mine.adf });
  x.send({ type: 'pending', op: 'comment:c2' });
  x.send({ type: 'result', op: 'comment:c2', result: { ok: false, kind: 'conflict', message: 'Changed in Confluence since you opened it' } });
  assert.match(box.querySelector('.status-msg').textContent, /Changed in Confluence since you opened it/);
  x.click(box.querySelector('.reload'));
  assert.strictEqual(x.of('reload').length, 1);
  // a re-render keeps the draft; after Reload the base and loaded move and Confluence's text is shown
  x.send(render({ footer: [cm('c1', 'acc-bo', 'Looks good', { replies: [cm('c2', 'acc-ann', 'Theirs now', { version: 4 })] })] }));
  const box2 = x.q('[data-comment-id="c2"] .comment-edit');
  assert.match(viewIn(box2).state.doc.textContent, /Thanks/);
  assert.match(box2.querySelector('.confluence-now').textContent, /Confluence now has:.*Theirs now/);
  x.click(box2.querySelector('.save'));
  const again = x.of('editComment')[1];
  assert.strictEqual(again.base, 4);
  assert.deepStrictEqual(again.loaded, doc(p(t('Theirs now'))));
  x.send({ type: 'result', op: 'comment:c2', result: { ok: true, value: {} } });
  assert.ok(x.q('.comment-edit') === null);
});

test('Cancel discards an edit; an open reply survives a re-render', () => {
  const x = page();
  const f = [cm('c1', 'acc-ann', 'Mine')];
  x.send(render({ footer: f }));
  x.click(x.q('.edit')); x.click(x.q('.comment-edit .cancel'));
  assert.ok(x.q('.comment-edit') === null && x.q('.edit') !== null);
  x.click(x.q('.reply-btn'));
  typeInto(viewIn(x.q('.comment-reply')), 'draft');
  x.send(render({ footer: f }));
  assert.match(viewIn(x.q('.comment-reply')).state.doc.textContent, /draft/);
});

test('without write access the add, reply and edit controls are hidden; read-only page formats still allow comments', () => {
  const x = page();
  x.send(render({ editable: false, readOnlyReason: "This sign-in can't edit Confluence", footer: [cm('c1', 'acc-ann', 'Mine')] }));
  assert.ok(x.q('.new-comment').hidden);
  assert.ok(x.q('.reply-btn') === null && x.q('.edit') === null);
  for (const reason of ['legacy', 'live']) {
    x.send(render({ editable: false, readOnlyReason: reason, footer: [cm('c1', 'acc-ann', 'Mine')] }));
    assert.ok(!x.q('.new-comment').hidden);
    assert.ok(x.q('.reply-btn') !== null && x.q('.edit') !== null);
  }
});

test('@ in the comment editor searches users and inserts an ADF mention with the account id', () => {
  const x = page(); x.send(render());
  const box = x.q('.new-comment');
  typeInto(viewIn(box), 'Hi @bo');
  const s = x.of('searchUsers').pop();
  assert.strictEqual(s.query, 'bo');
  x.send({ type: 'users', requestId: s.requestId, users: [{ accountId: 'acc-bo', displayName: 'Bo Sample' }] });
  x.click(box.querySelector('.mention-list button'));
  x.click(box.querySelector('.comment-btn'));
  const mention = x.of('comment')[0].adf.content[0].content.find((n) => n.type === 'mention');
  assert.strictEqual(mention.attrs.id, 'acc-bo');
});

test('searchUsers answers reach the mention list through requestId', () => {
  const x = page(); x.send(render());
  x.click(x.q('.page-edit'));
  typeInto(viewIn(x.q('.page-body')), ' @bo');
  const s = x.of('searchUsers').pop();
  assert.strictEqual(s.query, 'bo');
  x.send({ type: 'users', requestId: s.requestId, users: [{ accountId: 'acc-bo', displayName: 'Bo Sample' }] });
  assert.strictEqual(x.q('.mention-list button').textContent, 'Bo Sample');
});

test('before its content arrives, the tab says Loading…; the render clears it', () => {
  const x = page();
  const banner = x.q('.banner');
  assert.strictEqual(banner.hidden, false); assert.strictEqual(banner.textContent, 'Loading…');
  x.send(render());
  assert.strictEqual(banner.hidden, true);
});
