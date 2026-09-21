const { test } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveOpenMode } = require('../lib/open-mode');

test('embedded mode requires a supported and working protocol transport', () => {
  assert.equal(effectiveOpenMode('tab-web', 'win32', null), 'external');
  assert.equal(effectiveOpenMode('tab-web', 'linux', null), 'external');
  assert.equal(effectiveOpenMode('tab-web', 'linux', '/run/user/1000/app.sock'), 'tab-web');
  assert.equal(effectiveOpenMode('external', 'linux', '/run/user/1000/app.sock'), 'external');
});
