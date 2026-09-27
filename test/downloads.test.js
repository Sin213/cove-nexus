const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { sanitizeDownloadName, uniqueDownloadPath } = require('../lib/downloads');

const DIR = '/downloads';

// exists(): treat every path in `taken` as already on disk.
function existsFrom(taken) {
  const set = new Set(taken);
  return (p) => set.has(p);
}

test('sanitizeDownloadName keeps a plain filename', () => {
  assert.strictEqual(sanitizeDownloadName('meme.png'), 'meme.png');
});

test('sanitizeDownloadName strips directory components', () => {
  assert.strictEqual(sanitizeDownloadName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeDownloadName('/abs/path/meme.png'), 'meme.png');
  assert.strictEqual(sanitizeDownloadName('sub\\dir\\meme.png'), 'meme.png');
});

test('sanitizeDownloadName falls back for empty or dot-only names', () => {
  assert.strictEqual(sanitizeDownloadName(''), 'download');
  assert.strictEqual(sanitizeDownloadName('.'), 'download');
  assert.strictEqual(sanitizeDownloadName('..'), 'download');
  assert.strictEqual(sanitizeDownloadName(null), 'download');
  assert.strictEqual(sanitizeDownloadName('/'), 'download');
});

test('sanitizeDownloadName drops NUL and control characters', () => {
  const NUL = String.fromCharCode(0);
  assert.strictEqual(sanitizeDownloadName(`me${NUL}me.png`), 'meme.png');
  assert.strictEqual(sanitizeDownloadName(`a${String.fromCharCode(127)}b.png`), 'ab.png');
});

test('uniqueDownloadPath returns the plain path when nothing is taken', () => {
  const p = uniqueDownloadPath(DIR, 'meme.png', existsFrom([]));
  assert.strictEqual(p, path.join(DIR, 'meme.png'));
});

test('uniqueDownloadPath suffixes before the extension on collision', () => {
  const p = uniqueDownloadPath(DIR, 'meme.png', existsFrom([path.join(DIR, 'meme.png')]));
  assert.strictEqual(p, path.join(DIR, 'meme (1).png'));
});

test('uniqueDownloadPath keeps counting past multiple collisions', () => {
  const taken = [
    path.join(DIR, 'meme.png'),
    path.join(DIR, 'meme (1).png'),
    path.join(DIR, 'meme (2).png'),
  ];
  assert.strictEqual(uniqueDownloadPath(DIR, 'meme.png', existsFrom(taken)), path.join(DIR, 'meme (3).png'));
});

test('uniqueDownloadPath handles extensionless names', () => {
  const p = uniqueDownloadPath(DIR, 'export', existsFrom([path.join(DIR, 'export')]));
  assert.strictEqual(p, path.join(DIR, 'export (1)'));
});

test('uniqueDownloadPath handles dotfiles without inventing an extension', () => {
  const p = uniqueDownloadPath(DIR, '.env', existsFrom([path.join(DIR, '.env')]));
  assert.strictEqual(p, path.join(DIR, '.env (1)'));
});

test('uniqueDownloadPath sanitizes traversal before joining', () => {
  const p = uniqueDownloadPath(DIR, '../../evil.png', existsFrom([]));
  assert.strictEqual(p, path.join(DIR, 'evil.png'));
  assert.ok(p.startsWith(path.join(DIR) + path.sep));
});

// Regression: two downloads of the same name that start before either file
// exists must not be handed the same path. main.js feeds an `exists` that also
// reports paths claimed by in-flight downloads; this models that contract.
test('uniqueDownloadPath de-duplicates against in-flight downloads, not just disk', () => {
  const onDisk = new Set();          // nothing written yet
  const pending = new Set();         // reservations held by active downloads
  const taken = (p) => pending.has(p) || onDisk.has(p);

  const first = uniqueDownloadPath(DIR, 'meme.png', taken);
  pending.add(first);
  const second = uniqueDownloadPath(DIR, 'meme.png', taken);
  pending.add(second);
  const third = uniqueDownloadPath(DIR, 'meme.png', taken);

  assert.strictEqual(first, path.join(DIR, 'meme.png'));
  assert.strictEqual(second, path.join(DIR, 'meme (1).png'));
  assert.strictEqual(third, path.join(DIR, 'meme (2).png'));
  assert.strictEqual(new Set([first, second, third]).size, 3);
});

test('uniqueDownloadPath never returns a taken path even at the attempt cap', () => {
  // Every candidate up to the cap is taken; the fallback must still be free.
  const exists = (p) => !/\d{6,}/.test(path.basename(p));
  const p = uniqueDownloadPath(DIR, 'meme.png', exists);
  assert.strictEqual(exists(p), false);
  assert.ok(p.endsWith('.png'));
});
