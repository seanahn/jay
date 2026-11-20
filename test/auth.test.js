'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { SignInNeeded, createApiTokenAuth, createTokenFileAuth, createFileAuth, runCommand, REFRESH_MARGIN_S } = require('../src/auth');

const NOW = 1_800_000_000_000;
const jwt = (expSec, tag = 'x') => `h.${Buffer.from(JSON.stringify({ exp: expSec, tag })).toString('base64url')}.sig`;
const fresh = (tag) => jwt(NOW / 1000 + 3600, tag);
const dying = (tag) => jwt(NOW / 1000 + 60, tag);
const dead = (tag) => jwt(NOW / 1000 - 60, tag);
function setup(access) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-auth-'));
  const file = path.join(dir, 'credentials.json'), lockDir = path.join(dir, 'locks');
  let n = 0;
  const write = (tok) => { fs.writeFileSync(file, JSON.stringify({ access_token: tok, refresh_token: 'r', cloud_id: 'cloud-1', jira_url: 'https://example.atlassian.net', token_type: 'Bearer' })); const t = new Date(Date.now() + 1000 * ++n); fs.utimesSync(file, t, t); };
  write(access);
  return { dir, file, lockDir, write };
}
const mk = (s, o = {}) => createTokenFileAuth({ file: s.file, refreshCommand: 'your-login --refresh', lockDir: s.lockDir, now: () => NOW, ...o });
const calls = () => { const c = []; return { c, run: async (cmd, opts) => { c.push([cmd, opts]); return { code: 0, timedOut: false, stderr: '' }; } }; };

