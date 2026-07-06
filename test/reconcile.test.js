const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchAsset,
  detectSlugFromFilename,
  isNewerSemver,
  listArtifactsFromNames,
  planReconcile,
} = require('../lib/reconcile');

const SLUG = 'cove-pdf-editor';
const art = (version, name) => ({
  path: `/programs/${name}`,
  name,
  version,
});
const appimage = (v) => art(v, `${SLUG}-${v}-x86_64.AppImage`);
const existsIn = (...paths) => (p) => paths.includes(p);

test('listArtifactsFromNames groups by slug and skips unparseable names', () => {
  const names = [
    'cove-pdf-editor-1.2.0-x86_64.AppImage',
    'cove-pdf-editor-1.3.0-x86_64.AppImage',
    'Cove-Image-Upscaler-2.1.3-Setup.exe',
    'cove-pdf-editor-notes.txt',
    '.hidden-cove-pdf-editor-1.0.0-x86_64.AppImage',
    'random.AppImage',
  ];
  const map = listArtifactsFromNames(names, (n) => `/programs/${n}`);
  assert.equal(map.get('cove-pdf-editor').length, 2);
  assert.equal(map.get('cove-image-upscaler').length, 1);
  assert.equal(map.size, 2);
});

test('no registry entry: adopts best version, deletes nothing', () => {
  const artifacts = [appimage('1.2.0'), appimage('1.3.0')];
  const plan = planReconcile(SLUG, artifacts, undefined, existsIn());
  assert.equal(plan.entry.tag, 'v1.3.0');
  assert.equal(plan.entry.source, 'adopted');
  assert.deepEqual(plan.deletions, []);
  assert.equal(plan.changed, true);
});

test('registered path gone, newer file exists: repoints, preserves source and pin', () => {
  const oldArt = appimage('1.2.0');
  const newArt = appimage('1.3.0');
  const entry = { tag: 'v1.2.0', path: oldArt.path, source: 'managed', pinnedTag: 'v1.2.0', lastKnownLatestTag: 'v1.3.0' };
  // electron-updater shape: old file deleted, only the new one on disk
  const plan = planReconcile(SLUG, [newArt], entry, existsIn(newArt.path));
  assert.equal(plan.entry.tag, 'v1.3.0');
  assert.equal(plan.entry.path, newArt.path);
  assert.equal(plan.entry.source, 'managed');
  assert.equal(plan.entry.pinnedTag, 'v1.2.0');
  assert.equal(plan.entry.lastKnownLatestTag, 'v1.3.0');
  assert.equal(plan.changed, true);
});

test('registered path exists + newer file exists: repoints, deletes older when managed', () => {
  const oldArt = appimage('1.2.0');
  const newArt = appimage('1.3.0');
  const entry = { tag: 'v1.2.0', path: oldArt.path, source: 'managed' };
  const plan = planReconcile(SLUG, [oldArt, newArt], entry, existsIn(oldArt.path, newArt.path));
  assert.equal(plan.entry.tag, 'v1.3.0');
  assert.equal(plan.entry.path, newArt.path);
  assert.deepEqual(plan.deletions, [oldArt.path]);
});

test('two files newer than registry: picks max version, deletes loser when managed', () => {
  const a = appimage('1.3.0');
  const b = appimage('1.4.0');
  const entry = { tag: 'v1.2.0', path: '/programs/gone.AppImage', source: 'managed' };
  const plan = planReconcile(SLUG, [a, b], entry, existsIn(a.path, b.path));
  assert.equal(plan.entry.tag, 'v1.4.0');
  assert.deepEqual(plan.deletions, [a.path]);
});

test('same-version duplicate: keeps registered path, deletes dup when managed', () => {
  const registered = appimage('1.3.0');
  const dup = art('1.3.0', `${SLUG}-1.3.0-x86_64_ab12cd34.AppImage`);
  const entry = { tag: 'v1.3.0', path: registered.path, source: 'managed' };
  const plan = planReconcile(SLUG, [dup, registered], entry, existsIn(registered.path, dup.path));
  assert.equal(plan.entry.path, registered.path);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.deletions, [dup.path]);
});

test('self-update past a pin: pin untouched, tag follows disk', () => {
  const newArt = appimage('1.5.0');
  const entry = { tag: 'v1.2.0', path: '/programs/gone.AppImage', source: 'managed', pinnedTag: 'v1.2.0' };
  const plan = planReconcile(SLUG, [newArt], entry, existsIn(newArt.path));
  assert.equal(plan.entry.tag, 'v1.5.0');
  assert.equal(plan.entry.pinnedTag, 'v1.2.0');
});

test('adopted source: repoints but never deletes files', () => {
  const oldArt = appimage('1.2.0');
  const newArt = appimage('1.3.0');
  const entry = { tag: 'v1.2.0', path: oldArt.path, source: 'adopted' };
  const plan = planReconcile(SLUG, [oldArt, newArt], entry, existsIn(oldArt.path, newArt.path));
  assert.equal(plan.entry.tag, 'v1.3.0');
  assert.equal(plan.entry.source, 'adopted');
  assert.deepEqual(plan.deletions, []);
});

test('up-to-date managed entry: no change, no deletions', () => {
  const cur = appimage('1.3.0');
  const entry = { tag: 'v1.3.0', path: cur.path, source: 'managed' };
  const plan = planReconcile(SLUG, [cur], entry, existsIn(cur.path));
  assert.equal(plan.changed, false);
  assert.equal(plan.entry, entry);
  assert.deepEqual(plan.deletions, []);
});

test('disk older than registry, registered path alive: keeps entry, sweeps older managed copy', () => {
  const older = appimage('1.1.0');
  const cur = appimage('1.3.0');
  const entry = { tag: 'v1.3.0', path: cur.path, source: 'managed' };
  const plan = planReconcile(SLUG, [older, cur], entry, existsIn(older.path, cur.path));
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.deletions, [older.path]);
});

test('matchAsset accepts fleet artifact shapes, rejects sidecars', () => {
  assert.ok(matchAsset(SLUG, 'cove-pdf-editor-1.2.0-x86_64.AppImage'));
  assert.ok(matchAsset(SLUG, 'cove-pdf-editor-1.2.0-Portable.exe'));
  assert.ok(matchAsset(SLUG, 'cove-pdf-editor-1.2.0-Setup.exe'));
  assert.ok(matchAsset(SLUG, 'cove-pdf-editor_1.2.0_amd64.deb'));
  assert.equal(matchAsset(SLUG, 'cove-pdf-editor-1.2.0-x86_64.AppImage.sha256'), null);
});

test('detectSlugFromFilename normalizes case and underscores', () => {
  assert.equal(detectSlugFromFilename('Cove-PDF-Editor-1.2.0-Setup.exe'), 'cove-pdf-editor');
  assert.equal(detectSlugFromFilename('cove_pdf_editor_1.2.0_amd64.deb'), 'cove-pdf-editor');
  assert.equal(detectSlugFromFilename('notes.txt'), null);
});

test('isNewerSemver basic ordering', () => {
  assert.equal(isNewerSemver('1.3.0', '1.2.9'), true);
  assert.equal(isNewerSemver('1.2.0', '1.2.0'), false);
  assert.equal(isNewerSemver('1.2', '1.2.1'), false);
  assert.equal(isNewerSemver('2.0.0', '1.9.9'), true);
});
