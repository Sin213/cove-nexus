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
    closestNodes: new Map(),
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
    closest(selector) { return this.closestNodes.get(selector) || null; },
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
      this.selectors.delete('.foxy-proto-block');
      this.selectors.delete('.foxy-proto-content');
      const divs = [];
      for (const [tag] of html.matchAll(/<\/?div\b[^>]*>/gi)) {
        if (tag.startsWith('</')) { divs.pop(); continue; }
        const className = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2] || '';
        const names = className.split(/\s+/);
        const block = names.includes('foxy-proto-block') ? element() : null;
        if (block) {
          block.remove = () => {
            block.removed = true;
            if (this.selectors.get('.foxy-proto-block') !== block) return;
            this.selectors.delete('.foxy-proto-block');
            if (this.selectors.get('.foxy-proto-content')?.closest('.foxy-proto-block') === block) {
              this.selectors.delete('.foxy-proto-content');
            }
          };
          if (!this.selectors.has('.foxy-proto-block')) this.selectors.set('.foxy-proto-block', block);
        }
        if (names.includes('foxy-proto-content')) {
          const content = element();
          const ancestor = divs.findLast(parent => parent.block)?.block;
          if (ancestor) content.closestNodes.set('.foxy-proto-block', ancestor);
          if (!this.selectors.has('.foxy-proto-content')) this.selectors.set('.foxy-proto-content', content);
        }
        divs.push({block});
      }
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
    card, doLaunch, renderToolSession, doRecoverTab, openPinModal, discoverAndMerge, doRefresh
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

test('protocol mock preserves wrapper ancestry and detached blocks cannot remove newer nodes', () => {
  const session = element();
  session.innerHTML = '<div class="foxy-proto-content"></div>';
  assert.equal(session.querySelector('.foxy-proto-content').closest('.foxy-proto-block'), null);
  assert.equal(session.querySelector('.foxy-proto-block'), null);

  session.innerHTML = '<div class="foxy-proto-block"></div><div class="foxy-proto-content"></div>';
  assert.equal(session.querySelector('.foxy-proto-content').closest('.foxy-proto-block'), null);

  session.innerHTML = '<div class="foxy-proto-block"><div class="foxy-proto-content"></div></div>';
  const oldBlock = session.querySelector('.foxy-proto-block');
  assert.equal(session.querySelector('.foxy-proto-content').closest('.foxy-proto-block'), oldBlock);
  session.innerHTML = '<div class="foxy-proto-block"><div class="foxy-proto-content"></div></div>';
  const newBlock = session.querySelector('.foxy-proto-block');
  oldBlock.remove();
  assert.equal(session.querySelector('.foxy-proto-block'), newBlock);
  assert.equal(session.querySelector('.foxy-proto-content').closest('.foxy-proto-block'), newBlock);
});

test('external protocol progress leaves session controls intact', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const writes = session.writes;
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, writes);
  assert.match(session.querySelector('.foxy-proto-content').innerHTML, /20%/);
});

test('protocol appearance rewrites once before later updates patch in place', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const absentWrites = session.writes;
  assert.equal(session.querySelector('.foxy-proto-content'), null);

  h.state.processes[p.slug].protocol.progress = 10;
  h.renderToolSession();
  assert.equal(session.writes, absentWrites + 1);
  const presentWrites = session.writes;
  assert(session.querySelector('.foxy-proto-content'));

  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, presentWrites);
  assert.match(session.querySelector('.foxy-proto-content').innerHTML, /20%/);
  assert.match(session.innerHTML, /foxy-session-actions/);
});

test('clearing protocol content removes its wrapper', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  assert(session.querySelector('.foxy-proto-block'));
  h.state.processes[p.slug].protocol = {};
  h.renderToolSession();
  assert.equal(session.querySelector('.foxy-proto-block'), null);
});