test('api token header is basic of email:token and baseUrl strips trailing slash', async () => {
  const a = createApiTokenAuth({ site: 'https://example.atlassian.net//', email: 'a@example.com', token: 'tok' });
  assert.strictEqual(a.kind, 'apiToken'); assert.strictEqual(a.baseUrl(), 'https://example.atlassian.net'); assert.strictEqual(a.siteUrl(), 'https://example.atlassian.net');
  assert.strictEqual(await a.header(), 'Basic ' + Buffer.from('a@example.com:tok').toString('base64'));
  assert.strictEqual(await a.onUnauthorized(), false); assert.strictEqual(a.describe(), 'API token');
});
test('token file builds the ex/jira base url from cloud_id and siteUrl from jira_url', async () => {
  const s = setup(fresh()); const a = mk(s);
  assert.strictEqual(await a.header(), 'Bearer ' + fresh()); // also loads the file
  assert.strictEqual(a.baseUrl(), 'https://api.atlassian.com/ex/jira/cloud-1'); assert.strictEqual(a.siteUrl(), 'https://example.atlassian.net');
  assert.strictEqual(a.kind, 'tokenFile'); assert.strictEqual(a.describe(), 'token file');
});
test('fresh token: no command run', async () => {
  const s = setup(fresh()); const r = calls(); await mk(s, { run: r.run }).header(); assert.strictEqual(r.c.length, 0);
});
test('expiring token runs the command once, then uses the reread file', async () => {
  const s = setup(dying()); const c = []; const a = mk(s, { run: async (cmd, o) => { c.push([cmd, o]); s.write(fresh('new')); return { code: 0, timedOut: false, stderr: '' }; } });
  assert.strictEqual(await a.header(), 'Bearer ' + fresh('new')); await a.header();
  assert.strictEqual(c.length, 1); assert.strictEqual(c[0][0], 'your-login --refresh'); assert.strictEqual(c[0][1].timeoutMs, 60000);
  assert.ok(!fs.existsSync(path.join(s.lockDir, 'refresh.lock')));
});
test('exit 0 but still expiring: token used, command not re-run on the next header()', async () => {
  const s = setup(dying('old')); const r = calls(); const a = mk(s, { run: r.run });
  assert.strictEqual(await a.header(), 'Bearer ' + dying('old')); await a.header();
  assert.strictEqual(r.c.length, 1);
  s.write(dying('newer')); assert.strictEqual(await a.header(), 'Bearer ' + dying('newer')); // a changed file is re-read but never re-runs the command
  assert.strictEqual(r.c.length, 1);
  s.write(dead('gone')); await a.header(); assert.strictEqual(r.c.length, 2); // really expired: the command runs again
});
test('non-zero exit throws SignInNeeded refreshFailed', async () => {
  const s = setup(dying('SECRETTOK')); const a = mk(s, { run: async () => ({ code: 1, timedOut: false, stderr: 'boom' }) });
  await assert.rejects(a.header(), (e) => { assert.ok(e instanceof SignInNeeded); assert.strictEqual(e.reason, 'refreshFailed'); assert.ok(!String(e).includes('SECRETTOK')); return true; });
  assert.ok(!fs.existsSync(path.join(s.lockDir, 'refresh.lock')));
  const b = mk(s, { run: async () => ({ code: null, timedOut: true, stderr: '' }) });
  await assert.rejects(b.header(), (e) => e.reason === 'refreshFailed');
});
test('no command and expired throws SignInNeeded expired', async () => {
  const s = setup(dead('SECRETTOK')); const a = mk(s, { refreshCommand: '' });
  await assert.rejects(a.header(), (e) => { assert.strictEqual(e.reason, 'expired'); assert.ok(!String(e).includes('SECRETTOK')); return true; });
  s.write(dying()); assert.match(await a.header(), /^Bearer /); // expiring but not expired: still usable
});
test('missing token file throws SignInNeeded none', async () => {
  const s = setup(fresh()); fs.unlinkSync(s.file);
  await assert.rejects(mk(s).header(), (e) => e instanceof SignInNeeded && e.reason === 'none');
});
test('two auths share one refresh through the lock', async () => {
  const s = setup(dying()); let ran = 0;
  const run = async () => { ran++; await new Promise((r) => setTimeout(r, 300)); s.write(fresh('new')); return { code: 0, timedOut: false, stderr: '' }; };
  const [h1, h2] = await Promise.all([mk(s, { run }).header(), mk(s, { run }).header()]);
  assert.strictEqual(ran, 1); assert.strictEqual(h1, 'Bearer ' + fresh('new')); assert.strictEqual(h2, h1);
});
test('stale lock older than 90 s is taken over', async () => {
  const s = setup(dying()); fs.mkdirSync(s.lockDir, { recursive: true }); const lock = path.join(s.lockDir, 'refresh.lock');
  fs.writeFileSync(lock, ''); const old = new Date(Date.now() - 100_000); fs.utimesSync(lock, old, old);
  const r = calls(); await mk(s, { run: r.run }).header(); assert.strictEqual(r.c.length, 1);
});
test('a live lock is waited for, then released', async () => {
  const s = setup(dying()); fs.mkdirSync(s.lockDir, { recursive: true }); const lock = path.join(s.lockDir, 'refresh.lock'); fs.writeFileSync(lock, '');
  setTimeout(() => { s.write(fresh('other')); fs.unlinkSync(lock); }, 250);
  const r = calls(); assert.strictEqual(await mk(s, { run: r.run }).header(), 'Bearer ' + fresh('other')); assert.strictEqual(r.c.length, 0);
});
test('onUnauthorized forces a refresh even when exp looks fresh', async () => {
  const s = setup(fresh('old')); const c = [];
  const a = mk(s, { run: async (cmd) => { c.push(cmd); s.write(fresh('new')); return { code: 0, timedOut: false, stderr: '' }; } });
  assert.strictEqual(await a.header(), 'Bearer ' + fresh('old')); assert.strictEqual(c.length, 0);
  assert.strictEqual(await a.onUnauthorized(), true); assert.strictEqual(c.length, 1);
  assert.strictEqual(await a.header(), 'Bearer ' + fresh('new'));
});
test('onUnauthorized skips the command when another window already replaced the token', async () => {
  const s = setup(fresh('old')); const r = calls(); const a = mk(s, { run: r.run });
  await a.header(); s.write(fresh('other')); assert.strictEqual(await a.onUnauthorized(), true); assert.strictEqual(r.c.length, 0);
});
test('onUnauthorized with no command is false unless the file changed', async () => {
  const s = setup(fresh('old')); const a = mk(s, { refreshCommand: '' }); await a.header();
  assert.strictEqual(await a.onUnauthorized(), false); s.write(fresh('new')); assert.strictEqual(await a.onUnauthorized(), true);
});
test('runCommand kills a command that outlives the timeout', async () => {
  const t0 = Date.now(); const r = await runCommand('sleep 5', { timeoutMs: 200 });
  assert.strictEqual(r.timedOut, true); assert.ok(Date.now() - t0 < 1000);
});
test('runCommand does not wait for a background process holding stderr', async () => {
  const t0 = Date.now(); const r = await runCommand('(sleep 3 &); exit 0', { timeoutMs: 20000 });
  assert.strictEqual(r.code, 0); assert.strictEqual(r.timedOut, false); assert.ok(Date.now() - t0 < 1000);
  const t1 = Date.now(); const k = await runCommand('setsid sleep 3 & sleep 10', { timeoutMs: 200 });
  assert.strictEqual(k.timedOut, true); assert.ok(Date.now() - t1 < 1000);
});
test('a taken-over stale lock is not deleted by its former owner', async () => {
  const s = setup(dying()); const lock = path.join(s.lockDir, 'refresh.lock');
  let gateA, gateB, bStarted; const pa = new Promise((r) => { gateA = r; }), pb = new Promise((r) => { gateB = r; }), started = new Promise((r) => { bStarted = r; });
  const A = mk(s, { run: async () => { await pa; return { code: 0, timedOut: false, stderr: '' }; } });
  const B = mk(s, { lockStaleMs: 50, lockPollMs: 10, run: async () => { bStarted(); await pb; return { code: 0, timedOut: false, stderr: '' }; } });
  const ha = A.header(); await new Promise((r) => setTimeout(r, 20));
  const hb = B.header(); await started; // B has taken A's lock over as stale
  const bId = fs.readFileSync(lock, 'utf8');
  gateA(); await ha; // A releases
  assert.ok(fs.existsSync(lock)); assert.strictEqual(fs.readFileSync(lock, 'utf8'), bId);
  gateB(); await hb; assert.ok(!fs.existsSync(lock));
});
test('runCommand reports exit code and the tail of stderr', async () => {
  const r = await runCommand('echo bad >&2; exit 3', { timeoutMs: 5000 });
  assert.deepStrictEqual({ code: r.code, timedOut: r.timedOut }, { code: 3, timedOut: false }); assert.strictEqual(r.stderr.trim(), 'bad');
  assert.strictEqual((await runCommand('head -c 5000 /dev/zero | tr "\\0" x >&2', { timeoutMs: 5000 })).stderr.length, 2000);
  assert.strictEqual(REFRESH_MARGIN_S, 240);
});
test('the token never appears in error messages', async () => {
  const tok = 'SECRETTOK'; const errs = [];
  const s1 = setup(dying(tok)); const s2 = setup(dead(tok)); const s3 = setup(fresh(tok)); fs.writeFileSync(s3.file, '{not json ' + tok);
  for (const p of [mk(s1, { run: async () => ({ code: 2, timedOut: false, stderr: tok }) }).header(), mk(s2, { refreshCommand: '' }).header(), mk(s3).header()]) {
    try { await p; assert.fail('should throw'); } catch (e) { errs.push(String(e)); }
  }
  assert.strictEqual(errs.length, 3); for (const e of errs) assert.ok(!e.includes(tok) && !e.includes(dying(tok).split('.')[1]));
});

