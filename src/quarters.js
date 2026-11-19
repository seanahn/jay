'use strict';
// Fiscal quarters and the patterns that mark an epic as in one. The fiscal year is named by the calendar year it ends in;
// patterns are 'label:' (exact label) or 'summary:' (part of the title) templates (design 101, "Quarters").
const pad2 = (n) => String(n % 100).padStart(2, '0');

function quarterOf(date, fyStart) {
  const m = date.getMonth() + 1, y = date.getFullYear();
  return { fy: fyStart === 1 || m < fyStart ? y : y + 1, q: Math.floor(((m - fyStart + 12) % 12) / 3) + 1 };
}
const quarterId = ({ fy, q }) => `FY${fy}Q${q}`;
const quarterLabel = ({ fy, q }) => `Q${q} FY${pad2(fy)}`;
function shiftQuarter({ fy, q }, n) { const i = fy * 4 + (q - 1) + n; return { fy: Math.floor(i / 4), q: (i % 4 + 4) % 4 + 1 }; }

function quarterChoices(now, fyStart) {
  const cur = quarterOf(now, fyStart);
  const list = [1, 0, -1, -2, -3, -4].map((n) => shiftQuarter(cur, n));
  return [...list.map((x) => ({ id: quarterId(x), label: quarterLabel(x), fy: x.fy, q: x.q })), { id: 'any', label: 'Any quarter' }];
}

function expandPattern(tpl, { fy, q }) {
  const i = tpl.indexOf(':');
  return { kind: tpl.slice(0, i) === 'label' ? 'label' : 'summary', text: tpl.slice(i + 1).replace(/\{YYYY\}/g, String(fy)).replace(/\{YY\}/g, pad2(fy)).replace(/\{Q\}/g, String(q)) };
}
const expandAll = (quarter, patterns) => patterns.map((p) => expandPattern(p, quarter));

function quarterMatches(issue, quarter, patterns) {
  if (quarter === 'any') return true;
  return expandAll(quarter, patterns).some((e) => e.kind === 'label' ? (issue.labels || []).includes(e.text) : String(issue.summary || '').includes(e.text));
}

const esc = (s) => s.replace(/[\\"]/g, '\\$&');
function quarterJql(quarter, patterns) {
  if (quarter === 'any') return '';
  const ex = expandAll(quarter, patterns);
  const labels = ex.filter((e) => e.kind === 'label').map((e) => `"${esc(e.text)}"`);
  const terms = ex.filter((e) => e.kind === 'summary').map((e) => e.text.replace(/[^A-Za-z0-9]+/g, ' ').trim()).filter(Boolean).map((t) => `summary ~ "\\"${esc(t)}\\""`);
  const parts = [...(labels.length ? [`labels in (${labels.join(', ')})`] : []), ...terms];
  return parts.length ? `(${parts.join(' OR ')})` : '';
}

module.exports = { quarterOf, quarterId, quarterLabel, shiftQuarter, quarterChoices, expandPattern, quarterMatches, quarterJql };
