const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { withInstallWorkspace, checksumForAsset, installAssetPath } = require('../lib/install-workspace');
const { matchAsset } = require('../lib/reconcile');

// Exercise the actual orchestration without starting Electron. File creation,
// checksum reads, chmod, rename, hashing and cleanup all use a real temp disk.
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const installSource = mainSource.slice(mainSource.indexOf('async function installOrUpdateInner('), mainSource.indexOf('\nfunction sha256File('));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

async function harness(t, { download, filesystem = fs, initial = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cove-install-integration-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const registry = { ...initial };
  const releases = {};
  const content = {};
  const registered = [];
  const resolutions = [];
  const repairsInFlight = new Set();
  const context = {
    process, path, fs: filesystem, fsp, withInstallWorkspace, checksumForAsset, installAssetPath, matchAsset,
    repairsInFlight,
    resolveRelease: async (slug, options) => { resolutions.push({slug, ...options}); return releases[slug]; },
    sendProgress() {},
    pickAsset: assets => assets[0],
    reconcilePrograms() {},
    readRegistry: () => structuredClone(registry),
    ensureProgramsRoot: () => root,
    exists: fs.existsSync,
    downloadToFile: (url, dest) => download ? download(url, dest, content) : fsp.writeFile(dest, content[url]),
    sha256File: async file => hash(await fsp.readFile(file)),
    unblockExe() {},
    registerInstall(slug, entry) { registry[slug] = {...registry[slug], ...entry}; registered.push(slug); },
  };
  const install = vm.runInNewContext(`${installSource}\ninstallOrUpdateInner`, context);
  function release(slug, { checksum = true, name = `${slug}-2.0.0-x86_64.AppImage` } = {}) {
    const binary = `binary for ${slug}`;
    content[slug] = binary;
    content[`sha:${slug}`] = `${hash(binary)}  ${name}\n`;
    releases[slug] = { tag_name: 'v2.0.0', assets: [
      { name, size: binary.length, browser_download_url: slug },
      ...(checksum ? [{ name: 'checksums-sha256.txt', browser_download_url: `sha:${slug}` }] : []),
    ] };
    return name;
  }
  const handlers = new Map();
  Object.assign(context, {
    ipcMain: {handle: (key, fn) => handlers.set(key, fn)},
    isValidSlug: value => /^cove-[a-z-]+$/.test(value), isValidTag: value => /^v\d/.test(value),
    processRegistry: new Map(), mainWindow: null,
    dialog: {showMessageBox: async () => ({response: 1})}, installOrUpdate: install,
  });
  const repairStart = mainSource.indexOf("ipcMain.handle('cove:repair',");
  assert(repairStart >= 0);
  vm.runInNewContext(mainSource.slice(repairStart, mainSource.indexOf('\n});', repairStart) + 4), context);
  return { root, registry, registered, install, release, content, releases, resolutions, repairsInFlight,
    repair: slug => handlers.get('cove:repair')(null, slug) };
}

test('repair replaces the same installed release, preserving pin, registry settings and app settings bytes', async t => {
  const h = await harness(t);
  const slug = 'cove-editor';
  const name = h.release(slug);
  const prior = path.join(h.root, name);
  const settings = path.join(h.root, 'editor-settings.json');
  await fsp.writeFile(prior, 'damaged binary');
  await fsp.writeFile(settings, '{"theme":"light","workspace":"keep"}\n');
  h.registry[slug] = {tag: 'v2.0.0', path: prior, source: 'managed', pinnedTag: 'v1.0.0', customSetting: 'keep'};
  const before = structuredClone(h.registry[slug]);
  assert.equal((await h.repair(slug)).ok, true);
  assert.deepEqual(h.resolutions, [{slug, tag: 'v2.0.0'}]);
  assert.deepEqual(h.registry[slug], before);
  assert.equal(await fsp.readFile(prior, 'utf8'), 'binary for cove-editor');
  assert.equal(await fsp.readFile(settings, 'utf8'), '{"theme":"light","workspace":"keep"}\n');
});

test('repair download and checksum failures leave original binary and registry intact', async t => {
  for (const failure of ['download', 'checksum-download', 'checksum-mismatch']) {
    const h = await harness(t, {download: async (url, dest, content) => {
      if (failure === 'download' || (url.startsWith('sha:') && failure === 'checksum-download')) throw new Error('download failed');
      await fsp.writeFile(dest, url.startsWith('sha:') && failure === 'checksum-mismatch' ? '0'.repeat(64) : content[url]);
    }});
    const slug = 'cove-editor';
    const name = h.release(slug);
    const prior = path.join(h.root, name);
    await fsp.writeFile(prior, 'working original');
    h.registry[slug] = {tag: 'v2.0.0', path: prior, source: 'managed', pinnedTag: 'v1.0.0'};
    const before = structuredClone(h.registry[slug]);
    assert.equal((await h.repair(slug)).ok, false);
    assert.equal(await fsp.readFile(prior, 'utf8'), 'working original');
    assert.deepEqual(h.registry[slug], before);
    assert.deepEqual(await fsp.readdir(h.root), [name]);
    assert.equal(h.registered.length, 0);
  }
});

test('repair refuses replacement if an install becomes adopted during the download', async t => {
  const h = await harness(t, {download: async (url, dest, content) => {
    await fsp.writeFile(dest, content[url]);
    h.registry['cove-editor'].source = 'adopted';
  }});
  const name = h.release('cove-editor');
  const prior = path.join(h.root, name);
  await fsp.writeFile(prior, 'adopted bytes');
  h.registry['cove-editor'] = {tag: 'v2.0.0', path: prior, source: 'managed'};
  assert.equal((await h.repair('cove-editor')).ok, false);
  assert.equal(await fsp.readFile(prior, 'utf8'), 'adopted bytes');
});

test('actual concurrent installs verify separate legacy bundles and leave no temporary directories', async (t) => {
  const ready = [];
  const checksumPaths = [];
  const h = await harness(t, { download: async (url, dest, content) => {
    await fsp.writeFile(dest, content[url]);
    if (url.startsWith('sha:')) {
      checksumPaths.push(dest);
      await new Promise(resolve => { ready.push(resolve); if (ready.length === 2) ready.forEach(release => release()); });
    }
  } });
  const names = ['cove-a', 'cove-b'].map(slug => h.release(slug));
  await Promise.all(['cove-a', 'cove-b'].map(slug => h.install(slug)));
  assert.equal(new Set(checksumPaths).size, 2);
  assert.deepEqual((await fsp.readdir(h.root)).sort(), names.sort());
  assert.equal(h.registered.length, 2);
  for (const slug of ['cove-a', 'cove-b']) {
    assert.equal(await fsp.readFile(h.registry[slug].path, 'utf8'), `binary for ${slug}`);
  }
});

test('actual install fails closed on missing or mismatched published checksums', async (t) => {
  for (const failure of ['missing', 'mismatch']) {
    const h = await harness(t, { download: async (url, dest, content) => {
      if (url.startsWith('sha:')) {
        if (failure === 'missing') throw new Error('checksum download unavailable');
        return fsp.writeFile(dest, `${'0'.repeat(64)}  cove-app-2.0.0-x86_64.AppImage\n`);
      }
      await fsp.writeFile(dest, content[url]);
    } });
    h.release('cove-app');
    const prior = path.join(h.root, 'cove-app-1.0.0-x86_64.AppImage');
    await fsp.writeFile(prior, 'working');
    h.registry['cove-app'] = { tag: 'v1.0.0', path: prior, source: 'managed' };
    await assert.rejects(h.install('cove-app'), /checksum/);
    assert.equal(await fsp.readFile(prior, 'utf8'), 'working');
    assert.deepEqual(await fsp.readdir(h.root), [path.basename(prior)]);
    assert.equal(h.registered.length, 0);
  }
});

test('actual install checks executable permissions before replacing the existing binary', async (t) => {
  if (process.platform === 'win32') return t.skip('chmod is only required on Unix');
  const h = await harness(t, { filesystem: { ...fs, chmodSync() { throw new Error('permission denied'); } } });
  const name = h.release('cove-app', { checksum: false });
  const prior = path.join(h.root, name);
  await fsp.writeFile(prior, 'working');
  h.registry['cove-app'] = { tag: 'v1.0.0', path: prior, source: 'managed' };
  await assert.rejects(h.install('cove-app'), /could not make .* executable/);
  assert.equal(await fsp.readFile(prior, 'utf8'), 'working');
  assert.deepEqual(await fsp.readdir(h.root), [name]);
  assert.equal(h.registered.length, 0);
});

test('actual install rejects unsafe asset paths before downloading', async (t) => {
  let downloaded = false;
  const h = await harness(t, { download: async () => { downloaded = true; } });
  for (const name of ['../outside.exe', '..\\outside.exe']) {
    h.release('cove-app', { name });
    await assert.rejects(h.install('cove-app'), /invalid release asset filename|does not match/);
  }
  assert.equal(downloaded, false);
  assert.deepEqual(await fsp.readdir(h.root), []);
});

// B4: a catalog-only install for one slug must never land on, or delete,
// another program's file just because the resolved release's asset (or a
// stray registry entry) happens to carry a different program's filename
// shape. Real production shapes: an unrelated program already installed
// under its own slug/registry entry, and the requested slug's release
// happens to point at a filename that structurally belongs to that
// unrelated program (mis-published asset, wrong cached release, etc.).
test('B4: installing one slug must not overwrite a different program\'s on-disk binary', async (t) => {
  const h = await harness(t);
  const neighborName = 'Cove-Video-Editor-2.4.0-x86_64.AppImage';
  const neighborPath = path.join(h.root, neighborName);
  await fsp.writeFile(neighborPath, 'video-editor-binary-untouched');
  h.registry['cove-video-editor'] = { tag: 'v2.4.0', path: neighborPath, source: 'managed' };

  // cove-audio-editor's resolved release carries an asset named for a
  // different program entirely.
  h.release('cove-audio-editor', { name: neighborName });

  await assert.rejects(h.install('cove-audio-editor'), /does not match|identity/i);

  assert.equal(await fsp.readFile(neighborPath, 'utf8'), 'video-editor-binary-untouched');
  assert.equal(h.registered.includes('cove-audio-editor'), false);
  assert.equal(h.registry['cove-video-editor'].path, neighborPath);
});

// Real production shape: the requested slug's OWN registry entry is
// (already, for whatever prior reason) pointing at a file that belongs to
// an unrelated program. Cleanup of the "superseded" binary must refuse to
// delete a file that doesn't structurally belong to the slug being
// installed, even though it is the registered path for that slug.
test('B4: cleanup of a superseded binary must not delete a file belonging to a different program', async (t) => {
  const h = await harness(t);
  const foreignName = 'Cove-Video-Downloader-3.2.0-x86_64.AppImage';
  const foreignPath = path.join(h.root, foreignName);
  await fsp.writeFile(foreignPath, 'video-downloader-binary-untouched');
  // Corrupted/foreign registry entry under the slug we are about to install.
  h.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: foreignPath, source: 'managed' };

  const name = h.release('cove-audio-editor', { name: 'cove-audio-editor-1.1.0-x86_64.AppImage' });
  const result = await h.install('cove-audio-editor');

  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(foreignPath, 'utf8'), 'video-downloader-binary-untouched');
  assert.equal(await fsp.readFile(path.join(h.root, name), 'utf8'), 'binary for cove-audio-editor');
});

