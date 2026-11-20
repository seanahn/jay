'use strict';
// Credentials: an Atlassian API token, or a token file another tool keeps (design 101, "Signing in").
// jay never writes the token file; a refresh is the user's command, serialised across windows by lockDir/refresh.lock.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REFRESH_MARGIN_S = 240; // below jira-mcp's 300, so a token we just refreshed is never "expiring" to jay
const REFRESH_TIMEOUT_MS = 60000;
const LOCK_POLL_MS = 200;
const LOCK_STALE_MS = 90000;
const STDERR_KEEP = 2000;
const STDERR_GRACE_MS = 100;

class SignInNeeded extends Error {
  constructor(reason) { super(`sign-in needed: ${reason}`); this.name = 'SignInNeeded'; this.reason = reason; }
}

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

function createApiTokenAuth({ site, email, token }) {
  const base = stripSlash(site);
  return {
    kind: 'apiToken',
    baseUrl: () => base,
    siteUrl: () => base,
    wikiBaseUrl: () => base + '/wiki',
    confluenceAccess: () => 'full',
    header: async () => 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
    onUnauthorized: async () => false,
    describe: () => 'API token',
    email: () => email || null,
  };
}

function runCommand(cmd, { timeoutMs }) {
  return new Promise((resolve) => {
    let stderr = '', timedOut = false, done = false;
    const child = spawn(cmd, { shell: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
    // Never wait on the stderr pipe: a background process the command left behind can hold it open for as long as it likes.
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer); child.stderr.destroy();
      resolve({ code, timedOut, stderr: stderr.slice(-STDERR_KEEP) });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); finish(null); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => setTimeout(() => finish(code), STDERR_GRACE_MS)); // 'close' normally wins and has all of stderr
  });
}

function jwtExp(token) {
  try { const exp = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).exp; return typeof exp === 'number' ? exp : null; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createTokenFileAuth({ file, refreshCommand, lockDir, run = runCommand, now = Date.now, lockPollMs = LOCK_POLL_MS, lockStaleMs = LOCK_STALE_MS }) {
  let cache = null;        // { sig, creds }: the file as last read, keyed by mtime and size
  let used = null;         // the access token last handed out, so onUnauthorized knows what was rejected
  let accepted = false;    // the command exited 0 but the token is still expiring: use it until a 401 (or it really expires)
  let inflight = null;

  function read() {
    let st, creds;
    try { st = fs.statSync(file); } catch { throw new SignInNeeded('none'); }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.sig === sig) return cache;
    try { creds = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new SignInNeeded('none'); }
    if (!creds || !creds.access_token) throw new SignInNeeded('none');
    return (cache = { sig, creds });
  }
  const secsLeft = (c) => { const e = jwtExp(c.creds.access_token); return e === null ? Infinity : e - now() / 1000; };
  const expiring = (c) => secsLeft(c) <= REFRESH_MARGIN_S;

  // The lock file holds its owner's id. Release only removes our own; a stale lock is moved aside and checked
  // to be the very file we judged stale before it is deleted.
  async function takeLock() {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lock = path.join(lockDir, 'refresh.lock'), id = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    for (;;) {
      try { const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, id); return { fd, lock, id }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      let st;
      try { st = fs.statSync(lock); } catch { continue; } // released just now; retry
      if (Date.now() - st.mtimeMs <= lockStaleMs) { await sleep(lockPollMs); continue; }
      const aside = `${lock}.${id}`;
      try { fs.renameSync(lock, aside); } catch { continue; }
      const moved = fs.statSync(aside);
      if (moved.ino !== st.ino || moved.mtimeMs !== st.mtimeMs) { try { fs.linkSync(aside, lock); } catch { /* a newer lock exists; ours is lost */ } } // not the one we judged: put it back
      fs.unlinkSync(aside);
    }
  }
  function releaseLock({ fd, lock, id }) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { if (fs.readFileSync(lock, 'utf8') === id) fs.unlinkSync(lock); } catch { /* gone or not ours */ }
  }

  async function refresh(force) {
    const held = await takeLock();
    try {
      let c = read(); // another window may have refreshed while we waited
      if (force ? c.creds.access_token !== used : !expiring(c)) return c;
      if (!refreshCommand) { if (secsLeft(c) <= 0) throw new SignInNeeded('expired'); return c; }
      const r = await run(refreshCommand, { timeoutMs: REFRESH_TIMEOUT_MS });
      if (r.code !== 0 || r.timedOut) throw new SignInNeeded('refreshFailed');
      c = read();
      if (expiring(c)) accepted = true;
      return c;
    } finally { releaseLock(held); }
  }
  const single = (force) => (inflight || (inflight = refresh(force).finally(() => { inflight = null; })));

  return {
    kind: 'tokenFile',
    baseUrl: () => `https://api.atlassian.com/ex/jira/${read().creds.cloud_id}`,
    siteUrl: () => stripSlash(read().creds.jira_url),
    wikiBaseUrl: () => `https://api.atlassian.com/ex/confluence/${read().creds.cloud_id}/wiki`,
    confluenceAccess() {
      const scopes = String(read().creds.scope || '').split(/\s+/);
      return scopes.includes('write:page:confluence') ? 'full' : scopes.includes('read:page:confluence') ? 'read' : 'none';
    },
    async header() {
      let c = read();
      if (!expiring(c)) accepted = false;
      else if ((!accepted || secsLeft(c) <= 0) && (refreshCommand || secsLeft(c) <= 0)) c = await single(false);
      used = c.creds.access_token;
      return 'Bearer ' + used;
    },
    // May throw SignInNeeded (e.g. 'refreshFailed') instead of resolving false; callers let it propagate.
    async onUnauthorized() {
      accepted = false;
      if (!refreshCommand) { const c = read(); return c.creds.access_token !== used; }
      await single(true);
      return true;
    },
    describe: () => 'token file',
  };
}

