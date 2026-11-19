'use strict';
// What the second picker lists (design 101, "Periods: quarters, sprints or fix versions"): quarters, the project's sprints or
// its fix versions. Per mode: the choices, the default, the remembered choice, and the JQL clause for the members.
const { quarterChoices } = require('./quarters');
const { SignInNeeded } = require('./auth');

const KINDS = ['quarter', 'sprint', 'fixVersion'];
const STORE = { quarter: 'jay.quarter', sprint: 'jay.sprint', fixVersion: 'jay.version' };
const UNAVAILABLE = { sprint: 'Sprints not available with this sign-in', fixVersion: 'Versions not available with this sign-in' };
const LISTS = 'jay.periodLists';   // the last sprint/version list per mode and project, so a restart shows the cached view at once
const LIST_MS = 15 * 60000;        // as often as the tree's full reload
const MORE = 3;                    // future, closed or released choices shown
const REFUSED = new Set([401, 403, 404]);
const ID_RE = /^\d+$/;

const kindOf = (v) => (KINDS.includes(v) ? v : 'quarter');
const time = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
// by a time, ascending or descending; missing times last
const byTime = (f, dir) => (a, b) => {
  const x = time(f(a)), y = time(f(b));
  if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
  return dir * (x - y);
};

/** Active sprints (deduped by id, in Jira's order), then up to 3 future by start, then up to 3 closed by end (latest first). */
function sprintChoices(sprints) {
  const seen = new Set(); const list = [];
  for (const s of sprints || []) {
    const id = s && String(s.id);
    if (s && ID_RE.test(id) && !seen.has(id)) { seen.add(id); list.push(s); }
  }
  const of = (state) => list.filter((s) => s.state === state);
  const pick = (s, label) => ({ id: String(s.id), label, state: s.state });
  return [
    ...of('active').map((s) => pick(s, s.name)),
    ...of('future').sort(byTime((s) => s.startDate, 1)).slice(0, MORE).map((s) => pick(s, `${s.name} (future)`)),
    ...of('closed').sort(byTime((s) => s.endDate, -1)).slice(0, MORE).map((s) => pick(s, `${s.name} (closed)`)),
    { id: 'any', label: 'Any sprint' },
  ];
}

/** Unreleased, unarchived versions in Jira's (release) order, then up to 3 released ones, latest first. */
function versionChoices(versions) {
  const list = (versions || []).filter((v) => v && ID_RE.test(String(v.id)) && !v.archived);
  return [
    ...list.filter((v) => !v.released).map((v) => ({ id: String(v.id), label: v.name, state: 'unreleased' })),
    ...list.filter((v) => v.released).sort(byTime((v) => v.releaseDate, -1)).slice(0, MORE)
      .map((v) => ({ id: String(v.id), label: `${v.name} (released)`, state: 'released' })),
    { id: 'any', label: 'Any version' },
  ];
}

/** The default: the first active sprint or unreleased version, else any. */
function defaultOf(kind, choices) {
  const first = choices.find((c) => c.state === (kind === 'sprint' ? 'active' : 'unreleased'));
  return first ? first.id : 'any';
}

/** The JQL clause that makes a ticket a member of a sprint or version period. */
function periodJql({ kind, id }) {
  if (id !== 'any' && !ID_RE.test(String(id))) throw new Error(`bad ${kind} id`);
  if (kind === 'sprint') return id === 'any' ? 'sprint in openSprints()' : `sprint = ${id}`;
  if (kind === 'fixVersion') return id === 'any' ? 'fixVersion in unreleasedVersions()' : `fixVersion = ${id}`;
  throw new Error(`not a member period: ${kind}`);
}

/**
 * The host's period selection. select(project) is synchronous, from what ensure(project) last fetched.
 * @param api boards, sprints, versions; @param store globalState; @param cfg (key, default) for jay.* settings
 */
