const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const pkg = require('../package.json');
const { expectedReleaseAssets, validateReleaseAssets } = require('../build/releaseValidation');

const metadata = ['latest.yml', 'latest-linux.yml'];
function draft(names = expectedReleaseAssets(pkg)) {
  const allNames = names.flatMap(name => [name, `${name}.sha256`]);
  return {
    id: 123, tag_name: `v${pkg.version}`, draft: true,
    upload_url: 'https://uploads.example.invalid/upload{?name,label}',
    assets: allNames.map((name, i) => ({ id: i + 1, name, state: 'uploaded', size: 100 })),
  };
}

test('release gate requires both platforms and their update metadata', () => {
  assert.doesNotThrow(() => validateReleaseAssets(draft(), pkg));
  assert.throws(() => validateReleaseAssets(draft(metadata), pkg), /Incomplete release.*AppImage/);
  const missingWindows = draft();
  missingWindows.assets = missingWindows.assets.filter(a => !a.name.startsWith('latest.yml'));
  assert.throws(() => validateReleaseAssets(missingWindows, pkg), /missing: latest.yml/);
});

test('only metadata checksums may be pending before the finalizer uploads them', () => {
  const release = draft();
  release.assets = release.assets.filter(a => !metadata.some(name => a.name === `${name}.sha256`));
  assert.doesNotThrow(() => validateReleaseAssets(release, pkg, { metadataSidecarsPending: true }));
  assert.throws(() => validateReleaseAssets(release, pkg), /latest.yml.sha256/);
  release.assets = release.assets.filter(a => !a.name.endsWith('.AppImage.sha256'));
  assert.throws(() => validateReleaseAssets(release, pkg, { metadataSidecarsPending: true }), /AppImage.sha256/);
});

test('additional release assets also require checksums', () => {
  const release = draft([...expectedReleaseAssets(pkg), 'setup.exe.blockmap']);
  assert.doesNotThrow(() => validateReleaseAssets(release, pkg));
  release.assets = release.assets.filter(a => a.name !== 'setup.exe.blockmap.sha256');
  assert.throws(() => validateReleaseAssets(release, pkg), /setup.exe.blockmap.sha256/);
});

test('public releases, empty assets, unfinished uploads and duplicate names are rejected', () => {
  assert.throws(() => validateReleaseAssets({ ...draft(), draft: false }, pkg), /public release/);
  assert.throws(() => validateReleaseAssets({ ...draft(), draft: 'false' }, pkg), /public release/);
  assert.throws(() => validateReleaseAssets({ ...draft(), draft: 1 }, pkg), /public release/);
  for (const change of [{ size: 0 }, { state: 'starter' }, { name: 'latest.yml.uploading.1' }]) {
    const release = draft();
    Object.assign(release.assets[0], change);
    assert.throws(() => validateReleaseAssets(release, pkg), /empty|not uploaded|Unfinished/);
  }
  const duplicate = draft();
  duplicate.assets.push({ ...duplicate.assets[0] });
  assert.throws(() => validateReleaseAssets(duplicate, pkg), /duplicate/);
});

test('expected assets reject artifact names shared by two build targets', () => {
  const conflicting = structuredClone(pkg);
  conflicting.build.portable.artifactName = conflicting.build.nsis.artifactName;
  assert.throws(() => expectedReleaseAssets(conflicting), /Conflicting artifactName.*two build targets/);
});