test('switching the active tab forces a full session rewrite instead of patching the previous tab\'s protocol node', () => {
  const h = harness();
  const a = program('cove-a');
  const b = program('cove-b');
  h.window.PROGRAMS = [a, b];
  h.state.foxyMode = true;
  h.state.tabs = [{id: a.slug, slug: a.slug}, {id: b.slug, slug: b.slug}];
  h.state.activeTabId = a.slug;
  h.state.processes[a.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.state.processes[b.slug] = {status: 'running', openMode: 'external', protocol: {progress: 70}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const aProtocol = session.querySelector('.foxy-proto-content');
  const writes = session.writes;

  h.state.activeTabId = b.slug;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.notEqual(session.querySelector('.foxy-proto-content'), aProtocol);
  assert.equal(aProtocol.writes, 0);
  assert.match(session.innerHTML, /cove-b/);
  assert.match(session.innerHTML, /70%/);
  assert.doesNotMatch(session.innerHTML, /10%/);
});

test('an inactive or hidden session does not receive a targeted protocol patch', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const staleProtocol = session.querySelector('.foxy-proto-content');
  const writes = session.writes;

  session.hidden = true;
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.equal(staleProtocol.writes, 0);
  assert.notEqual(session.querySelector('.foxy-proto-content'), staleProtocol);
  assert.match(session.innerHTML, /20%/);
});

test('switching tabs with the same program rewrites the previous tab session', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: 'first', slug: p.slug}, {id: 'second', slug: p.slug}];
  h.state.activeTabId = 'first';
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const oldProtocol = session.querySelector('.foxy-proto-content');
  const writes = session.writes;

  h.state.activeTabId = 'second';
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.notEqual(session.querySelector('.foxy-proto-content'), oldProtocol);
  assert.equal(oldProtocol.writes, 0);
  assert.match(session.innerHTML, /20%/);
});

test('changing program ownership with unchanged chrome rewrites the session', () => {
  const h = harness();
  // Distinct slug identities render the same text, isolating the slug guard.
  const p = program(new String('cove-a'));
  p.name = 'Cove A';
  h.window.PROGRAMS = [p];
  h.state.foxyMode = true;
  h.state.tabs = [{id: 'same-tab', slug: p.slug}];
  h.state.activeTabId = 'same-tab';
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const oldProtocol = session.querySelector('.foxy-proto-content');
  const writes = session.writes;

  p.slug = new String('cove-a');
  h.state.tabs[0].slug = p.slug;
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.notEqual(session.querySelector('.foxy-proto-content'), oldProtocol);
  assert.equal(oldProtocol.writes, 0);
  assert.match(session.innerHTML, /20%/);
});

test('changing session chrome rewrites protocol content for the same tab and program', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  const oldProtocol = session.querySelector('.foxy-proto-content');
  const writes = session.writes;

  p.name = 'Renamed tool';
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.notEqual(session.querySelector('.foxy-proto-content'), oldProtocol);
  assert.equal(oldProtocol.writes, 0);
  assert.match(session.innerHTML, /Renamed tool/);
  assert.match(session.innerHTML, /20%/);
});

test('missing protocol content node forces a full rewrite', () => {
  const h = harness();
  const p = h.window.PROGRAMS[0];
  h.state.foxyMode = true;
  h.state.tabs = [{id: p.slug, slug: p.slug}];
  h.state.activeTabId = p.slug;
  h.state.processes[p.slug] = {status: 'running', openMode: 'external', protocol: {progress: 10}};
  h.renderToolSession();
  const session = h.get('foxy-session');
  h.state.processes[p.slug].protocol.progress = 20;
  h.renderToolSession();
  const writes = session.writes;
  session.selectors.delete('.foxy-proto-content');

  h.state.processes[p.slug].protocol.progress = 30;
  h.renderToolSession();
  assert.equal(session.writes, writes + 1);
  assert.match(session.innerHTML, /30%/);
  assert(session.querySelector('.foxy-proto-content'));
});

test('reopening the pin modal ignores an older request for the same program', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({releases: () => (++calls === 1 ? first.promise : second.promise)});
  const p = h.window.PROGRAMS[0];
  const older = h.openPinModal(p);
  h.get('pin-cancel').listeners.get('click')();
  const newer = h.openPinModal(p);
  second.resolve({ok: true, releases: [{tag: 'v2-current', hasAsset: true}]});
  await newer;
  assert.match(h.get('pin-tag-list').innerHTML, /v2-current/);
  first.resolve({ok: true, releases: [{tag: 'v1-stale', hasAsset: true}]});
  await older;
  assert.match(h.get('pin-tag-list').innerHTML, /v2-current/);
  assert.doesNotMatch(h.get('pin-tag-list').innerHTML, /v1-stale/);
});