// ---- env / jira-mcp wrapper files
const WRAPPER = (tok, url = 'https://example.atlassian.net/') => `#!/bin/bash
# a comment
export JIRA_URL="${url}"
export JIRA_USERNAME=alex@example.com
JIRA_API_TOKEN='${tok}'
exec /home/u/.local/bin/mcp-atlassian "$@"
`;
function envSetup(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-env-')); const file = path.join(dir, 'jira-mcp'); let n = 0;
  const write = (t) => { fs.writeFileSync(file, t); const d = new Date(Date.now() + 1000 * ++n); fs.utimesSync(file, d, d); };
  write(text);
  return { dir, file, lockDir: path.join(dir, 'locks'), write };
}
const mkf = (s, o = {}) => createFileAuth({ file: s.file, refreshCommand: 'your-login --refresh', lockDir: s.lockDir, now: () => NOW, ...o });

test('env file: export, quotes and comments parsed; basic header; urls from JIRA_URL', async () => {
  const s = envSetup(WRAPPER('abc123')); const r = calls(); const a = mkf(s, { run: r.run });
  assert.strictEqual(await a.header(), 'Basic ' + Buffer.from('alex@example.com:abc123').toString('base64'));
  assert.strictEqual(a.baseUrl(), 'https://example.atlassian.net'); assert.strictEqual(a.siteUrl(), 'https://example.atlassian.net');
  assert.strictEqual(a.kind, 'envFile'); assert.strictEqual(a.describe(), 'token file');
  assert.strictEqual(r.c.length, 0, 'the refresh command never runs');
});
test('env file: a change on disk is picked up', async () => {
  const s = envSetup(WRAPPER('one')); const a = mkf(s);
  await a.header(); s.write(WRAPPER('two', 'https://other.atlassian.net'));
  assert.strictEqual(await a.header(), 'Basic ' + Buffer.from('alex@example.com:two').toString('base64'));
  assert.strictEqual(a.siteUrl(), 'https://other.atlassian.net');
});
test('env file: a missing name or missing file is SignInNeeded', async () => {
  const s = envSetup('export JIRA_URL=https://example.atlassian.net\nJIRA_USERNAME=a@example.com\n');
  const a = mkf(s);
  await assert.rejects(a.header(), (e) => e instanceof SignInNeeded && e.reason === 'envFile');
  assert.throws(() => a.siteUrl(), (e) => e instanceof SignInNeeded);
  const b = mkf({ ...s, file: path.join(s.dir, 'nope') });
  await assert.rejects(b.header(), (e) => e instanceof SignInNeeded && e.reason === 'none');
});
test('a JSON file still takes the OAuth path, even after leading blank lines', async () => {
  const s = setup(fresh()); const a = mkf(s);
  assert.strictEqual(await a.header(), 'Bearer ' + fresh()); assert.strictEqual(a.kind, 'tokenFile');
  assert.strictEqual(a.baseUrl(), 'https://api.atlassian.com/ex/jira/cloud-1');
  fs.writeFileSync(s.file, '\n  ' + fs.readFileSync(s.file, 'utf8')); const t = new Date(Date.now() + 99000); fs.utimesSync(s.file, t, t);
  assert.strictEqual(await a.header(), 'Bearer ' + fresh());
});
test('env file: onUnauthorized is true only when the token changed since the rejected one', async () => {
  const s = envSetup(WRAPPER('one')); const r = calls(); const a = mkf(s, { run: r.run });
  await a.header();
  assert.strictEqual(await a.onUnauthorized(), false);
  s.write(WRAPPER('two')); assert.strictEqual(await a.onUnauthorized(), true);
  assert.strictEqual(await a.header(), 'Basic ' + Buffer.from('alex@example.com:two').toString('base64'));
  assert.strictEqual(await a.onUnauthorized(), false);
  assert.strictEqual(r.c.length, 0);
});
test('env file: the token never appears in an error', async () => {
  const s = envSetup('JIRA_URL=https://example.atlassian.net\nJIRA_API_TOKEN=SECRETTOK\n'); const a = mkf(s);
  await assert.rejects(a.header(), (e) => { assert.ok(!String(e).includes('SECRETTOK') && !(e.stack || '').includes('SECRETTOK') && !e.reason.includes('SECRETTOK')); return true; });
});

