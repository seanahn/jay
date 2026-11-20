'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { SignInNeeded } = require('../src/auth');
const { JiraError, ConfluenceUnavailable, Offline, Timeout, createHttp } = require('../src/http');

const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
function fake(responses) {
  const calls = []; let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(init) : r;
  };
  return { fetch, calls };
}
const mkAuth = (over = {}) => ({ baseUrl: () => 'https://api.example.test/ex/jira/c1', siteUrl: () => 'https://example.atlassian.net', header: async () => 'Bearer t', onUnauthorized: async () => true, ...over });

test('get retries once after onUnauthorized true, and a second 401 throws SignInNeeded', async () => {
  let n = 0; const f = fake([json(401, {}), json(200, { ok: 1 })]);
  const http = createHttp({ auth: mkAuth({ onUnauthorized: async () => { n++; return true; } }), fetch: f.fetch });
  assert.deepStrictEqual(await http.get('/rest/api/3/myself'), { ok: 1 });
  assert.strictEqual(f.calls.length, 2); assert.strictEqual(n, 1);
  const g = fake([json(401, {}), json(401, {})]);
  const h = createHttp({ auth: mkAuth(), fetch: g.fetch });
  await assert.rejects(() => h.get('/x'), (e) => e instanceof SignInNeeded && e.reason === 'rejected');
  assert.strictEqual(g.calls.length, 2);
});
test('get with onUnauthorized false does not retry and throws SignInNeeded', async () => {
  const f = fake([json(401, {})]);
  await assert.rejects(() => createHttp({ auth: mkAuth({ onUnauthorized: async () => false }), fetch: f.fetch }).get('/x'), SignInNeeded);
  assert.strictEqual(f.calls.length, 1);
});
test('SignInNeeded thrown by auth propagates from get and send', async () => {
  const boom = () => { throw new SignInNeeded('refreshFailed'); };
  const f = fake([() => json(401, {})]);
  const h = createHttp({ auth: mkAuth({ onUnauthorized: boom }), fetch: f.fetch });
  await assert.rejects(() => h.get('/x'), (e) => e.reason === 'refreshFailed');
  await assert.rejects(() => h.send('PUT', '/x', {}), (e) => e.reason === 'refreshFailed');
  const h2 = createHttp({ auth: mkAuth({ header: boom }), fetch: f.fetch });
  await assert.rejects(() => h2.get('/x'), SignInNeeded);
});
test('send with read:true (POST search) retries like get', async () => {
  const f = fake([json(401, {}), json(200, { ok: 1 })]);
  const h = createHttp({ auth: mkAuth(), fetch: f.fetch });
  assert.deepStrictEqual(await h.send('POST', '/x', { a: 1 }, { read: true }), { ok: 1 });
  assert.strictEqual(f.calls.length, 2);
});
test('send on 401 calls onUnauthorized and throws JiraError 401 without resending', async () => {
  let n = 0; const f = fake([json(401, {}), json(200, {})]);
  const h = createHttp({ auth: mkAuth({ onUnauthorized: async () => { n++; return true; } }), fetch: f.fetch });
  await assert.rejects(() => h.send('POST', '/x', { a: 1 }), (e) => e instanceof JiraError && e.status === 401);
  assert.strictEqual(f.calls.length, 1); assert.strictEqual(n, 1);
});
test('429 carries retryAfterMs; network failure is Offline; abort is Timeout', async () => {
  const f = fake([json(429, {}, { 'Retry-After': '7' })]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: f.fetch }).get('/x'), (e) => e instanceof JiraError && e.status === 429 && e.retryAfterMs === 7000);
  const g = fake([json(503, {})]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: g.fetch }).get('/x'), (e) => e.status === 503 && e.retryAfterMs === null);
  const off = fake([new TypeError('fetch failed')]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: off.fetch }).get('/x'), (e) => e instanceof Offline && e.name === 'Offline');
  const hang = fake([(init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: hang.fetch, timeoutMs: 20 }).get('/x'), (e) => e instanceof Timeout && e.name === 'Timeout');
});
test('Jira error messages are collected', async () => {
  const f = fake([json(400, { errorMessages: ['Bad thing'], errors: { duedate: 'Invalid date' } })]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: f.fetch }).send('PUT', '/x', {}), (e) => {
    assert.deepStrictEqual(e.messages, ['Bad thing', 'Invalid date']); assert.strictEqual(e.status, 400); assert.match(e.message, /Bad thing/); return true;
  });
  const g = fake([new Response('<html>', { status: 500 })]);
  await assert.rejects(() => createHttp({ auth: mkAuth(), fetch: g.fetch }).get('/x'), (e) => e.status === 500 && e.messages.length === 0);
});
test('requests use auth.baseUrl and the auth header, encode the query, and log nothing', async () => {
  const logs = []; const saved = {};
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) { saved[k] = console[k]; console[k] = (...a) => logs.push(a); }
  const f = fake([json(200, { a: 1 }), json(204, null), new Response('', { status: 200 })]);
  const h = createHttp({ auth: mkAuth(), fetch: f.fetch });
  try {
    await h.get('/rest/api/3/user/search', { query: 'a b&c', skip: undefined, n: 5 });
    assert.strictEqual(await h.send('PUT', '/rest/api/3/issue/DEMO-1', { fields: {} }), null);
    assert.strictEqual(await h.get('/empty'), null);
  } finally { Object.assign(console, saved); }
  assert.strictEqual(f.calls[0].url, 'https://api.example.test/ex/jira/c1/rest/api/3/user/search?query=a%20b%26c&n=5');
  assert.strictEqual(f.calls[0].init.method, 'GET'); assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer t');
  assert.strictEqual(f.calls[1].init.method, 'PUT'); assert.strictEqual(f.calls[1].init.body, JSON.stringify({ fields: {} }));
  assert.strictEqual(f.calls[1].init.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(logs, []);
});

