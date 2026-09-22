const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createSelfUpdateController, hasActiveHostedSession } = require('../lib/self-update');

test('downloaded updates preserve active hosted work until the user restarts', () => {
  let installs = 0;
  const notifications = [];
  const updater = createSelfUpdateController({ install: () => { installs++; },
    notify: value => notifications.push(value), hasActiveSession: () => true });
  updater.downloaded('2.6.0');
  assert.equal(installs, 0);
  assert.deepEqual(updater.getState(), { state: 'downloaded', version: '2.6.0' });
  assert.equal(notifications.length, 1);
  assert.deepEqual(updater.installReady(), { ok: true });
  assert.equal(installs, 1);
  assert.equal(updater.installReady().ok, false);
});

test('idle installed builds retain automatic installation', () => {
  let installs = 0;
  const updater = createSelfUpdateController({ install: () => { installs++; }, notify: () => {}, hasActiveSession: () => false });
  updater.downloaded('2.6.0');
  assert.equal(installs, 1);
});

test('AppImage replacement waits for an explicit restart even while idle', () => {
  let installs = 0;
  const updater = createSelfUpdateController({ autoInstall: false, install: () => { installs++; }, notify: () => {}, hasActiveSession: () => false });
  updater.downloaded('2.6.0');
  assert.equal(installs, 0);
  updater.installReady();
  assert.equal(installs, 1);
});

test('failed installation remains available for retry', () => {
  let installs = 0;
  const updater = createSelfUpdateController({ install: () => {
    installs++;
    if (installs < 3) throw new Error('installer failed');
  }, notify: () => {}, hasActiveSession: () => false });
  updater.downloaded('2.6.0');
  assert.equal(installs, 1);
  assert.match(updater.getState().error, /installer failed/);
  assert.equal(updater.installReady().ok, false);
  assert.equal(installs, 2);
  assert.deepEqual(updater.installReady(), { ok: true });
  assert.equal(installs, 3);
});

test('paused and launching hosted sessions count as active work', () => {
  assert.equal(hasActiveHostedSession([{ openMode: 'tab-web', status: 'launching' }]), true);
  assert.equal(hasActiveHostedSession([{ openMode: 'tab-web', status: 'running', protocol: { tabClosed: true } }]), true);
  assert.equal(hasActiveHostedSession([{ openMode: 'external', status: 'running' }, { openMode: 'tab-web', status: 'exited' }]), false);
});

test('AppImage restart executes the updated file rather than the old mounted executable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const from = source.indexOf('function setupAutoUpdater(');
  const to = source.indexOf('// Portable-only:', from);
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  const restarts = [];
  let quits = 0;
  const context = vm.createContext({
    app: { isPackaged: true, relaunch: options => restarts.push(options), quit: () => { quits++; } },
    isWindowsPortable: () => false, require: () => ({ autoUpdater: updater }),
    process: { platform: 'linux', env: { APPIMAGE: '/applications/Cove-Nexus.AppImage' } },
    selfUpdateController: null, createSelfUpdateController, hasActiveHostedSession,
    processRegistry: new Map(), mainWindow: null, setInterval: () => {}, console,
    installAppImageUpdate: () => {},
  });
  vm.runInContext(source.slice(from, to), context);
  context.setupAutoUpdater();
  updater.emit('update-downloaded', { version: '2.6.0', downloadedFile: '/cache/new.AppImage' });
  assert.equal(restarts.length, 0);
  assert.equal(context.selfUpdateController.installReady().ok, true);
  assert.equal(restarts[0].execPath, '/applications/Cove-Nexus.AppImage');
  assert.equal(quits, 1);
});
