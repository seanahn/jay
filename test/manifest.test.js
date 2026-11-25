'use strict';
const test = require('node:test'); const assert = require('node:assert');

test('manifest', () => {
  const p = require('../package.json');
  assert.strictEqual(p.name, 'jay'); assert.strictEqual(p.publisher, 'seanahn'); assert.strictEqual(p.license, 'MIT');
  assert.strictEqual(p.engines.vscode, '^1.90.0');
  assert.deepStrictEqual(Object.keys(p.dependencies || {}), []);
  const props = p.contributes.configuration.properties;
  assert.deepStrictEqual(Object.keys(props).sort(), ['jay.agentFiles','jay.columns','jay.confluence.enabled','jay.period','jay.placeholderAssignees','jay.quarter.fiscalYearStart',
    'jay.quarter.patterns','jay.signIn.refreshCommand','jay.signIn.tokenFile','jay.site','jay.ticketView']);
  assert.strictEqual(props['jay.quarter.fiscalYearStart'].default, 1);
  assert.deepStrictEqual(props['jay.quarter.patterns'].default, ['label:FY{YYYY}Q{Q}', 'label:FY{YY}-Q{Q}', 'summary:[Q{Q}FY{YY}]']);
  assert.deepStrictEqual(props['jay.placeholderAssignees'].default, []);
  assert.deepStrictEqual(props['jay.columns'].default, ['key', 'summary', 'status']);
  assert.deepStrictEqual(props['jay.columns'].items.enum, ['key', 'summary', 'assignee', 'status', 'type', 'priority', 'due', 'labels', 'estimate']);
  assert.strictEqual(props['jay.agentFiles'].default, true);
  // where the token goes and what runs: no workspace-capable scope, and not machine (remote windows ignore machine-scoped user values)
  for (const k of ['jay.site', 'jay.signIn.tokenFile', 'jay.signIn.refreshCommand']) assert.ok(!['resource', 'language-overridable', 'machine', 'machine-overridable'].includes(props[k].scope), k);
  assert.strictEqual(props['jay.period'].default, 'quarter');
  assert.deepStrictEqual(props['jay.period'].enum, ['quarter', 'sprint', 'fixVersion']);
  assert.strictEqual(props['jay.ticketView'].default, 'jay');
  assert.deepStrictEqual(props['jay.ticketView'].enum, ['atlassian', 'jay']);
  assert.strictEqual(props['jay.ticketView'].enumDescriptions.length, 2);
  assert.strictEqual(p.extensionDependencies, undefined, 'the Atlassian extension is a soft dependency');
  const hidden = p.contributes.menus.commandPalette.find((m) => m.command === 'jay.activeIssueFile');
  assert.strictEqual(hidden.when, 'false');
  assert.strictEqual(props['jay.confluence.enabled'].default, true);
  assert.strictEqual(props['jay.confluence.enabled'].type, 'boolean');
  assert.strictEqual(props['jay.confluence.enabled'].description, 'Show the Jira | Confluence switch and check Confluence for mentions.');
  assert.strictEqual(p.contributes.viewsContainers.activitybar[0].title, 'Jira and Confluence');
  assert.strictEqual(p.contributes.views.jay[0].name, 'Jira', 'the view title is set at run time');
  assert.ok(p.activationEvents.includes('onWebviewPanel:jay.page'));
  for (const c of ['jay.openTicket', 'jay.projectKeys', 'jay.openPage', 'jay.siteUrl', 'jay.activePageFile']) {
    assert.ok(p.contributes.commands.some((x) => x.command === c), c + ' is contributed');
    assert.strictEqual(p.contributes.menus.commandPalette.find((m) => m.command === c).when, 'false', c + ' is hidden');
  }
});

test('prosemirror bundle', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const { JSDOM } = require('jsdom');
  const file = path.join(__dirname, '..', 'media', 'prosemirror.js');
  assert.ok(fs.existsSync(file), 'media/prosemirror.js exists');
  assert.ok(fs.statSync(file).size < 400 * 1024, 'bundle under 400 KB');
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(typeof dom.window.PM.model.Schema, 'function');
  for (const k of ['model','state','view','transform','keymap','commands','history','inputrules','schemaList','dropcursor','gapcursor']) {
    assert.ok(dom.window.PM[k], 'PM.' + k);
  }
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.startsWith('/*!'), 'bundle starts with a legal banner');
  const banner = src.slice(0, src.indexOf('*/'));
  assert.ok(banner.includes('MIT') && banner.includes('Copyright'));
  const lic = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_LICENSES.md'), 'utf8');
  const names = banner.match(/\b(?:prosemirror-[a-z-]+|orderedmap|rope-sequence|w3c-keyname)\b/g);
  assert.ok(names && names.length >= 14, 'banner names every bundled package');
  for (const n of new Set(names)) assert.ok(lic.includes('## ' + n + ' '), n + ' in THIRD_PARTY_LICENSES.md');
});