// Exercise the real command with in-process HTTP/FS fakes. These tests never
// open a network socket, read credentials, write artifacts, or publish anything.
async function runFinalizer(release, { onRefresh, mutateScript } = {}) {
  const calls = [];
  let reads = 0;
  const metadataContents = new Map(metadata.map(name => [name, Buffer.from(`version: ${pkg.version}\n`)]));
  const { owner, repo } = pkg.build.publish.find(p => p.provider === 'github');
  const releasePath = `/repos/${owner}/${repo}/releases/${release.id}`;
  const releaseListPath = `/repos/${owner}/${repo}/releases?per_page=100`;
  const assetPath = `/repos/${owner}/${repo}/releases/assets/`;
  const fakeHttp = {
    request(options, callback) {
      const request = new EventEmitter();
      let data = Buffer.alloc(0);
      request.write = value => { data = Buffer.from(value); };
      request.destroy = error => request.emit('error', error);
      request.end = () => queueMicrotask(() => {
        calls.push({ method: options.method, path: options.path, body: data.toString('utf8') });
        let status = 200;
        let body;
        let contentType = 'application/json';
        if (options.method === 'GET' && options.path === releaseListPath) {
          if (++reads === 2) onRefresh?.(release, metadataContents);
          body = [release];
        } else if (options.method === 'GET' && options.path.startsWith(assetPath)) {
          const id = Number(options.path.slice(assetPath.length));
          const asset = release.assets.find(a => a.id === id);
          if (asset && metadataContents.has(asset.name) && options.headers.Accept === 'application/octet-stream') {
            body = metadataContents.get(asset.name);
            contentType = 'application/octet-stream';
          } else {
            status = 404;
            body = {};
          }
        } else if (options.method === 'POST') {
          status = 201;
          const name = new URL(options.path, 'https://mock.invalid').searchParams.get('name');
          body = { id: 100 + release.assets.length, name, size: data.length, state: 'uploaded' };
          release.assets.push(body);
          metadataContents.set(name, Buffer.from(data));
        } else if (options.method === 'PATCH' && options.path === releasePath) {
          let payload;
          try { payload = JSON.parse(data.toString('utf8')); }
          catch { payload = null; }
          if (payload && Object.keys(payload).length === 1 && payload.draft === false) {
            release.draft = false;
            body = release;
          } else {
            status = 422;
            body = { message: 'Invalid publish request' };
          }
        } else {
          status = 404;
          body = {};
        }
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = { 'content-type': contentType };
        callback(response);
        response.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
      return request;
    },
  };
  const fakeFs = {
    readFileSync: () => JSON.stringify(pkg),
    existsSync: () => true,
    readdirSync: () => metadata,
    createReadStream: () => Readable.from([`version: ${pkg.version}\n`]),
    writeFileSync() {},
  };
  let exitCode = 0;
  const exitSentinel = new Error('fake process.exit');
  const diagnostics = [];
  const source = fs.readFileSync(path.join(__dirname, '../build/postReleaseSidecars.js'), 'utf8');
  try {
    await vm.runInNewContext(mutateScript ? mutateScript(source) : source, {
    require(id) {
      if (id === 'node:fs') return fakeFs;
      if (id === 'node:http' || id === 'node:https') return fakeHttp;
      if (id === './releaseValidation') return require('../build/releaseValidation');
      return require(id);
    },
    __dirname: path.join(__dirname, '../build'),
    process: { env: { GH_TOKEN: 'test-token' }, pid: 1, exit(code) { exitCode = code; throw exitSentinel; } },
    console: { log() {}, warn() {}, error(...messages) { diagnostics.push(messages.join(' ')); } },
    URL, Buffer,
    });
  } catch (err) {
    if (err !== exitSentinel) throw err;
  }
  return { calls, exitCode, diagnostics };
}

function pendingDraft() {
  const release = draft();
  release.assets = release.assets.filter(a => !metadata.some(name => a.name === `${name}.sha256`));
  return release;
}

test('finalizer refuses metadata-only draft before uploading or publishing', async () => {
  const release = draft(metadata);
  const result = await runFinalizer(release);
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.deepEqual(result.calls.map(c => c.method), ['GET']);
});

test('finalizer publishes a complete draft after metadata sidecars are uploaded and checked', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release);
  assert.equal(result.exitCode, 0, result.diagnostics.join('\n'));
  assert.equal(release.draft, false);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'POST', 'POST', 'GET', 'GET', 'GET', 'GET', 'GET', 'PATCH']);
});

test('finalizer rejects a publish request that keeps the release as draft', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release, {
    mutateScript(source) {
      const original = 'body: JSON.stringify({ draft: false }),';
      assert.ok(source.includes(original));
      return source.replace(original, 'body: JSON.stringify({ draft: true }),');
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.equal(result.calls.at(-1).method, 'PATCH');
});

test('finalizer refuses to publish if remote metadata changes after hashing', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release, {
    onRefresh(current, contents) {
      current.assets.find(a => a.name === 'latest.yml').id = 999;
      contents.set('latest.yml', Buffer.from('changed metadata\n'));
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.equal(result.calls.some(c => c.method === 'PATCH'), false);
  assert.match(result.diagnostics.join('\n'), /Release metadata checksum mismatch: latest.yml/);
});

test('finalizer refuses to publish if uploaded checksum sidecar changes', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release, {
    onRefresh(current, contents) {
      contents.set('latest.yml.sha256', Buffer.from(`${'0'.repeat(64)}  latest.yml\n`));
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.equal(result.calls.some(c => c.method === 'PATCH'), false);
  assert.match(result.diagnostics.join('\n'), /checksum sidecar was modified/i);
});

test('finalizer leaves draft unpublished if an asset disappears before the final check', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release, {
    onRefresh: current => { current.assets = current.assets.filter(a => !a.name.endsWith('.AppImage')); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.equal(result.calls.some(c => c.method === 'PATCH'), false);
});

test('finalizer leaves draft unpublished if an uploaded metadata sidecar is missing at the final check', async () => {
  const release = pendingDraft();
  const result = await runFinalizer(release, {
    onRefresh: current => { current.assets = current.assets.filter(a => a.name !== 'latest-linux.yml.sha256'); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(release.draft, true);
  assert.deepEqual(result.calls.map(c => c.method), ['GET', 'POST', 'POST', 'GET']);
  assert.equal(result.calls.some(c => c.method === 'PATCH'), false);
});
