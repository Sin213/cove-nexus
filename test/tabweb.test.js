const test = require('node:test');
const assert = require('node:assert');

const { tabReadyDecision, canResumeHostedView, isValidTabUrl: isValidUrl } = require('../lib/tabweb');
const URL_OK = 'http://127.0.0.1:43411/';

const tabWeb = (over = {}) => ({ openMode: 'tab-web', status: 'running', ...over });
const proto = (over = {}) => ({ tabUrl: null, tabFallback: false, tabClosed: false, ...over });

test('tab_ready attaches for a fresh tab-web run', () => {
  assert.strictEqual(tabReadyDecision(tabWeb(), proto(), URL_OK, isValidUrl), 'attach');
});

test('tab_ready is ignored for external runs', () => {
  assert.strictEqual(tabReadyDecision(tabWeb({ openMode: 'external' }), proto(), URL_OK, isValidUrl), 'ignore');
});

test('tab_ready is ignored for a non-loopback or malformed URL', () => {
  assert.strictEqual(tabReadyDecision(tabWeb(), proto(), 'http://example.com/', isValidUrl), 'ignore');
  assert.strictEqual(tabReadyDecision(tabWeb(), proto(), 'not-a-url', isValidUrl), 'ignore');
  assert.strictEqual(tabReadyDecision(tabWeb(), proto(), null, isValidUrl), 'ignore');
});

test('tab_ready is ignored when a URL was already recorded (duplicate)', () => {
  assert.strictEqual(tabReadyDecision(tabWeb(), proto({ tabUrl: URL_OK }), URL_OK, isValidUrl), 'ignore');
});

test('late tab_ready recovers a startup timeout while the process is still embedded', () => {
  assert.strictEqual(tabReadyDecision(tabWeb(), proto({ tabFallback: true, tabError: 'timed out' }), URL_OK, isValidUrl), 'attach');
});

// Regression: closing the tab before tab_ready arrived used to leave an
// orphaned hosted view alive with no tab showing it.
test('tab_ready only records (never attaches) when the tab was closed first', () => {
  assert.strictEqual(tabReadyDecision(tabWeb(), proto({ tabClosed: true }), URL_OK, isValidUrl), 'record');
});

test('canResumeHostedView allows rebuilding a paused running session', () => {
  const e = tabWeb({ protocol: proto({ tabUrl: URL_OK, tabClosed: true }) });
  assert.strictEqual(canResumeHostedView(e, isValidUrl), true);
});

test('canResumeHostedView refuses when the process is gone', () => {
  const e = tabWeb({ status: 'exited', protocol: proto({ tabUrl: URL_OK, tabClosed: true }) });
  assert.strictEqual(canResumeHostedView(e, isValidUrl), false);
});

test('canResumeHostedView refuses without a recorded URL', () => {
  assert.strictEqual(canResumeHostedView(tabWeb({ protocol: proto() }), isValidUrl), false);
  assert.strictEqual(canResumeHostedView(tabWeb(), isValidUrl), false);
});

test('canResumeHostedView refuses a stale non-loopback URL', () => {
  const e = tabWeb({ protocol: proto({ tabUrl: 'http://evil.example/' }) });
  assert.strictEqual(canResumeHostedView(e, isValidUrl), false);
});

test('canResumeHostedView refuses external runs', () => {
  const e = tabWeb({ openMode: 'external', protocol: proto({ tabUrl: URL_OK }) });
  assert.strictEqual(canResumeHostedView(e, isValidUrl), false);
});

test('a failed hosted page waits for explicit recovery instead of retrying on each bounds update', () => {
  const entry = tabWeb({ protocol: proto({ tabUrl: URL_OK, tabError: 'connection refused' }) });
  assert.strictEqual(canResumeHostedView(entry, isValidUrl), false);
  assert.strictEqual(tabReadyDecision(entry, entry.protocol, URL_OK, isValidUrl), 'attach');
});

test('real tab URL validation requires uncredentialed loopback HTTP and an unprivileged port', () => {
  assert.strictEqual(isValidUrl('http://127.0.0.1:1024/editor?document=one'), true);
  for (const value of [null, 'https://127.0.0.1:1234/', 'http://localhost:1234/',
    'http://127.0.0.1:80/', 'http://user:pass@127.0.0.1:1234/', 'file:///tmp/app.html']) {
    assert.strictEqual(isValidUrl(value), false, String(value));
  }
});