// NAME=value lines of a jira-mcp wrapper or env file: optional `export`, optional matching quotes. Never executed.
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2];
    out[m[1]] = v;
  }
  return out;
}

// Basic auth from JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN in a file another tool keeps. No refresh: an API token doesn't expire like OAuth.
function createEnvFileAuth({ file }) {
  let cache = null, used = null;
  function read() {
    let st, text;
    try { st = fs.statSync(file); } catch { throw new SignInNeeded('none'); }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.sig === sig) return cache;
    try { text = fs.readFileSync(file, 'utf8'); } catch { throw new SignInNeeded('none'); }
    const v = parseEnv(text);
    if (!v.JIRA_URL || !v.JIRA_USERNAME || !v.JIRA_API_TOKEN) throw new SignInNeeded('envFile');
    return (cache = { sig, base: stripSlash(v.JIRA_URL), user: v.JIRA_USERNAME, token: v.JIRA_API_TOKEN });
  }
  return {
    kind: 'envFile',
    baseUrl: () => read().base,
    siteUrl: () => read().base,
    wikiBaseUrl: () => read().base + '/wiki',
    confluenceAccess: () => 'full',
    async header() { const c = read(); used = c.token; return 'Basic ' + Buffer.from(`${c.user}:${c.token}`).toString('base64'); },
    async onUnauthorized() { return read().token !== used; },
    describe: () => 'token file',
    email() { try { return read().user; } catch { return null; } },
  };
}

// The token-file setting: OAuth JSON (first non-blank char `{`) or an env file. The format is decided from the file on every use.
function createFileAuth(opts) {
  const oauth = createTokenFileAuth(opts), env = createEnvFileAuth({ file: opts.file });
  let sig = null, cur = oauth;
  function pick() {
    let st;
    try { st = fs.statSync(opts.file); } catch { return cur; } // the delegate reports the missing file
    const k = `${st.mtimeMs}:${st.size}`;
    if (k !== sig) {
      try { cur = /^\s*\{/.test(fs.readFileSync(opts.file, 'utf8')) ? oauth : env; sig = k; } catch { /* keep the last format */ }
    }
    return cur;
  }
  return {
    get kind() { return cur.kind; },
    baseUrl: () => pick().baseUrl(),
    siteUrl: () => pick().siteUrl(),
    wikiBaseUrl: () => pick().wikiBaseUrl(),
    confluenceAccess: () => pick().confluenceAccess(),
    header: () => pick().header(),
    onUnauthorized: () => pick().onUnauthorized(),
    describe: () => cur.describe(),
    email: () => (cur.email ? cur.email() : null),
  };
}

module.exports = { SignInNeeded, createApiTokenAuth, createTokenFileAuth, createEnvFileAuth, createFileAuth, runCommand, REFRESH_MARGIN_S, REFRESH_TIMEOUT_MS };