// Similar-name pressure: a same-prefix sibling program's asset/file must be
// rejected exactly like an unrelated one. A weaker `startsWith(slug)` guard
// (instead of the anchored matchAsset pattern) would wrongly accept this.
test('B4: a shared-prefix sibling program is not close enough to pass identity checks', async (t) => {
  const h = await harness(t);
  const siblingName = 'cove-audio-editor-pro-2.0.0-x86_64.AppImage';
  const siblingPath = path.join(h.root, siblingName);
  await fsp.writeFile(siblingPath, 'audio-editor-pro-binary-untouched');
  h.registry['cove-audio-editor-pro'] = { tag: 'v2.0.0', path: siblingPath, source: 'managed' };

  h.release('cove-audio-editor', { name: siblingName });
  await assert.rejects(h.install('cove-audio-editor'), /does not match|identity/i);
  assert.equal(await fsp.readFile(siblingPath, 'utf8'), 'audio-editor-pro-binary-untouched');

  // Same shape, but as a corrupted registry entry driving cleanup instead.
  const h2 = await harness(t);
  const siblingPath2 = path.join(h2.root, siblingName);
  await fsp.writeFile(siblingPath2, 'audio-editor-pro-binary-untouched');
  h2.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: siblingPath2, source: 'managed' };
  const name2 = h2.release('cove-audio-editor', { name: 'cove-audio-editor-1.1.0-x86_64.AppImage' });
  const result2 = await h2.install('cove-audio-editor');
  assert.equal(result2.ok, true);
  assert.equal(await fsp.readFile(siblingPath2, 'utf8'), 'audio-editor-pro-binary-untouched');
  assert.equal(await fsp.readFile(path.join(h2.root, name2), 'utf8'), 'binary for cove-audio-editor');
});