test('wikiBaseUrl per sign-in kind', () => {
  assert.strictEqual(createApiTokenAuth({ site: 'https://example.atlassian.net/', email: 'a@example.com', token: 't' }).wikiBaseUrl(), 'https://example.atlassian.net/wiki');
  assert.strictEqual(mk(setup(fresh())).wikiBaseUrl(), 'https://api.atlassian.com/ex/confluence/cloud-1/wiki');
  assert.strictEqual(mkf(envSetup(WRAPPER('tok'))).wikiBaseUrl(), 'https://example.atlassian.net/wiki');
  assert.strictEqual(mkf(setup(fresh())).wikiBaseUrl(), 'https://api.atlassian.com/ex/confluence/cloud-1/wiki');
});
test('confluenceAccess reads the token file scope', () => {
  const withScope = (scope) => {
    const s = setup(fresh()); const c = JSON.parse(fs.readFileSync(s.file, 'utf8'));
    if (scope !== undefined) c.scope = scope;
    fs.writeFileSync(s.file, JSON.stringify(c)); return mk(s);
  };
  assert.strictEqual(withScope(undefined).confluenceAccess(), 'none');
  assert.strictEqual(withScope('read:jira-work').confluenceAccess(), 'none');
  assert.strictEqual(withScope('read:jira-work read:page:confluence').confluenceAccess(), 'read');
  assert.strictEqual(withScope('read:jira-work read:page:confluence write:page:confluence').confluenceAccess(), 'full');
  assert.strictEqual(createApiTokenAuth({ site: 'https://example.atlassian.net', email: 'a@example.com', token: 't' }).confluenceAccess(), 'full');
  assert.strictEqual(mkf(envSetup(WRAPPER('tok'))).confluenceAccess(), 'full');
  assert.strictEqual(mkf(setup(fresh())).confluenceAccess(), 'none');
});
