const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { withInstallWorkspace, checksumForAsset, installAssetPath } = require('../lib/install-workspace');

test('concurrent installs isolate identically named checksum files and clean up', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cove-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ready = [];
  const results = await Promise.all(['app-a', 'app-b'].map(app => withInstallWorkspace(root, async (directory) => {
    const checksum = path.join(directory, 'checksums-sha256.txt.part');
    await fs.writeFile(checksum, app);
    await new Promise(resolve => { ready.push(resolve); if (ready.length === 2) ready.forEach(release => release()); });
    assert.equal(await fs.readFile(checksum, 'utf8'), app);
    return directory;
  })));
  assert.notEqual(results[0], results[1]);
  assert.deepEqual(await fs.readdir(root), []);
});

test('failed installs clean up all temporary files while preserving the prior binary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cove-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'existing.AppImage'), 'working');
  await assert.rejects(withInstallWorkspace(root, async (directory) => {
    await fs.writeFile(path.join(directory, 'asset.part'), 'partial');
    await fs.writeFile(path.join(directory, 'checksum.part'), 'invalid');
    throw new Error('checksum mismatch');
  }), /checksum mismatch/);
  assert.deepEqual(await fs.readdir(root), ['existing.AppImage']);
  assert.equal(await fs.readFile(path.join(root, 'existing.AppImage'), 'utf8'), 'working');
});

test('bundled checksums match the complete filename and accept text/binary sha256sum formats', () => {
  const hash = 'A'.repeat(64);
  const otherHash = 'b'.repeat(64);
  const filename = 'cove-app-1.0.0-x86_64.AppImage';
  const text = `${otherHash}  prefixed-${filename}\n${hash} *${filename}\n`;
  assert.equal(checksumForAsset(text, filename, true), hash.toLowerCase());
  assert.equal(checksumForAsset(`${hash}  ${filename}`, filename, true), hash.toLowerCase());
  assert.equal(checksumForAsset(`${hash}  other-${filename}`, filename, true), '');
  assert.equal(checksumForAsset(`${hash}\n`, filename), hash.toLowerCase());
});

test('release asset paths reject traversal and Windows path syntax on every platform', () => {
  const root = path.resolve('/programs');
  for (const name of ['../evil.exe', 'sub/evil.exe', 'sub\\evil.exe', 'C:evil.exe', '.', '..', '', 'file:stream.exe']) {
    assert.throws(() => installAssetPath(root, name), /invalid release asset/);
  }
  assert.equal(installAssetPath(root, 'Cove-App-1.0.0-Portable.exe'), path.join(root, 'Cove-App-1.0.0-Portable.exe'));
});
