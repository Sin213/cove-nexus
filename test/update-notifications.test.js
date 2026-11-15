const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const extract = (start, end) => {
  const from = source.indexOf(start);
  assert(from >= 0, `${start} exists`);
  const to = source.indexOf(end, from);
  assert(to > from, `${end} exists after start`);
  return source.slice(from, to);
};
const update = (slug = 'cove-a', latestTag = 'v2.0.0') => ({slug, latestTag, hasUpdate: true});

test('Windows startup sets the installer AppUserModelID for installed and portable launches without throwing', () => {
  const appId = require('../package.json').build.appId;
  const startup = extract('const APP_ID =', '\nconst USER_DATA =');
  for (const platform of ['win32', 'linux']) {
    for (const portable of [false, true]) {
      for (const throws of [false, true]) {
        const calls = [];
        let named = false;
        vm.runInNewContext(startup, {
          process: {platform}, path, setupPortableMode: () => portable,
          app: {
            setAppUserModelId(value) { calls.push(value); if (throws) throw new Error('unavailable'); },
            setName() { named = true; }, setPath() {}, getPath: () => '/config',
          },
        });
        assert.deepEqual(calls, platform === 'win32' ? [appId] : []);
        assert.equal(named, true, 'startup continues');
      }
    }
  }
});

async function harness(t, initial) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cove-notifications-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'config.json');
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  const notifications = [];
  let focused = false;
  let failure;
  let supported = true;
  let onShow;
  const win = {isFocused: () => focused, isMinimized: () => true, isVisible: () => false,
    restore() { this.restored = true; }, show() { this.shown = true; }, focus() { this.focused = true; }};
  class Notification extends EventEmitter {
    static isSupported() { if (failure === 'supported') throw new Error('backend unavailable'); return supported; }
    constructor(options) { super(); if (failure === 'constructor') throw new Error('backend unavailable'); this.options = options; }
    show() {
      if (failure === 'show') throw new Error('backend unavailable');
      notifications.push(this);
      onShow?.(this);
    }
  }
  const restart = () => {
    const handlers = new Map();
    const context = vm.createContext({
      fs, path, process, USER_DATA: dir, CONFIG_FILE: file, Notification, mainWindow: win,
      defaultProgramsRoot: () => '/programs',
      decodeToken: raw => raw.githubToken || '', encodeToken: token => ({githubToken: token}), canEncryptTokens: () => false,
      isValidSlug: slug => typeof slug === 'string' && /^cove-[a-z]+$/.test(slug),
      isValidTag: tag => typeof tag === 'string' && /^v\d/.test(tag), slugToDisplayName: slug => slug,
      ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
      applyLoginItem() {}, rateLimitUntil: 0,
    });
    vm.runInContext(extract('function readConfig(', '\nfunction ensureProgramsRoot('), context);
    vm.runInContext(extract('function showMainWindow(', '\nfunction setupTray('), context);
    vm.runInContext(extract('const updateNotificationsInFlight =', '\nfunction isValidTag('), context);
    vm.runInContext(extract("ipcMain.handle('cove:config:get',", "\nipcMain.handle('cove:config:setGithubToken',"), context);
    return {notify: context.notifyProgramUpdates, config: context.readConfig,
      get: () => handlers.get('cove:config:get')(),
      set: prefs => handlers.get('cove:config:setPreferences')(null, prefs)};
  };
  return {...restart(), restart, notifications, win, disk: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    focused: value => { focused = value; }, supported: value => { supported = value; }, fail: value => { failure = value; },
    onShow: callback => { onShow = callback; }};
}

test('update notifications default off, require boolean opt-in and round-trip settings', async t => {
  const h = await harness(t);
  assert.equal(h.config().updateNotifications, false);
  assert.equal(h.get().updateNotifications, false);
  h.notify([update()]);
  assert.equal(h.notifications.length, 0);
  h.set({updateNotifications: 'true'});
  assert.equal(h.get().updateNotifications, false);
  assert.equal(h.set({updateNotifications: true}).updateNotifications, true);
  h.set({theme: 'light'});
  assert.equal(h.restart().get().updateNotifications, true);
  h.notify([update()]);
  assert.equal(h.notifications.length, 1);
  h.set({updateNotifications: false});
  h.notify([update('cove-a', 'v3.0.0')]);
  assert.equal(h.notifications.length, 1);
});

test('one combined notification dedupes each release tag across scans and restarts', async t => {
  const h = await harness(t, {updateNotifications: true, bookmarks: ['cove-a'], githubToken: 'secret'});
  const rows = [update(), update('cove-b'), update(), {...update('cove-c'), hasUpdate: false}, update('cove-d', '')];
  h.notify(rows);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].options.body, /cove-a/);
  assert.match(h.notifications[0].options.body, /cove-b/);
  h.notify(rows);
  assert.equal(h.notifications.length, 1);
  const restarted = h.restart();
  restarted.notify(rows);
  assert.equal(h.notifications.length, 1);
  restarted.notify([update('cove-a', 'v3.0.0')]);
  assert.equal(h.notifications.length, 2);
  h.restart().notify(rows);
  assert.equal(h.notifications.length, 2, 'older notified tags remain deduped too');
  assert.deepEqual(h.disk().bookmarks, ['cove-a']);
  assert.equal(h.disk().githubToken, 'secret');
});

