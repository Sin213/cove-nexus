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
    state, init, rescan, beginAction, doInstall, doUpdate, doUninstall, doChangePath, doUpdateAll, isInstalled, hasUpdate,
    card, doLaunch, renderToolSession, doRecoverTab, discoverAndMerge, doRefresh
  };\n})();`), context);
  return {
    ...context.renderer, api, window: context.window, get, subscriptions, frames,
    observers: () => observers,
    flush: () => { const ready = frames.splice(0); ready.forEach(fn => fn()); },
    messages: () => get('toast-host').children.map(child => child.textContent),
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const program = slug => ({slug, name: slug, icon: 'upscale', version: '1.0.0'});

test('offline cold start renders an installed tool absent from the static catalog', async () => {
  const slug = 'cove-offline-only';
  const h = harness({
    getState: async () => ({installed: [slug]}),
    scan: async () => ({installed: [{slug, version: 'v2.0.0'}]}),
  });
  await h.init();
  assert(h.window.PROGRAMS.some(p => p.slug === slug && p.version === '2.0.0'));
  assert(h.get('grid').innerHTML.includes(`data-slug="${slug}"`));
  assert.equal(h.isInstalled(program(slug)), true);
});

test('quick state shows an offline installed tool before the scan finishes', async () => {
  const scanStarted = deferred();
  const pendingScan = deferred();
  const slug = 'cove-quick-only';
  const h = harness({
    getState: async () => ({installed: [slug]}),
    scan: () => { scanStarted.resolve(); return pendingScan.promise; },
  });
  const starting = h.init();
  await scanStarted.promise;
  assert(h.window.PROGRAMS.some(p => p.slug === slug));
  assert.equal(h.isInstalled(program(slug)), true);
  pendingScan.resolve({installed: []});
  await starting;
});

test('a non-string scan version preserves other installed tools and completes the scan', async () => {
  const existing = program('cove-example');
  const malformed = program('cove-bad');
  const hostile = program('cove-hostile');
  const h = harness({scan: async () => ({installed: [
    {slug: existing.slug, version: 'v2.0.0'},
    {slug: malformed.slug, version: 123},
    {slug: hostile.slug, version: {toString: 0}},
  ]})});
  await h.rescan();
  assert.equal(h.isInstalled(existing), true);
  assert.equal(h.window.PROGRAMS.find(p => p.slug === existing.slug).version, '2.0.0');
  assert.equal(h.isInstalled(malformed), true);
  assert.equal(h.window.PROGRAMS.find(p => p.slug === malformed.slug).version, '123');
  assert.equal(h.isInstalled(hostile), true);
  assert.equal(h.window.PROGRAMS.find(p => p.slug === hostile.slug).version, '');
  assert.equal(h.messages().some(message => message.startsWith('Scan failed:')), false);
});

test('discovery enriches a local-only entry without duplicating it', async () => {
  const slug = 'cove-local';
  const h = harness({discover: async () => ({ok: true, repos: [
    {slug, name: 'Real Name', desc: 'Discovered description'},
  ]})});
  h.window.PROGRAMS = [{...program(slug), localOnly: true}];
  await h.discoverAndMerge();
  const matches = h.window.PROGRAMS.filter(p => p.slug === slug);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].localOnly, false);
  assert.equal(matches[0].name, 'Real Name');
});

test('refresh discovers before scanning', async () => {
  const calls = [];
  const h = harness({
    discover: async () => { calls.push('discover'); return {ok: true, repos: []}; },
    scan: async () => { calls.push('scan'); return {installed: []}; },
  });
  await h.doRefresh({force: false});
  assert.deepEqual(calls, ['discover', 'scan']);
});

test('authoritative scans clear overrides, failed scans preserve the previous state', async () => {
  const h = harness();
  const p = program('cove-example');
  h.state.installedOverride[p.slug] = true;
  h.state.onDisk.add(p.slug);
  h.api.scan = async () => ({ok: false, error: 'unavailable'});
  await h.rescan();
  assert.equal(h.isInstalled(p), true);
  h.api.scan = async () => ({installed: []});
  await h.rescan();
  assert.equal(h.isInstalled(p), false);
  assert.equal(Object.hasOwn(h.state.installedOverride, p.slug), false);
});

test('a scan started before an operation cannot erase its completed installation', async () => {
  const pending = deferred();
  const h = harness({scan: () => pending.promise});
  const p = program('cove-example');
  const scanning = h.rescan();
  h.beginAction(p.slug, 'installing');
  h.state.onDisk.add(p.slug);
  h.state.installedOverride[p.slug] = true;
  h.state.busy[p.slug] = null;
  pending.resolve({installed: []});
  await scanning;
  assert.equal(h.isInstalled(p), true);
  assert(h.state.onDisk.has(p.slug));
});

test('an operation active when scanning starts keeps its optimistic state', async () => {
  const pending = deferred();
  const h = harness({scan: () => pending.promise});
  const p = program('cove-example');
  h.beginAction(p.slug, 'installing');
  const scanning = h.rescan();
  h.state.onDisk.add(p.slug);
  h.state.installedOverride[p.slug] = true;
  h.state.busy[p.slug] = null;
  pending.resolve({installed: []});
  await scanning;
  assert.equal(h.isInstalled(p), true);
});

test('a late older scan cannot overwrite the latest scan', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({scan: () => (++calls === 1 ? first.promise : second.promise)});
  const a = h.rescan();
  const b = h.rescan();
  second.resolve({installed: [{slug: 'cove-example', version: 'v2.0.0'}]});
  await b;
  first.resolve({installed: []});
  await a;
  assert.equal(h.isInstalled(program('cove-example')), true);
});

for (const operation of ['doInstall', 'doUpdate']) {
  test(`${operation} ignores duplicate actions without clearing the first busy state`, async () => {
    const pending = deferred();
    let calls = 0;
    const p = program('cove-example');
    const h = harness({
      [operation === 'doInstall' ? 'install' : 'update']: () => { calls++; return pending.promise; },
      scan: async () => ({installed: [{slug: p.slug, version: 'v2.0.0'}]}),
    });
    h.window.PROGRAMS = [p];
    const first = h[operation](p);
    assert.equal(h.get('ft-primary').disabled, true);
    const duplicate = await h[operation](p);
    assert.equal(duplicate.skipped, true);
    assert(h.state.busy[p.slug]);
    assert.equal(calls, 1);
    pending.resolve({ok: true});
    await first;
    assert.equal(h.state.busy[p.slug], null);
    assert.equal(h.get('ft-primary').disabled, false);
  });
}

for (const operation of ['doUninstall', 'doChangePath']) {
  const apiMethod = operation === 'doUninstall' ? 'uninstall' : 'setCustomPath';

  test(`${operation} returns success and skips a duplicate action`, async () => {
    const pending = deferred();
    let calls = 0;
    const p = program('cove-example');
    const h = harness({[apiMethod]: () => { calls++; return pending.promise; }});
    h.window.PROGRAMS = [p];
    const first = h[operation](p);
    const duplicate = await h[operation](p);
    assert.deepEqual({...duplicate}, {ok: false, skipped: true});
    assert.equal(calls, 1);
    pending.resolve({ok: true, path: '/tmp/cove-example'});
    assert.deepEqual({...await first}, {ok: true});
  });

  test(`${operation} returns the IPC failure message`, async () => {
    const h = harness({[apiMethod]: async () => ({ok: false, error: 'permission denied'})});
    assert.deepEqual({...await h[operation](program('cove-example'))}, {ok: false, error: 'permission denied'});
  });

  test(`${operation} returns cancellation`, async () => {
    const h = harness({[apiMethod]: async () => ({cancelled: true})});
    assert.deepEqual({...await h[operation](program('cove-example'))}, {ok: false, cancelled: true});
  });
}

test('an operation on one tool does not mark or block an unrelated tool', async () => {
  const pendingA = deferred();
  const pendingB = deferred();
  const calls = [];
  const a = program('cove-a');
  const b = program('cove-b');
  const h = harness({
    install: slug => {
      calls.push(slug);
      return slug === a.slug ? pendingA.promise : pendingB.promise;
    },
    scan: async () => ({installed: []}),
  });
  h.window.PROGRAMS = [a, b];

  const installingA = h.doInstall(a);
  assert.equal(h.state.busy[a.slug], 'installing');
  assert.equal(h.state.busy[b.slug], undefined);
  const installingB = h.doInstall(b);
  assert.equal(h.state.busy[a.slug], 'installing');
  assert.equal(h.state.busy[b.slug], 'installing');
  assert.deepEqual(calls, [a.slug, b.slug]);

  pendingA.resolve({ok: true});
  assert.equal((await installingA).ok, true);
  assert.equal(h.state.busy[a.slug], null);
  assert.equal(h.state.busy[b.slug], 'installing');
  assert.deepEqual(calls, [a.slug, b.slug]);

  pendingB.resolve({ok: true});
  assert.equal((await installingB).ok, true);
  assert.equal(h.state.busy[a.slug], null);
  assert.equal(h.state.busy[b.slug], null);
});

test('Update all counts failed, successful, and busy tools and scans only once', async () => {
  let scans = 0;
  const h = harness({
    update: async slug => ({ok: slug !== 'cove-fails', error: 'offline'}),
    scan: async () => {
      scans++;
      return {installed: ['cove-fails', 'cove-works', 'cove-busy'].map(slug => ({
        slug, version: 'v1.0.0', hasUpdate: slug !== 'cove-works',
      }))};
    },
  });
  h.window.PROGRAMS = ['cove-fails', 'cove-works', 'cove-busy'].map(program);
  for (const p of h.window.PROGRAMS) { h.state.onDisk.add(p.slug); h.state.remoteUpdates.add(p.slug); }
  h.beginAction('cove-busy', 'installing');
  const result = await h.doUpdateAll();
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(scans, 1);
  assert.equal(h.hasUpdate(h.window.PROGRAMS[0]), true, 'failed update remains available to retry');
  assert.match(h.messages().at(-1), /Updated 1 program; 1 failed, 1 already busy/);
});

test('version labels escape HTML from registry or release metadata', () => {
  const h = harness();
  const p = {...program('cove-example'), version: '1.0.0<em>injected</em>'};
  h.state.onDisk.add(p.slug);
  const html = h.card(p);
  assert(!html.includes('<em>injected</em>'));
  assert(html.includes('&lt;em&gt;injected&lt;/em&gt;'));
});

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

test('downloaded update displays from startup snapshot and restarts only on click', async () => {
  let restarts = 0;
  const h = harness({
    appInfo: async () => ({version: '1.0.0', selfUpdate: {version: '2.0.0', state: 'downloaded'}}),
    installSelfUpdate: async () => { restarts++; return {ok: true}; },
  });
  await h.init();
  assert.equal(h.get('self-update-download').textContent, 'Restart and update');
  assert.equal(restarts, 0);
  await h.get('self-update-download').onclick();
  assert.equal(restarts, 1);
});
