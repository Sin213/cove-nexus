const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'renderer', 'assets', 'launcher.js'), 'utf8');
const {canResumeHostedView, tabReadyDecision, isValidTabUrl} = require(path.join(root, 'lib', 'tabweb'));
const {buildHostedView} = require(path.join(root, 'lib', 'hosted-view'));
const {effectiveOpenMode} = require(path.join(root, 'lib', 'open-mode'));
const {captureStderr} = require(path.join(root, 'lib', 'processes'));

function between(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `source includes ${start}`);
  const to = source.indexOf(end, from);
  assert(to >= 0, `source includes ${end}`);
  return source.slice(from, to);
}

function element() {
  const classes = new Set();
  return {
    innerHTML: '', hidden: false, childElementCount: 0, listeners: new Map(),
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
    },
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    querySelector() { return element(); },
    getBoundingClientRect: () => ({x: 0, y: 0, width: 800, height: 600}),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

function hostedViewHarness() {
  const slug = 'cove-example';
  const url = 'http://127.0.0.1:4444/';
  const processRegistry = new Map([[slug, {
    slug, runId: 'old-run', status: 'running', openMode: 'tab-web',
    protocol: {tabUrl: url, tabLoading: true},
  }]]);
  const hostedViews = new Map();
  const childViews = new Set();
  const tabReadyTimers = new Map();
  const handlers = new Map();
  const loads = [];
  const views = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = null;
  child.unref = () => {};
  class FakeView {
    constructor() {
      const load = deferred();
      loads.push(load);
      const contents = this.webContents = new EventEmitter();
      contents.session = {
        setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
      };
      contents.setWindowOpenHandler = () => {};
      // Keep reporting alive after close to model an Electron callback already
      // queued before the old WebContents was replaced.
      contents.isDestroyed = () => false;
      contents.getURL = () => url;
      contents.loadURL = () => load.promise;
      contents.close = () => { this.closed = true; };
      views.push(this);
    }
  }
  const context = {
    processRegistry, hostedViews, childViews, tabReadyTimers, buildHostedView, repairsInFlight: new Set(),
    WebContentsView: FakeView, wireHostedDownloads() {},
    broadcastProcessUpdate() {}, mainWindow: null,
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    isValidSlug: value => value === slug, isLegacyClone: () => false,
    app: {isPackaged: true}, crypto: {randomUUID: () => 'new-run'},
    readRegistry: () => ({[slug]: {path: '/tmp/cove-example.AppImage'}}),
    exists: () => true, slugToDisplayName: value => value,
    createSocketServer: async () => '/tmp/cove-example.sock', effectiveOpenMode, captureStderr,
    buildNexusEnv: () => ({}), buildLaunchEnv: () => ({}),
    planFromPath: file => ({cmd: file, args: [], kind: 'appimage'}),
    unblockExe() {}, spawn: () => child, path,
    cleanupSocketServer() {},
    clearTabReadyTimer(key) { tabReadyTimers.delete(key); },
    readConfig: () => ({closeAfterLaunch: false, foxyMode: true}),
    tabReadyDecision, isValidTabUrl,
    process: {platform: 'linux', env: {}, kill() {}},
    setTimeout(fn, delay) {
      if (delay < 10000) queueMicrotask(fn);
      return delay;
    },
  };
  vm.createContext(context);
  vm.runInContext(between(mainSource, 'function destroyHostedView(', '\n// ---------- end foxy'), context);
  vm.runInContext(between(mainSource, 'function createHostedView(', '\n// A WebContentsView'), context);
  vm.runInContext(between(mainSource, 'function handleProtocolMessage(', '\n// ---------- end foxy v4'), context);
  vm.runInContext(`${between(mainSource, "ipcMain.handle('cove:launch',", '\n});')}\n});`, context);
  return {context, slug, url, handlers, processRegistry, hostedViews, loads, views};
}

function freshLaunchHarness({platform = 'linux', socketPath = null} = {}) {
  const slug = 'cove-example';
  const handlers = new Map();
  const processRegistry = new Map();
  const hostedViews = new Map();
  const tabReadyTimers = new Map();
  const timers = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = null;
  child.unref = () => {};
  const context = {
    processRegistry, hostedViews, tabReadyTimers, repairsInFlight: new Set(),
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    isValidSlug: value => value === slug, isLegacyClone: () => false,
    app: {isPackaged: true}, crypto: {randomUUID: () => 'new-run'},
    readRegistry: () => ({[slug]: {path: '/tmp/cove-example.AppImage'}}),
    exists: () => true, broadcastProcessUpdate() {},
    slugToDisplayName: value => value,
    createSocketServer: async () => socketPath,
    effectiveOpenMode, captureStderr,
    buildNexusEnv: () => ({}),
    buildLaunchEnv: () => ({}),
    planFromPath: file => ({cmd: file, args: [], kind: 'appimage'}),
    unblockExe() {}, spawn: () => child, path,
    cleanupSocketServer() {},
    destroyHostedView() {}, clearTabReadyTimer() {},
    readConfig: () => ({closeAfterLaunch: false, foxyMode: true}),
    mainWindow: null,
    process: {platform, kill() {}},
    setTimeout(fn, delay) { timers.push(delay); queueMicrotask(fn); return timers.length; },
  };
  vm.createContext(context);
  vm.runInContext(`${between(mainSource, "ipcMain.handle('cove:launch',", '\n});')}\n});`, context);
  return {slug, handlers, processRegistry, hostedViews, tabReadyTimers, timers};
}

function setup({hasUrl}) {
  const slug = 'cove-example';
  const program = {slug, name: 'Example', icon: 'upscale', openMode: 'tab-web'};
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const api = {setChromeMode: async () => {}, hideTabWebView: async () => {}};
  const renderer = {
    window: {coveAPI: api, PROGRAMS: [program], ICONS: {upscale: '<svg></svg>'}},
    document: {getElementById: get, querySelector: get},
    ResizeObserver: class {observe() {} disconnect() {}},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    toast() {},
    render() { renderer.renderTabs(); renderer.renderToolSession(); },
  };
  vm.createContext(renderer);
  // Execute the actual lifecycle definitions and close-click handler without
  // running unrelated startup/network work. No implementation is substituted.
  const declarationsStart = rendererSource.indexOf('\n') + 1;
  const declarationsEnd = rendererSource.indexOf('  // Delegated click handler for foxy session page actions');
  assert(declarationsEnd > declarationsStart);
  vm.runInContext(rendererSource.slice(declarationsStart, declarationsEnd), renderer);
  vm.runInContext(between(rendererSource, '  function isInstalled(p)', '  function render()'), renderer);
  vm.runInContext(between(rendererSource, '  async function doLaunch(prog)', '  async function doRecoverTab(prog)'), renderer);
  vm.runInContext('globalThis.lifecycle = {state, doLaunch, renderToolSession};', renderer);

  const entry = {
    slug, openMode: 'tab-web', status: 'running', runId: 'same-run',
    protocol: {tabUrl: hasUrl ? 'http://127.0.0.1:4444/' : null, tabLoading: hasUrl, tabClosed: false},
  };
  const processRegistry = new Map([[slug, entry]]);
  const hostedViews = new Map();
  const childViews = new Set();
  const tabReadyTimers = new Map(hasUrl ? [] : [[slug, 123]]);
  const handlers = new Map();
  let created = 0;
  let shows = 0;
  const view = () => ({webContents: {isDestroyed: () => false, close() {}}, setBounds() {}});
  if (hasUrl) hostedViews.set(slug, view());
  const main = {
    processRegistry, hostedViews, childViews, tabReadyTimers, repairsInFlight: new Set(),
    canResumeHostedView, tabReadyDecision, isValidTabUrl,
    isValidSlug: value => value === slug, isLegacyClone: () => false,
    app: {isPackaged: true}, clearTimeout() {},
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    mainWindow: {
      isDestroyed: () => false, getContentSize: () => [1000, 800],
      contentView: {addChildView() {}, removeChildView() {}},
    },
    getTrustedTabWebRegion: () => ({x: 0, y: 0, width: 1000, height: 800}),
    createHostedView(key) { created++; hostedViews.set(key, view()); },
    broadcastProcessUpdate(key) { renderer.lifecycle.state.processes[key] = {...processRegistry.get(key)}; },
  };
  vm.createContext(main);
  vm.runInContext(between(mainSource, 'function clearTabReadyTimer(', '\nfunction createHostedView('), main);
  vm.runInContext(between(mainSource, 'function resumeHostedView(', '\nfunction slugForHostedContents('), main);
  vm.runInContext(between(mainSource, 'function destroyHostedView(', '\n// ---------- end foxy'), main);
  vm.runInContext(between(mainSource, 'function handleProtocolMessage(', '\n// ---------- end foxy v4'), main);
  for (const channel of ['cove:launch', 'cove:tab-web:close', 'cove:tab-web:show']) {
    vm.runInContext(`${between(mainSource, `ipcMain.handle('${channel}',`, '\n});')}\n});`, main);
  }
  api.closeTabWeb = async key => handlers.get('cove:tab-web:close')(null, key);
  api.launch = (key, mode) => handlers.get('cove:launch')(null, key, mode);
  api.showTabWebView = async (key, bounds) => { shows++; handlers.get('cove:tab-web:show')(null, key, bounds); };
  const {state} = renderer.lifecycle;
  state.foxyMode = true;
  state.onDisk.add(slug);
  state.processes[slug] = {...entry};
  state.tabs = [{id: 'home', kind: 'home', title: 'Home'}, {id: slug, slug, kind: 'tool', title: slug}];
  state.activeTabId = slug;
  const close = () => get('foxy-tabs').listeners.get('click')({target: {
    closest: selector => selector === '[data-close-tab]' ? {dataset: {closeTab: slug}} : null,
  }});
  return {renderer, main, slug, program, api, get, close, processRegistry, hostedViews, childViews, tabReadyTimers,
    created: () => created, shows: () => shows};
}

test('reopening a tab closed during page load starts a new view before requesting bounds', async () => {
  const s = setup({hasUrl: true});
  s.close();
  assert.equal(s.hostedViews.size, 0);
  assert.equal(s.processRegistry.get(s.slug).protocol.tabLoading, false);
  await s.renderer.lifecycle.doLaunch(s.program);
  assert.equal(s.processRegistry.get(s.slug).protocol.tabClosed, false);
  assert.equal(s.created(), 1, 'launch resumes the page without a renderer show request');
  assert.equal(s.shows(), 0, 'the renderer keeps the loading view detached');
  assert.match(s.get('foxy-session').innerHTML, /Loading app UI/);
  s.processRegistry.get(s.slug).protocol.tabLoading = false;
  s.main.broadcastProcessUpdate(s.slug);
  s.renderer.lifecycle.renderToolSession();
  assert.equal(s.shows(), 1);
  assert(s.childViews.has(s.slug));
});

test('closing before readiness preserves its deadline and reopening allows late readiness to load', async () => {
  const s = setup({hasUrl: false});
  s.close();
  assert(s.tabReadyTimers.has(s.slug), 'the running child retains a readiness deadline');
  await s.renderer.lifecycle.doLaunch(s.program);
  assert.equal(s.processRegistry.get(s.slug).protocol.tabClosed, false);
  s.main.handleProtocolMessage(s.slug, {type: 'tab_ready', url: 'http://127.0.0.1:4444/'});
  assert.equal(s.created(), 1, 'readiness for a reopened tab loads its view');
  assert.equal(s.tabReadyTimers.has(s.slug), false);
});

test('requesting external mode for a paused session does not recreate a hidden hosted view', async () => {
  const s = setup({hasUrl: true});
  s.close();
  const result = await s.api.launch(s.slug, 'external');
  assert.equal(result.alreadyRunning, true);
  assert.equal(s.created(), 0);
  assert.equal(s.processRegistry.get(s.slug).protocol.tabClosed, true);
});

test('main refuses to attach a hosted page while loading, even if bounds arrive early', async () => {
  const s = setup({hasUrl: true});
  await s.api.showTabWebView(s.slug, {x: 0, y: 0, width: 800, height: 600});
  assert.equal(s.childViews.has(s.slug), false);
});

test('a late failure from a replaced run cannot mutate or destroy the new hosted view', async () => {
  const h = hostedViewHarness();
  vm.runInContext(`createHostedView('${h.slug}', '${h.url}')`, h.context);
  await new Promise(resolve => setImmediate(resolve));
  const oldView = h.hostedViews.get(h.slug);

  h.processRegistry.get(h.slug).status = 'exited';
  const launch = await h.handlers.get('cove:launch')(null, h.slug, 'tab-web');
  assert.equal(launch.ok, true);
  assert.equal(launch.openMode, 'tab-web');
  h.context.handleProtocolMessage(h.slug, {type: 'tab_ready', url: h.url});
  await new Promise(resolve => setImmediate(resolve));
  const newView = h.hostedViews.get(h.slug);
  assert.notEqual(newView, oldView);
  assert.equal(oldView.closed, true);

  h.loads[0].reject(new Error('late failure from old run'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.processRegistry.get(h.slug).runId, 'new-run');
  assert.equal(h.processRegistry.get(h.slug).protocol.tabLoading, true);
  assert.equal(h.processRegistry.get(h.slug).protocol.tabError, null);
  assert.equal(h.hostedViews.get(h.slug), newView);
  assert.equal(newView.closed, undefined);

  h.loads[1].resolve();
  await new Promise(resolve => setImmediate(resolve));
});

test('fresh tab-web launch degrades to external when the protocol socket is unavailable', async () => {
  const h = freshLaunchHarness({socketPath: null});
  const result = await h.handlers.get('cove:launch')(null, h.slug, 'tab-web');
  assert.equal(result.ok, true);
  assert.equal(result.openMode, 'external');
  assert.equal(h.processRegistry.get(h.slug).openMode, 'external');
  assert.equal(h.hostedViews.size, 0);
  assert.equal(h.tabReadyTimers.size, 0);
  assert.deepEqual(h.timers, [600, 2500], 'no tab readiness timer is created for external fallback');
});
