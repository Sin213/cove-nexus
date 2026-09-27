const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { listArtifactsFromNames, planReconcile } = require('../lib/reconcile');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const slug = 'cove-editor';
const filename = `${slug}-1.0.0-x86_64.AppImage`;

function harness({ aliases = {}, platform = 'linux' } = {}) {
  let cfg = { programsRoot: '/programs' };
  let registry = { [slug]: { source: 'adopted', path: `/programs/${filename}`, tag: 'v1.0.0' } };
  const context = vm.createContext({
    readConfig: () => cfg, writeConfig: next => { cfg = next; },
    readRegistry: () => registry, writeRegistry: next => { registry = next; },
    fs: {
      readdirSync: () => [{ name: filename, isFile: () => true }], chmodSync: () => {},
      // Simulates realpath: explicit aliases resolve to their target (like a
      // symlinked directory); anything else normalizes the same way
      // path.resolve() would for an existing plain path.
      realpathSync: p => path.resolve(aliases[p] || p),
    },
    path, process: { platform }, unblockExe: () => {}, exists: () => true,
    listArtifactsFromNames: (names, join) => listArtifactsFromNames(names, join, 'linux'),
    planReconcile: (...args) => planReconcile(...args, 'linux'),
  });
  vm.runInContext(extract('function canonicalRoot(', '// ----------'), context);
  vm.runInContext(extract('function registerInstall(', '// ---------- asset naming'), context);
  vm.runInContext(extract('function reconcilePrograms(', '// ---------- legacy migration'), context);
  return { context, registry: () => registry, folder: root => { cfg = { ...cfg, programsRoot: root }; } };
}

test('forget remains effective across scans without deleting adopted files', () => {
  const { context, registry } = harness();
  context.forgetInstall(slug);
  context.reconcilePrograms();
  context.reconcilePrograms();
  assert.equal(registry()[slug], undefined);
});

test('an explicit file selection re-enables adoption and remains installed', () => {
  const { context, registry } = harness();
  context.forgetInstall(slug);
  context.registerInstall(slug, { source: 'adopted', path: `/programs/${filename}`, tag: 'v1.0.0' });
  context.reconcilePrograms();
  assert.ok(registry()[slug]);
  assert.equal(context.readConfig().ignoredAdoptions.length, 0);
});

test('forget in one programs folder does not suppress adoption in another', () => {
  const { context, registry, folder } = harness();
  context.forgetInstall(slug);
  folder('/other-programs');
  context.reconcilePrograms();
  assert.equal(registry()[slug].path, path.join('/other-programs', filename));
});

test('forget suppression survives an equivalent (unnormalized) spelling of the same programs folder', () => {
  const { context, registry, folder } = harness();
  context.forgetInstall(slug);
  // Same directory as the harness default ('/programs'), spelled differently.
  folder('/programs/');
  context.reconcilePrograms();
  assert.equal(registry()[slug], undefined);
});

test('forget suppression survives a symlinked-directory alias of the same programs folder', () => {
  const { context, registry, folder } = harness({ aliases: { '/programs-alias': '/programs' } });
  context.forgetInstall(slug);
  folder('/programs-alias');
  context.reconcilePrograms();
  assert.equal(registry()[slug], undefined);
});

test('forget suppression survives a case-different spelling of the same programs folder on Windows', () => {
  const { context, registry, folder } = harness({ platform: 'win32' });
  context.forgetInstall(slug);
  folder('/PROGRAMS');
  context.reconcilePrograms();
  assert.equal(registry()[slug], undefined);
});