test('get with refresh false: a 401 is a plain JiraError, with no refresh and no retry', async () => {
  let n = 0; const f = fake([json(401, {})]);
  const h = createHttp({ auth: mkAuth({ onUnauthorized: async () => { n++; return true; } }), fetch: f.fetch });
  await assert.rejects(() => h.get('/rest/agile/1.0/board', { projectKeyOrId: 'DEMO' }, { refresh: false }), (e) => e instanceof JiraError && e.status === 401 && !(e instanceof SignInNeeded));
  assert.strictEqual(f.calls.length, 1); assert.strictEqual(n, 0);
  const ok = fake([json(200, { values: [] })]);
  assert.deepStrictEqual(await createHttp({ auth: mkAuth(), fetch: ok.fetch }).get('/x', { a: 1 }, { refresh: false }), { values: [] });
  assert.ok(ok.calls[0].url.endsWith('/x?a=1'));
});

const WIKI = 'https://example.atlassian.net/wiki';
test('a Confluence 401 after one refresh is ConfluenceUnavailable, not SignInNeeded', async () => {
  const f = fake([json(401, {}), json(401, {})]); let n = 0;
  const h = createHttp({ auth: mkAuth({ onUnauthorized: async () => { n++; return true; } }), fetch: f.fetch, base: () => WIKI, product: 'Confluence', unavailableOn401: true });
  await assert.rejects(() => h.get('/api/v2/spaces'), (e) => e instanceof ConfluenceUnavailable && e.name === 'ConfluenceUnavailable' && e.status === 401 && !(e instanceof SignInNeeded));
  assert.strictEqual(f.calls.length, 2); assert.strictEqual(n, 1);
});
test('unavailableOn401 with onUnauthorized false is ConfluenceUnavailable without a retry', async () => {
  const f = fake([json(401, {})]);
  const h = createHttp({ auth: mkAuth({ onUnauthorized: async () => false }), fetch: f.fetch, unavailableOn401: true });
  await assert.rejects(() => h.get('/x'), ConfluenceUnavailable);
  assert.strictEqual(f.calls.length, 1);
});
test('unavailableOn401: a refresh that works retries once; SignInNeeded from onUnauthorized propagates', async () => {
  const f = fake([json(401, {}), json(200, { ok: 1 })]);
  assert.deepStrictEqual(await createHttp({ auth: mkAuth(), fetch: f.fetch, unavailableOn401: true }).get('/x'), { ok: 1 });
  const boom = () => { throw new SignInNeeded('refreshFailed'); };
  const g = fake([json(401, {})]);
  await assert.rejects(() => createHttp({ auth: mkAuth({ onUnauthorized: boom }), fetch: g.fetch, unavailableOn401: true }).get('/x'), (e) => e instanceof SignInNeeded && e.reason === 'refreshFailed');
});
test('Confluence error bodies become messages', async () => {
  const h = (r) => createHttp({ auth: mkAuth(), fetch: fake([r]).fetch, product: 'Confluence' });
  await assert.rejects(() => h(json(400, { errors: [{ title: 'Bad ADF', detail: 'paragraph' }] })).get('/x'), (e) => e instanceof JiraError && e.status === 400 && e.messages.length === 1 && e.messages[0] === 'Bad ADF: paragraph');
  await assert.rejects(() => h(json(409, { message: 'Version conflict' })).get('/x'), (e) => e.status === 409 && e.messages[0] === 'Version conflict' && e.messages.length === 1);
  await assert.rejects(() => h(json(400, { errors: [{ title: 'Only title' }] })).get('/x'), (e) => e.messages[0] === 'Only title');
});
test('base and product: the wiki base is used and the empty-body message names Confluence', async () => {
  const f = fake([new Response('', { status: 500 })]);
  const h = createHttp({ auth: mkAuth(), fetch: f.fetch, base: () => WIKI, product: 'Confluence' });
  await assert.rejects(() => h.get('/api/v2/spaces', { limit: 1 }), (e) => e instanceof JiraError && e.message === 'Confluence returned 500');
  assert.strictEqual(f.calls[0].url, WIKI + '/api/v2/spaces?limit=1');
});
test("ConfluenceUnavailable's message is the spec's copy", () => {
  assert.strictEqual(new ConfluenceUnavailable().message, "Confluence isn't available with this sign-in");
});