function createPeriods({ api, store, cfg, now = Date.now }) {
  const lists = Object.assign({}, store.get(LISTS) || {});   // `${kind}|${project}` -> { at, choices, refused }
  let gen = 0;   // moves on at clear(): a fetch still in flight then keeps nothing
  const setting = () => kindOf(cfg('period', 'quarter'));
  const keyOf = (kind, project) => `${kind}|${project}`;
  const shown = (choices) => choices.map(({ id, label }) => ({ id, label }));

  function quarterPick(setting0, note) {
    const quarters = quarterChoices(new Date(now()), cfg('quarter.fiscalYearStart', 1));
    const stored = store.get(STORE.quarter) || 'current';
    const quarter = stored === 'any' ? 'any' : quarters.find((c) => c.id === stored && c.id !== 'any') || quarters[1];
    return { kind: 'quarter', setting: setting0, choices: shown(quarters), id: quarter === 'any' ? 'any' : quarter.id, period: quarter, defaultId: quarters[1].id, note };
  }

  /**
   * kind is what the view uses (quarter when the setting's list was refused); period is the loader's input (a quarter,
   * 'any', or { kind, id }), null until the list has loaded; note is the picker note.
   */
  function select(project) {
    const kind = setting();
    if (kind === 'quarter') return quarterPick(kind, null);
    const entry = project ? lists[keyOf(kind, project)] : null;
    if (entry && entry.refused) return quarterPick(kind, UNAVAILABLE[kind]);
    if (!entry) return { kind, setting: kind, choices: [], id: null, period: null, defaultId: null, note: null };
    const def = defaultOf(kind, entry.choices);
    const stored = store.get(STORE[kind]) || 'current';
    const id = stored !== 'current' && entry.choices.some((c) => c.id === stored) ? stored : def;
    return { kind, setting: kind, choices: shown(entry.choices), id, period: { kind, id }, defaultId: def, note: null };
  }

  // A kanban board (400) or a board this sign-in may not read (401/403/404) is skipped; when every board with sprints
  // refused, the whole list counts as refused.
  async function sprintsOf(project) {
    const out = []; let ok = 0, refused = null;
    for (const b of await api.boards(project)) {
      try { out.push(...await api.sprints(b.id)); ok++; } catch (e) {
        if (e && REFUSED.has(e.status)) refused = e;
        else if (!(e && e.status === 400)) throw e;
      }
    }
    if (refused && !ok) throw refused;
    return out;
  }

  /** Fetches the setting's list for the project when missing or 15 minutes old. True when it fetched. */
  async function ensure(project) {
    const kind = setting();
    if (kind === 'quarter' || !project) return false;
    const k = keyOf(kind, project); const e = lists[k];
    if (e && now() - e.at < LIST_MS) return false;
    const g0 = gen; let entry;
    try {
      entry = { at: now(), choices: kind === 'sprint' ? sprintChoices(await sprintsOf(project)) : versionChoices(await api.versions(project)) };
    } catch (err) {
      if (err instanceof SignInNeeded) throw err;
      if (!(err && REFUSED.has(err.status))) {
        // offline, throttled, a 500: an older list still serves, tried again in 15 minutes; with none the poller handles it
        if (!e || g0 !== gen) throw err;
        e.at = now(); store.update(LISTS, lists);
        return false;
      }
      entry = { at: now(), choices: [], refused: true };
    }
    if (g0 !== gen) return false;
    lists[k] = entry; store.update(LISTS, lists);
    return true;
  }

  /** Remembers a pick from the page if it is one of the current choices; the default is stored as 'current', to follow. */
  function choose(project, id) {
    const p = select(project);
    if (typeof id !== 'string' || !p.choices.some((c) => c.id === id)) return false;
    store.update(STORE[p.kind], id === p.defaultId ? 'current' : id);
    return true;
  }

  function markStale() { for (const e of Object.values(lists)) e.at = 0; }
  /** Sign-out: the lists are Jira data. */
  function clear() { gen++; for (const k of Object.keys(lists)) delete lists[k]; store.update(LISTS, undefined); }

  return { select, ensure, choose, markStale, clear, setting };
}

module.exports = { KINDS, UNAVAILABLE, kindOf, sprintChoices, versionChoices, defaultOf, periodJql, createPeriods };
