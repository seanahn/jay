'use strict';
// HTTP to Jira: auth header, one retry for reads on 401, never any retry for writes, typed errors.
const { SignInNeeded } = require('./auth');

class JiraError extends Error {
  constructor(status, messages = [], retryAfterMs = null) {
    super(messages.length ? messages.join('; ') : `Jira returned ${status}`);
    this.name = 'JiraError'; this.status = status; this.retryAfterMs = retryAfterMs; this.messages = messages;
  }
}
class Offline extends Error { constructor(msg = 'offline') { super(msg); this.name = 'Offline'; } }
class Timeout extends Error { constructor(msg = 'request timed out') { super(msg); this.name = 'Timeout'; } }

function queryString(query) {
  const parts = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? '?' + parts.join('&') : '';
}
function errorMessages(body) {
  if (!body || typeof body !== 'object') return [];
  const out = Array.isArray(body.errorMessages) ? body.errorMessages.map(String) : [];
  if (body.errors && typeof body.errors === 'object') out.push(...Object.values(body.errors).map(String));
  return out;
}
function retryAfter(res) {
  const s = Number(res.headers.get('retry-after'));
  return res.headers.get('retry-after') !== null && Number.isFinite(s) ? s * 1000 : null;
}

function createHttp({ auth, fetch, timeoutMs = 30000 }) {
  async function once(method, path, query, body) {
    const headers = { Authorization: await auth.header(), Accept: 'application/json' };
    const init = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const ctl = new AbortController(); init.signal = ctl.signal;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(auth.baseUrl() + path + queryString(query), init);
      const text = await res.text();
      return { res, text };
    } catch (e) {
      throw ctl.signal.aborted || e.name === 'AbortError' ? new Timeout() : new Offline(e && e.message);
    } finally { clearTimeout(timer); }
  }
  const parse = (text) => { if (!text) return null; try { return JSON.parse(text); } catch { return null; } };
  function result({ res, text }) {
    const body = parse(text);
    if (res.status >= 200 && res.status < 300) return body;
    throw new JiraError(res.status, errorMessages(body), retryAfter(res));
  }

  // Reads (GET, or a POST that only reads, like search) retry once after a refresh; writes never do.
  async function read(method, path, query, body) {
    let r = await once(method, path, query, body);
    if (r.res.status === 401) {
      if (!(await auth.onUnauthorized())) throw new SignInNeeded('rejected');
      r = await once(method, path, query, body);
      if (r.res.status === 401) throw new SignInNeeded('rejected');
    }
    return result(r);
  }

  return {
    // refresh: false for calls whose refusal only means "not available" (the Agile API without its scopes): a 401 is then a
    // plain JiraError, with no refresh, no retry and no SignInNeeded
    get: (path, query, { refresh = true } = {}) => (refresh ? read('GET', path, query) : once('GET', path, query).then(result)),
    async send(method, path, body, { read: isRead = false } = {}) {
      if (isRead) return read(method, path, undefined, body);
      const r = await once(method, path, undefined, body);
      if (r.res.status === 401) await auth.onUnauthorized();
      return result(r);
    },
  };
}

module.exports = { JiraError, Offline, Timeout, createHttp };