test('pin modal disables both actions for every busy owner', async () => {
  const h = harness({releases: async () => ({ok: true, releases: []})});
  const p = {...program('cove-example'), pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  for (const busy of ['installing', 'updating', 'removing', 'changing-path', 'pinning', 'unpinning']) {
    h.state.busy[p.slug] = busy;
    await h.openPinModal(p);
    assert.equal(h.get('pin-confirm').disabled, true, `${busy} disables Pin`);
    assert.equal(h.get('pin-unpin').disabled, true, `${busy} disables Unpin`);
    h.get('pin-cancel').listeners.get('click')();
  }
  h.state.busy[p.slug] = null;
});

test('reopening the same tool preserves its in-flight unpin controls', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => pending.promise,
  });
  const p = {...program('cove-example'), pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  await h.openPinModal(p);
  const button = h.get('pin-unpin');
  assert.equal(button.disabled, false);
  const unpinning = button.listeners.get('click')();
  h.get('pin-cancel').listeners.get('click')();
  await h.openPinModal(p);
  assert.equal(h.state.busy[p.slug], 'unpinning');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Unpinning…');

  pending.resolve({ok: true});
  await unpinning;
  assert.equal(h.get('pin-overlay').classList.contains('open'), true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Unpin');
});

test('unpin exposes and clears its busy state', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => pending.promise,
  });
  const p = {...h.window.PROGRAMS[0], pinnedTag: 'v1.0.0'};
  await h.openPinModal(p);
  const button = h.get('pin-unpin');
  button.textContent = 'Unpin';
  assert.equal(button.disabled, false);
  const unpinning = button.listeners.get('click')();
  assert.equal(h.state.busy[p.slug], 'unpinning');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Unpinning…');
  pending.resolve({ok: true});
  await unpinning;
  assert.equal(h.state.busy[p.slug], null);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Unpin');
});

test('a stale unpin completion cannot close or mutate another tool modal', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => (++calls === 1 ? first.promise : second.promise),
  });
  const a = {...program('cove-a'), pinnedTag: 'v1.0.0'};
  const b = {...program('cove-b'), pinnedTag: 'v2.0.0'};
  h.window.PROGRAMS = [a, b];

  await h.openPinModal(a);
  const button = h.get('pin-unpin');
  button.textContent = 'Unpin';
  assert.equal(button.disabled, false);
  const unpinA = button.listeners.get('click')();
  h.get('pin-cancel').listeners.get('click')();
  await h.openPinModal(b);
  assert.equal(button.disabled, false);
  const unpinB = button.listeners.get('click')();
  assert.equal(button.textContent, 'Unpinning…');

  first.resolve({ok: true});
  await unpinA;
  assert.equal(h.get('pin-overlay').classList.contains('open'), true);
  assert.equal(h.get('pin-title').textContent, 'Pin cove-b');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Unpinning…');
  assert.equal(h.state.busy[a.slug], null);
  assert.equal(h.state.busy[b.slug], 'unpinning');

  second.resolve({ok: true});
  await unpinB;
});

test('opening another tool resets stale pin modal button state', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => pending.promise,
  });
  const a = {...program('cove-a'), pinnedTag: 'v1.0.0'};
  const b = {...program('cove-b'), pinnedTag: 'v2.0.0'};
  h.window.PROGRAMS = [a, b];

  await h.openPinModal(a);
  const button = h.get('pin-unpin');
  assert.equal(button.disabled, false);
  const unpinA = button.listeners.get('click')();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Unpinning…');
  h.get('pin-cancel').listeners.get('click')();
  await h.openPinModal(b);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Unpin');

  pending.resolve({ok: true});
  await unpinA;
});

