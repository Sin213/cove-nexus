const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const slug = 'cove-editor';

function harness({source: ownership = 'managed', status, response = 1, confirm, install} = {}) {
  const start = source.indexOf("ipcMain.handle('cove:repair',");
  assert(start >= 0, 'repair IPC exists');
  const end = source.indexOf('\n});', start) + 4;
  const handlers = new Map();
  const calls = [];
  const registry = {[slug]: {source: ownership, tag: 'v1.2.3', pinnedTag: 'v1.0.0', path: '/programs/editor'}};
  const processRegistry = new Map(status ? [[slug, {status}]] : []);
  const repairsInFlight = new Set();
  const context = {
    ipcMain: {handle: (key, fn) => handlers.set(key, fn)},
    isValidSlug: value => value === slug, isValidTag: value => /^v\d/.test(value),
    readRegistry: () => structuredClone(registry), reconcilePrograms() {},
    processRegistry, repairsInFlight, mainWindow: null,
    dialog: {showMessageBox: async (...args) => { calls.push(['confirm', ...args]); return confirm ? confirm() : {response}; }},
    installOrUpdate: async (...args) => { calls.push(['install', ...args]); return install ? install(...args) : {ok: true, tag: registry[slug].tag}; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return {repair: value => handlers.get('cove:repair')(null, value), calls, registry, processRegistry, repairsInFlight};
}

test('repair rejects invalid slugs, adopted/missing installs, and running or launching apps before confirmation', async () => {
  for (const options of [{source: 'adopted'}, {source: undefined, status: 'running'}, {status: 'launching'}]) {
    const h = harness(options);
    assert.equal((await h.repair(slug)).ok, false);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  assert.equal((await h.repair('../outside')).ok, false);
  delete h.registry[slug];
  assert.equal((await h.repair(slug)).ok, false);
  assert.equal(h.calls.length, 0);
});

test('repair confirms and forces the installed tag, preserving pin and ownership', async () => {
  const h = harness();
  const before = structuredClone(h.registry);
  const result = await h.repair(slug);
  assert.equal(result.ok, true);
  assert.equal(h.calls[0][0], 'confirm');
  assert.match(JSON.stringify(h.calls[0]), /v1\.2\.3/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), ['install', slug, {force: true, tag: 'v1.2.3'}]);
  assert.deepEqual(h.registry, before);
  assert.equal(h.repairsInFlight.size, 0);
});

test('repair cancellation and unknown installed tags never resolve latest', async () => {
  const h = harness({response: 0});
  assert.equal((await h.repair(slug)).cancelled, true);
  assert.equal(h.calls.length, 1);
  h.registry[slug].tag = '';
  assert.equal((await h.repair(slug)).ok, false);
  assert.equal(h.calls.length, 1);
});

test('repair rechecks process and ownership after confirmation, and releases its lock on errors', async () => {
  for (const change of ['running', 'adopted', 'tag']) {
    const h = harness({confirm: () => {
      if (change === 'running') h.processRegistry.set(slug, {status: 'running'});
      else if (change === 'adopted') h.registry[slug].source = 'adopted';
      else h.registry[slug].tag = 'v9.0.0';
      return {response: 1};
    }});
    assert.equal((await h.repair(slug)).ok, false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.repairsInFlight.size, 0);
  }
  const h = harness({install: () => { throw new Error('download unavailable'); }});
  assert.match((await h.repair(slug)).error, /download unavailable/);
  assert.equal(h.repairsInFlight.size, 0);
});

test('repair prevents concurrent repair prompts and launches until replacement finishes', async () => {
  let finish;
  const h = harness({install: () => new Promise(resolve => { finish = resolve; })});
  const pending = h.repair(slug);
  await Promise.resolve();
  assert.equal((await h.repair(slug)).ok, false);
  const start = source.indexOf("ipcMain.handle('cove:launch',");
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    ipcMain: {handle: (key, fn) => handlers.set(key, fn)},
    isValidSlug: () => true, repairsInFlight: h.repairsInFlight,
  });
  assert.equal((await handlers.get('cove:launch')(null, slug)).ok, false);
  finish({ok: true});
  await pending;
  assert.equal(h.repairsInFlight.size, 0);
});