// Legitimate same-program updates must still clean up the prior managed
// binary once it's proven to belong to the same slug.
test('B4: legitimate same-slug update still removes its own prior managed binary', async (t) => {
  const h = await harness(t);
  const priorName = 'cove-audio-editor-1.0.0-x86_64.AppImage';
  const priorPath = path.join(h.root, priorName);
  await fsp.writeFile(priorPath, 'old audio editor binary');
  h.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: priorPath, source: 'managed' };

  const name = h.release('cove-audio-editor', { name: 'cove-audio-editor-2.0.0-x86_64.AppImage' });
  const result = await h.install('cove-audio-editor');

  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(h.root, name), 'utf8'), 'binary for cove-audio-editor');
  await assert.rejects(fsp.readFile(priorPath, 'utf8'), /ENOENT/);
});

test('B4: cleanup must not delete the file just installed when the registry path is an unnormalized spelling of the same destination', async (t) => {
  const h = await harness(t);
  const name = h.release('cove-audio-editor', { name: 'cove-audio-editor-2.0.0-x86_64.AppImage' });
  // Simulate a registry entry written before installAssetPath's path.resolve()
  // normalization: same on-disk file as the new install's destination, but a
  // different (unnormalized) string spelling of that path.
  const unnormalizedCurrentPath = `${h.root}/./${name}`;
  h.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: unnormalizedCurrentPath, source: 'managed' };

  const result = await h.install('cove-audio-editor');

  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(h.root, name), 'utf8'), 'binary for cove-audio-editor');
});

