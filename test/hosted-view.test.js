const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { buildHostedView } = require('../lib/hosted-view');
const URL_OK = 'http://127.0.0.1:43210/editor';

function createHarness({ slug = 'cove-meme-maker', reject = false, hang = false, loadTimeoutMs = 15000 } = {}) {
  const loaded = [], failed = [], sessions = [];
  class FakeView {
    constructor(options) {
      this.options = options;
      const contents = this.webContents = new EventEmitter();
      contents.session = {
        setPermissionCheckHandler: handler => { contents.check = handler; },
        setPermissionRequestHandler: handler => { contents.request = handler; },
      };
      contents.setWindowOpenHandler = handler => { contents.popup = handler; };
      contents.isDestroyed = () => false;
      contents.getURL = () => URL_OK;
      contents.loadURL = async () => {
        if (reject) throw new Error('connection refused');
        if (hang) await new Promise(() => {});
      };
    }
  }
  const view = buildHostedView({ WebContentsView: FakeView, slug, url: URL_OK, loadTimeoutMs,
    onLoaded: view => loaded.push(view), onFailure: (view, error) => failed.push({ view, error }),
    wireDownloads: session => sessions.push(session),
  });
  return { view, loaded, failed, sessions };
}

test('hosted tools have distinct sessions and explicit permission rules', () => {
  const { view, sessions } = createHarness();
  const other = createHarness({ slug: 'cove-other' }).view;
  const contents = view.webContents;
  assert.notEqual(view.options.webPreferences.partition, other.options.webPreferences.partition);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.deepEqual(sessions, [contents.session]);
  for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fileSystem']) {
    assert.equal(contents.check(contents, permission, URL_OK), false);
    let granted;
    contents.request(contents, permission, value => { granted = value; }, { requestingUrl: URL_OK });
    assert.equal(granted, false);
  }
  assert.equal(contents.check(contents, 'clipboard-sanitized-write', URL_OK), true);
  assert.equal(contents.check(contents, 'clipboard-sanitized-write', 'https://example.com'), false);
  assert.equal(contents.check(other.webContents, 'clipboard-sanitized-write', URL_OK), false);
  assert.deepEqual(contents.popup({ url: URL_OK }), { action: 'deny' });
});

test('main-frame navigation and redirects stay at the reported origin', () => {
  const { view } = createHarness();
  for (const event of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    view.webContents.emit(event, { isMainFrame: true, url: 'https://example.com', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    prevented = false;
    view.webContents.emit(event, { isMainFrame: true, url: URL_OK, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
  }
});

test('load errors and renderer crashes reach recovery handling', async () => {
  const harness = createHarness({ reject: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.loaded.length, 0);
  assert.match(harness.failed[0].error, /connection refused/);
  harness.view.webContents.emit('did-fail-load', {}, -102, 'CONNECTION_REFUSED', URL_OK, true);
  assert.equal(harness.failed.length, 1, 'a single failure is reported once');
  const loaded = createHarness();
  await new Promise(resolve => setImmediate(resolve));
  loaded.view.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.match(loaded.failed[0].error, /crashed/);
});

test('readiness is reported only after load finishes', async () => {
  const harness = createHarness();
  assert.equal(harness.loaded.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.loaded, [harness.view]);
  assert.deepEqual(harness.failed, []);
});

test('a server that never finishes loading exposes recovery after a bounded wait', async () => {
  const harness = createHarness({ hang: true, loadTimeoutMs: 15 });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(harness.loaded.length, 0);
  assert.equal(harness.failed.length, 1);
  assert.match(harness.failed[0].error, /too long to load/);
});

test('closing a pending view cancels its load deadline', async () => {
  const harness = createHarness({ hang: true, loadTimeoutMs: 15 });
  harness.view.webContents.emit('destroyed');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(harness.failed, []);
});