test('a stale pin completion cannot close or mutate another tool modal', async () => {
  const first = deferred();
  const second = deferred();
  const firstScan = deferred();
  const secondScan = deferred();
  const pinCalls = [];
  let scans = 0;
  const h = harness({
    releases: async slug => ({ok: true, releases: [{tag: `${slug}-tag`, hasAsset: true}]}),
    pin: (slug, tag) => {
      pinCalls.push({slug, tag});
      return pinCalls.length === 1 ? first.promise : second.promise;
    },
    scan: () => (++scans === 1 ? firstScan.promise : secondScan.promise),
  });
  const a = program('cove-a');
  const b = program('cove-b');
  h.window.PROGRAMS = [a, b];
  h.state.remoteUpdates.add(a.slug);
  h.state.remoteUpdates.add(b.slug);
  const row = element();
  row.dataset.i = '0';
  h.get('pin-tag-list').querySelectorAll = selector => selector === '.tag-row' ? [row] : [];

  await h.openPinModal(a);
  row.listeners.get('click')();
  const button = h.get('pin-confirm');
  assert.equal(button.disabled, false);
  const pinA = button.listeners.get('click')();
  h.get('pin-cancel').listeners.get('click')();
  await h.openPinModal(b);
  row.listeners.get('click')();
  const bSub = h.get('pin-sub').textContent;
  assert.equal(button.disabled, false);
  const pinB = button.listeners.get('click')();
  assert.deepEqual(pinCalls, [
    {slug: a.slug, tag: 'cove-a-tag'},
    {slug: b.slug, tag: 'cove-b-tag'},
  ]);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Pinning…');

  first.resolve({ok: true, tag: 'cove-a-tag'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get('pin-overlay').classList.contains('open'), true);
  assert.equal(h.get('pin-title').textContent, 'Pin cove-b');
  assert.equal(h.get('pin-sub').textContent, bSub);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Pinning…');
  assert.equal(h.state.busy[a.slug], null);
  assert.equal(h.state.busy[b.slug], 'pinning');
  assert.equal(h.state.installedOverride[a.slug], true);
  assert.equal(h.state.remoteUpdates.has(a.slug), false);

  firstScan.resolve({installed: []});
  await pinA;
  second.resolve({ok: true, tag: 'cove-b-tag'});
  await Promise.resolve();
  secondScan.resolve({installed: []});
  await pinB;
});

test('unpin renders its owned busy state while IPC is pending', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => pending.promise,
  });
  const p = {...h.window.PROGRAMS[0], pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  h.state.onDisk.add(p.slug);
  await h.openPinModal(p);
  const button = h.get('pin-unpin');
  assert.equal(button.disabled, false);
  const unpinning = button.listeners.get('click')();
  assert.equal(h.state.busy[p.slug], 'unpinning');
  assert.match(h.get('grid').innerHTML, /Working…/);
  assert.equal(h.get('ft-primary').disabled, true);
  pending.resolve({ok: true});
  await unpinning;
});

test('pin ignores duplicate actions without clearing the first busy state', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({
    releases: async () => ({ok: true, releases: [{tag: 'v1.0.0', hasAsset: true}]}),
    pin: () => { calls++; return pending.promise; },
  });
  const p = h.window.PROGRAMS[0];
  const row = element();
  row.dataset.i = '0';
  h.get('pin-tag-list').querySelectorAll = selector => selector === '.tag-row' ? [row] : [];
  await h.openPinModal(p);
  row.listeners.get('click')();
  const button = h.get('pin-confirm');
  const firstClick = button.listeners.get('click')();
  const secondClick = button.listeners.get('click')();
  assert.equal(calls, 1);
  pending.resolve({ok: true, tag: 'v1.0.0'});
  await firstClick;
  await secondClick;
});

test('unpin ignores duplicate actions without clearing the first busy state', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => { calls++; return pending.promise; },
  });
  const p = {...h.window.PROGRAMS[0], pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  await h.openPinModal(p);
  const button = h.get('pin-unpin');
  const firstClick = button.listeners.get('click')();
  const secondClick = button.listeners.get('click')();
  assert.equal(calls, 1);
  pending.resolve({ok: true});
  await firstClick;
  await secondClick;
});

test('pin modal controls resync when another action on the same tool completes', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    update: () => pending.promise,
  });
  const p = {...h.window.PROGRAMS[0], pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  const updating = h.doUpdate(p, {rescanAfter: false});
  await h.openPinModal(p);
  assert.equal(h.get('pin-unpin').disabled, true);
  pending.resolve({ok: true});
  await updating;
  assert.equal(h.state.busy[p.slug], null);
  assert.equal(h.get('pin-unpin').disabled, false);
});

test('unpin modal resyncs visibility after the trailing rescan clears pinnedTag', async () => {
  const pending = deferred();
  const h = harness({
    releases: async () => ({ok: true, releases: []}),
    unpin: () => pending.promise,
    scan: async () => ({installed: [{slug: 'cove-example', pinnedTag: ''}]}),
  });
  const p = {...program('cove-example'), pinnedTag: 'v1.0.0'};
  h.window.PROGRAMS = [p];
  h.state.onDisk.add(p.slug);
  await h.openPinModal(p);
  const button = h.get('pin-unpin');
  assert.equal(button.style.display, 'inline-block');
  const unpinning = button.listeners.get('click')();
  pending.resolve({ok: true});
  await unpinning;
  assert.equal(p.pinnedTag, '');
  assert.equal(button.style.display, 'none');
});