test('B4: cleanup must not delete the file just installed when the registry path reaches it through a symlinked parent directory', async (t) => {
  const h = await harness(t);
  const alias = `${h.root}-alias`;
  await fsp.symlink(h.root, alias, 'dir');
  t.after(() => fsp.rm(alias, { force: true }));
  const name = h.release('cove-audio-editor', { name: 'cove-audio-editor-2.0.0-x86_64.AppImage' });
  // Registered path reaches the exact same on-disk file as the new install's
  // destination, but through a symlinked directory - a different string in
  // any normalized form, yet the identical file once resolved on disk.
  h.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: path.join(alias, name), source: 'managed' };

  const result = await h.install('cove-audio-editor');

  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(h.root, name), 'utf8'), 'binary for cove-audio-editor');
});

test('B4: cleanup is skipped, not permitted, when either side\'s real filesystem identity cannot be resolved', async (t) => {
  // Simulates a transient realpathSync failure (e.g. EIO) on the SECOND
  // lookup of a given path. current.path and the fresh install's destination
  // are the same raw string (a legitimate shape: a prior crashed install
  // already registered this exact path), so both lookups target the same
  // key - the first (current.path) succeeds with a deliberately different-
  // looking (but still "resolved") string; the second (finalPath) throws.
  const seen = new Set();
  const filesystem = Object.create(fs);
  filesystem.realpathSync = (p) => {
    const key = String(p);
    if (seen.has(key)) throw new Error('EIO: simulated transient lookup failure');
    seen.add(key);
    return `/canonical-alias${key}`;
  };
  const h = await harness(t, { filesystem });
  const name = h.release('cove-audio-editor', { name: 'cove-audio-editor-2.0.0-x86_64.AppImage' });
  h.registry['cove-audio-editor'] = { tag: 'v1.0.0', path: path.join(h.root, name), source: 'managed' };

  const result = await h.install('cove-audio-editor');

  assert.equal(result.ok, true);
  // Cleanup must not have run: the destination's own identity lookup failed,
  // so identity could not be proven, and the just-installed file must survive.
  assert.equal(await fsp.readFile(path.join(h.root, name), 'utf8'), 'binary for cove-audio-editor');
});
