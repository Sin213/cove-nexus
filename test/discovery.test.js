const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isDiscoverableRepoName } = require('../lib/reconcile');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(start, end) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset);
  return source.slice(offset, limit);
}

function assetHelpers(platform) {
  return vm.runInNewContext(`${extract('function assetPreferencesForPlatform(', '// ---------- reconciliation')}\n({ pickAsset })`, { process: { platform } });
}

test('discovery namespace adds only the exact CoveArchive repo name', () => {
  for (const name of ['CoveArchive', 'cove-editor', 'Cove-PDF-Editor']) {
    assert.equal(isDiscoverableRepoName(name), true, name);
  }
  for (const name of ['CoveRecomp', 'CoveFocus', 'Coveworks', 'coveArchive', 'CoveArchive-bot', 'CoveArchiveX', '../CoveArchive', 'CoveArchive/other', '', null, undefined, 1]) {
    assert.equal(isDiscoverableRepoName(name), false, String(name));
  }
});

test('discovery preserves canonical CoveArchive identity and all existing exclusion gates', async () => {
  const handlers = new Map();
  const requested = [];
  const assets = [{ name: 'CoveArchive-1.0.0-x86_64.AppImage' }];
  const repos = [
    { name: 'CoveArchive' }, { name: 'cove-existing' },
    ...['CoveRecomp', 'CoveFocus', 'Coveworks', 'coveArchive', 'CoveArchive-bot', 'CoveArchiveX', 'cove-nexus', 'cove-excluded', 'cove-helper-bot'].map(name => ({ name })),
    { name: 'CoveArchive', archived: true }, { name: 'CoveArchive', disabled: true },
    { name: 'cove-no-release' }, { name: 'cove-no-asset' }, { name: 'cove-release-error' },
    { name: null }, null,
  ];
  const context = {
    isDiscoverableRepoName, ...assetHelpers('linux'),
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    GITHUB_OWNER: 'Sin213', GITHUB_REPO: 'cove-nexus', EXCLUDED_REPOS: new Set(['cove-excluded']),
    httpsGetJson: async () => repos,
    fetchLatestRelease: async slug => {
      requested.push(slug);
      if (slug === 'cove-no-release') return null;
      if (slug === 'cove-release-error') throw new Error('unavailable');
      return { tag_name: 'v1.0.0', assets: slug === 'cove-no-asset' ? [{ name: 'tool.deb' }] : assets };
    },
    rateLimitUntil: 0, formatUpdated: () => '—',
  };
  vm.runInNewContext(`${extract('function prettyName(', 'function formatUpdated(')}\n${extract("ipcMain.handle('cove:discover',", '// Explicit cache-clear')}`, context);
  const result = await handlers.get('cove:discover')(null);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.repos, r => r.slug), ['CoveArchive', 'cove-existing']);
  assert.equal(result.repos[0].name, 'CoveArchive');
  assert.deepEqual(requested, ['CoveArchive', 'cove-existing', 'cove-no-release', 'cove-no-asset', 'cove-release-error']);
});

test('pickAsset prefers CoveArchive Portable.exe and AppImage and ignores deb and sidecars', () => {
  const names = ['CoveArchive-1.0.0-Setup.exe', 'covearchive_1.0.0_amd64.deb', 'CoveArchive-1.0.0-x86_64.AppImage', 'CoveArchive-1.0.0-Portable.exe'];
  const assets = [...names.map(name => ({ name: `${name}.sha256` })), ...names.map(name => ({ name }))];
  assert.equal(assetHelpers('win32').pickAsset(assets).name, names[3]);
  assert.equal(assetHelpers('linux').pickAsset(assets).name, names[2]);
  for (const platform of ['win32', 'linux']) {
    assert.equal(assetHelpers(platform).pickAsset(assets.filter(a => /\.deb(?:\.sha256)?$|\.sha256$/.test(a.name))), null);
  }
});

test('IPC slug validation accepts canonical CoveArchive without allowing traversal', () => {
  const isValidSlug = vm.runInNewContext(`${extract('const SLUG_RE =', '// ---------- IPC: app + config')}\nisValidSlug`);
  assert.equal(isValidSlug('CoveArchive'), true);
  for (const slug of ['../CoveArchive', 'CoveArchive/other', 'CoveArchive\\other', '.', 'CoveArchive\0', '']) {
    assert.equal(isValidSlug(slug), false);
  }
});
