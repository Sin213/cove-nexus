const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { captureStderr } = require('../lib/processes');

test('diagnostics stay bounded while a child can write after five seconds', { timeout: 12000 }, async t => {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    fs.writeSync(2, Buffer.alloc(16384, 'x'));
    process.exitCode = 1;
    process.stderr.on('error', () => {});
    setTimeout(() => {
      process.stderr.write(Buffer.alloc(256 * 1024, 'y'), error => {
        if (!error) process.exitCode = 0;
      });
    }, 7500);
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const read = captureStderr(child.stderr);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(Buffer.byteLength(read()), 4096);
});
