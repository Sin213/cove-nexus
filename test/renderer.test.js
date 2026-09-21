const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the shipped renderer with a small DOM/IPC boundary. Test-only exports
// replace automatic startup in memory; production code needs no test hooks.
const source = fs.readFileSync(path.join(__dirname, '../renderer/assets/launcher.js'), 'utf8');
const programsSource = fs.readFileSync(path.join(__dirname, '../renderer/assets/programs.js'), 'utf8');

function element() {
  const classes = new Set();
  const node = {
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, children: [], selectors: new Map(),
    listeners: new Map(), writes: 0, hidden: false, disabled: false, textContent: '',
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); },
    },
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    removeEventListener() {}, setAttribute(name, value) { this[name] = value; }, removeAttribute() {},
    querySelector(selector) { return this.selectors.get(selector) || null; },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); },
    insertAdjacentHTML(_where, html) { this.inserted = (this.inserted || 0) + 1; this.lastInserted = html; },
    getBoundingClientRect() { return {x: 0, y: 0, width: 800, height: 600}; },
    remove() { this.removed = true; }, replaceWith() {},
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return this.html || ''; },
    set(html) {
      this.html = html;
      this.writes++;
      if (html.includes('foxy-proto-content')) this.selectors.set('.foxy-proto-content', element());
    },
  });
  Object.defineProperty(node, 'childElementCount', {get() { return this.innerHTML ? 1 : 0; }});
  return node;
}

function harness(overrides = {}) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const frames = [];
  const subscriptions = {};
  const storage = new Map();
  const api = {
    appInfo: async () => ({version: '1.0.0', platform: 'linux'}),
    getState: async () => ({installed: []}),
    config: {get: async () => ({theme: 'dark'}), setPreferences: async () => ({ok: true})},
    scan: async () => ({installed: []}), discover: async () => ({ok: false, error: 'offline'}),
    processList: async () => ({}), latestReleases: async () => ({ok: true, releases: {}}),
    onProcessUpdate: fn => { subscriptions.process = fn; return () => {}; },
    onInstallProgress: fn => { subscriptions.progress = fn; return () => {}; },
    onSelfUpdateAvailable: fn => { subscriptions.selfUpdate = fn; return () => {}; },
    confirmUpdateAll: async () => ({ok: true}), setChromeMode: async () => {},
    hideTabWebView: async () => {}, showTabWebView: async () => {}, ...overrides,
  };
  let observers = 0;
  const context = {
    window: { coveAPI: api, addEventListener() {}, open() {} },
    document: {
      getElementById: get, querySelector: get, querySelectorAll: () => [],
      createElement: element, addEventListener() {}, head: element(), body: element(), documentElement: element(),
    },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {}, setTimeout() {}, setInterval() {},
    ResizeObserver: class { constructor() { observers++; } observe() {} disconnect() {} },
  };
  vm.createContext(context);
  vm.runInContext(programsSource, context);
  const marker = '  init();\n})();';
  assert(source.includes(marker), 'test startup hook matches renderer entry point');
  vm.runInContext(source.replace(marker, `  globalThis.renderer = {
    state, doLaunch, renderToolSession, doRecoverTab
  };\n})();`), context);
  return {
    ...context.renderer, api, window: context.window, get, subscriptions, frames,
    observers: () => observers,
    flush: () => { const ready = frames.splice(0); ready.forEach(fn => fn()); },
    messages: () => get('toast-host').children.map(child => child.textContent),
  };
}

test('hosted process updates reuse the observer and view bounds', () => {
  let shows = 0;
  const h = harness({showTabWebView: async () => { shows++; }});
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'tab-web', protocol: {tabUrl: 'http://127.0.0.1:4444/'}};
  h.renderToolSession();
  h.state.processes[p.slug].protocol.progress = 50;
  h.renderToolSession();
  assert.equal(h.observers(), 1);
  assert.equal(shows, 1);
});

test('hosted UI stays in loading state until main confirms the page loaded', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'tab-web', protocol: {
    tabUrl: 'http://127.0.0.1:4444/', tabLoading: true,
  }};
  h.renderToolSession();
  assert.equal(h.observers(), 0);
  assert.equal(h.get('tab-web-host').hidden, true);
  assert.match(h.get('foxy-session').innerHTML, /Loading app UI/);
  h.state.processes[p.slug].protocol.tabLoading = false;
  h.renderToolSession();
  assert.equal(h.observers(), 1);
  assert.equal(h.get('tab-web-host').hidden, false);
});

test('an external fallback launch does not create a hosted tab', async () => {
  const h = harness({launch: async () => ({ok: true, openMode: 'external', kind: 'appimage'})});
  h.state.foxyMode = true;
  h.state.tabs = [{id: 'home', kind: 'home', title: 'Home'}];
  await h.doLaunch(h.window.PROGRAMS[0]);
  assert.equal(h.state.tabs.length, 1);
  assert.equal(h.state.activeTabId, 'home');
});

test('hosted load failure shows a retry action and calls the recovery API', async () => {
  let recovered = '';
  const h = harness({recoverTabWeb: async slug => { recovered = slug; return {ok: true}; }});
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'tab-web', protocol: {
    tabUrl: 'http://127.0.0.1:4444/', tabError: 'Renderer <crashed>', tabRecoverable: true,
  }};
  h.renderToolSession();
  assert.match(h.get('foxy-session').innerHTML, /Retry app UI/);
  assert.match(h.get('foxy-session').innerHTML, /Renderer &lt;crashed&gt;/);
  assert.equal(h.observers(), 0);
  await h.doRecoverTab(p);
  assert.equal(recovered, p.slug);
});