test('asynchronous native failure removes only its tags and allows a combined retry after restart', async t => {
  const h = await harness(t, {updateNotifications: true, notifiedUpdateTags: ['cove-prior@v1.0.0']});
  const rows = [update(), update('cove-b')];
  h.notify(rows);
  const failed = h.notifications[0];
  h.set({theme: 'light', bookmarks: ['cove-b']});
  h.notify([update('cove-c')]);
  await Promise.resolve();
  failed.emit('failed', new Error('backend unavailable'));
  assert.deepEqual(h.disk().notifiedUpdateTags, ['cove-prior@v1.0.0', 'cove-c@v2.0.0']);
  assert.equal(h.disk().theme, 'light');
  assert.deepEqual(h.disk().bookmarks, ['cove-b']);
  const restarted = h.restart();
  restarted.notify([...rows, update('cove-c')]);
  assert.equal(h.notifications.length, 3);
  assert.match(h.notifications[2].options.body, /cove-a/);
  assert.match(h.notifications[2].options.body, /cove-b/);
  assert.doesNotMatch(h.notifications[2].options.body, /cove-c/);
  restarted.notify(rows);
  assert.equal(h.notifications.length, 3, 'successful retry stays deduped');
});

test('overlapping scans cannot announce keys still being shown or lose other announced tags', async t => {
  const h = await harness(t, {updateNotifications: true});
  h.onShow(() => {
    h.onShow(null);
    h.notify([update(), update('cove-b'), update('cove-c')]);
  });
  h.notify([update(), update('cove-b')]);
  assert.equal(h.notifications.length, 2);
  assert.match(h.notifications[1].options.body, /cove-c/);
  assert.doesNotMatch(h.notifications[1].options.body, /cove-a|cove-b/);
  assert.deepEqual(h.disk().notifiedUpdateTags.slice().sort(), ['cove-a@v2.0.0', 'cove-b@v2.0.0', 'cove-c@v2.0.0']);
  h.restart().notify([update(), update('cove-b'), update('cove-c')]);
  assert.equal(h.notifications.length, 2);
});

test('a failure emitted during show does not persist or retain in-flight keys', async t => {
  const h = await harness(t, {updateNotifications: true});
  h.onShow(notification => notification.emit('failed', new Error('backend unavailable')));
  h.notify([update()]);
  assert.deepEqual(h.disk().notifiedUpdateTags || [], []);
  h.onShow(null);
  h.notify([update()]);
  assert.equal(h.notifications.length, 2);
  assert.deepEqual(h.disk().notifiedUpdateTags, ['cove-a@v2.0.0']);
});

test('focused windows suppress notifications without consuming tags; click restores, shows and focuses', async t => {
  const h = await harness(t, {updateNotifications: true});
  h.focused(true);
  h.notify([update()]);
  assert.equal(h.notifications.length, 0);
  h.focused(false);
  h.notify([update()]);
  assert.equal(h.notifications.length, 1);
  h.notifications[0].emit('click');
  assert.equal(h.win.restored, true);
  assert.equal(h.win.shown, true);
  assert.equal(h.win.focused, true);
});

test('unsupported or throwing native notifications are safe and leave tags eligible for retry', async t => {
  const h = await harness(t, {updateNotifications: true});
  h.supported(false);
  assert.doesNotThrow(() => h.notify([update()]));
  h.supported(true);
  for (const failure of ['supported', 'constructor', 'show']) {
    h.fail(failure);
    assert.doesNotThrow(() => h.notify([update()]));
  }
  assert.equal(h.notifications.length, 0);
  h.fail(null);
  h.notify([update()]);
  assert.equal(h.notifications.length, 1);
  assert.doesNotThrow(() => h.notifications[0].emit('failed', new Error('backend failed')));
});

test('existing update scan supplies one combined batch; local-only scans do not notify', async () => {
  const handlers = new Map();
  const batches = [];
  const context = {
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    reconcilePrograms: () => new Map(), readRegistry: () => ({'cove-a': {}, 'cove-b': {}}),
    scanOneInstalled: async slug => update(slug),
    readConfig: () => ({programsRoot: '/programs'}), exists: () => false,
    LEGACY_PROGRAMS: '/legacy', rateLimitUntil: 0,
    notifyProgramUpdates: rows => batches.push(rows),
  };
  const scan = extract("ipcMain.handle('cove:scan',", "\nipcMain.handle('cove:install',");
  vm.runInNewContext(scan, context);
  await handlers.get('cove:scan')(null, {checkUpdates: false});
  assert.equal(batches.length, 0);
  await handlers.get('cove:scan')(null, {checkUpdates: true});
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
});
