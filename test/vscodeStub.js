'use strict';
// A fake vscode module, installed for require('vscode'), so host tests run without VS Code. It records what the
// extension does: registered providers, commands, panels and the messages posted to them.
const Module = require('module');
const origLoad = Module._load;

class Emitter {
  constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose: () => { this.fns = this.fns.filter((f) => f !== fn); } }; }; }
  fire(x) { for (const f of [...this.fns]) f(x); }
}

function fakeWebview() {
  const recv = new Emitter();
  return {
    html: '', options: {}, cspSource: 'vscode-resource:', posted: [],
    postMessage(m) { this.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
    onDidReceiveMessage: recv.event, _receive: (m) => recv.fire(m),
    asWebviewUri: (u) => u,
  };
}

function install() {
  const ui = { providers: {}, serializers: {}, panels: [], commands: {}, executed: [], opened: [], focused: true, config: {}, workspaceConfig: {}, out: [], watchers: [], infos: [], copied: [], sessions: [], inputs: [], inputOptions: [], editors: {}, tab: null };
  const configChange = new Emitter();
  // the editor's Microsoft provider: ui.session(scopes, options) answers getSession; calls are recorded
  ui.session = () => undefined;
  const windowState = new Emitter();
  const tabChange = new Emitter(); const groupChange = new Emitter();
  // one editor group by default; ui.openTab / ui.closeTab / ui.setActiveTab change it and fire onDidChangeTabs
  const group0 = { viewColumn: 1, isActive: true, tabs: [], activeTab: null };
  const tabGroups = { all: [group0], activeTabGroup: group0, onDidChangeTabs: tabChange.event, onDidChangeTabGroups: groupChange.event };
  ui.extensions = {};   // id -> extension object, for vscode.extensions.getExtension
  const Uri = {
    file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p }),
    joinPath: (u, ...parts) => Uri.file(require('path').join(u.fsPath, ...parts)),
    parse: (s) => ({ toString: () => s, scheme: s.split(':')[0] }),
  };
  function createWebviewPanel(viewType, title, column, options) {
    const disposed = new Emitter(), viewState = new Emitter();
    const panel = {
      viewType, title, options, webview: fakeWebview(), visible: true, active: true, disposed: false, revealed: 0,
      reveal() { this.revealed++; this.visible = true; this.active = true; viewState.fire({ webviewPanel: this }); },
      dispose() { if (this.disposed) return; this.disposed = true; disposed.fire(); },
      onDidDispose: disposed.event, onDidChangeViewState: viewState.event,
      _setView(visible, active) { this.visible = visible; this.active = active; viewState.fire({ webviewPanel: this }); },
    };
    ui.panels.push(panel);
    return panel;
  }
  const vscode = {
    Uri, EventEmitter: Emitter,
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.base = base.fsPath; this.pattern = pattern; } },
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    TabInputWebview: class { constructor(viewType) { this.viewType = viewType; } },
    extensions: { getExtension: (id) => ui.extensions[id] },
    window: {
      get state() { return { focused: ui.focused }; },
      onDidChangeWindowState: windowState.event,
      registerWebviewViewProvider: (id, provider) => { ui.providers[id] = provider; return { dispose() {} }; },
      registerWebviewPanelSerializer: (id, s) => { ui.serializers[id] = s; ui.serializer = s; return { dispose() {} }; },
      createWebviewPanel,
      tabGroups,
      registerCustomEditorProvider: (viewType, provider, options) => { ui.editors[viewType] = { provider, options }; return { dispose() {} }; },
      showInputBox: async (options) => { ui.inputOptions.push(options); return ui.inputs.shift(); },
      createOutputChannel: () => ({ appendLine: (l) => ui.out.push(l), dispose() {} }),
      showErrorMessage: (m) => { ui.out.push('error: ' + m); },
      showInformationMessage: async (m) => { ui.infos.push(m); return undefined; },
    },
    commands: {
      registerCommand: (id, fn) => { ui.commands[id] = fn; return { dispose() {} }; },
      executeCommand: async (id, ...a) => { ui.executed.push([id, ...a]); return ui.commands[id] ? ui.commands[id](...a) : undefined; },
    },
    workspace: {
      // ui.config holds user (global) values, ui.workspaceConfig a repo's .vscode/settings.json; get() lets the workspace win, as VS Code does
      getConfiguration: (section) => ({
        get: (k, d) => { const id = (section ? section + '.' : '') + k; const w = ui.workspaceConfig[id]; const v = w === undefined ? ui.config[id] : w; return v === undefined ? d : v; },
        inspect: (k) => {
          const id = (section ? section + '.' : '') + k;
          const prop = require('../package.json').contributes.configuration.properties[id];
          return { key: id, defaultValue: prop ? prop.default : undefined, globalValue: ui.config[id], workspaceValue: ui.workspaceConfig[id], workspaceFolderValue: undefined };
        },
        update: async (k, v) => { ui.setConfig((section ? section + '.' : '') + k, v); },
      }),
      onDidChangeConfiguration: configChange.event,
      createFileSystemWatcher: (pattern) => {
        const w = { pattern, created: new Emitter(), changed: new Emitter(), deleted: new Emitter(), disposed: false, dispose() { this.disposed = true; } };
        w.onDidCreate = w.created.event; w.onDidChange = w.changed.event; w.onDidDelete = w.deleted.event;
        ui.watchers.push(w);
        return w;
      },
    },
    authentication: { getSession: async (provider, scopes, options) => { ui.sessions.push({ provider, scopes, options }); return ui.session(scopes, options); } },
    env: { openExternal: async (u) => { ui.opened.push(u.toString()); return true; }, clipboard: { writeText: async (t) => { ui.copied.push(t); } } },
  };
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : origLoad.call(this, request, ...rest); };
  ui.setFocus = (f) => { ui.focused = f; windowState.fire({ focused: f }); };
  /** Makes `input` the active tab's input (null: no tab) and fires onDidChangeTabs. */
  ui.setActiveTab = (input) => {
    ui.tab = input;
    const g = tabGroups.activeTabGroup;
    let t = input === null ? null : g.tabs.find((x) => x.input === input);
    if (input !== null && !t) { t = { label: '', input, group: g, isActive: false }; g.tabs.push(t); }
    for (const x of g.tabs) x.isActive = x === t;
    g.activeTab = t;
    tabChange.fire({ opened: [], closed: [], changed: t ? [t] : [] });
  };
  /** Opens a tab ({ label, viewType } makes a webview tab, as VS Code prefixes it) in `group` and makes it active. */
  ui.openTab = ({ label, viewType, group = tabGroups.activeTabGroup }) => {
    const t = { label, input: new vscode.TabInputWebview(viewType), group, isActive: true };
    for (const x of group.tabs) x.isActive = false;
    group.tabs.push(t); group.activeTab = t;
    tabChange.fire({ opened: [t], closed: [], changed: [] });
    return t;
  };
  /** Makes an open tab active in its group. */
  ui.activateTab = (t) => { for (const x of t.group.tabs) x.isActive = x === t; t.group.activeTab = t; tabChange.fire({ opened: [], closed: [], changed: [t] }); };
  /** Closes a tab; the group's last remaining tab becomes active. */
  ui.closeTab = (t) => {
    const g = t.group; g.tabs = g.tabs.filter((x) => x !== t);
    if (g.activeTab === t) { g.activeTab = g.tabs.at(-1) || null; if (g.activeTab) g.activeTab.isActive = true; }
    tabChange.fire({ opened: [], closed: [t], changed: [] });
  };
  /** Clears every tab (between tests). */
  ui.resetTabs = () => { for (const g of tabGroups.all) { g.tabs = []; g.activeTab = null; } ui.tab = null; };
  ui.setConfig = (key, value) => { ui.config[key] = value; configChange.fire({ affectsConfiguration: (sec) => key === sec || key.startsWith(sec + '.') }); };
  /** Shows the sidebar: resolves the registered view provider with a fake view. */
  ui.resolveSidebar = () => {
    const view = { webview: fakeWebview(), badge: undefined, visible: true, show() {}, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
    ui.providers['jay.sidebar'].resolveWebviewView(view, {}, {});
    ui.view = view;
    return view;
  };
  return { vscode, ui };
}

/** The editor's secret storage, shared by "windows" that use the same object. */
function secrets() {
  const m = new Map(); const ch = new Emitter();
  return { m, get: async (k) => m.get(k), store: async (k, v) => { m.set(k, v); ch.fire({ key: k }); }, delete: async (k) => { m.delete(k); ch.fire({ key: k }); }, onDidChange: ch.event };
}

// like VS Code's, update(key, undefined) deletes the key
function memento() { const m = new Map(); return { keys: () => [...m.keys()], get: (k) => m.get(k), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); } }; }

module.exports = { install, memento, secrets, Emitter };
