// electron-builder afterAllArtifactBuild hook.
// Generates a `<artifact>.sha256` sidecar next to every shippable binary in
// the release/ folder (Setup.exe, Portable.exe, AppImage, .deb), in
// `sha256sum`-compatible format ("<hex>  <basename>"). Returns the paths so
// electron-builder uploads them alongside the binaries on publish=always.
//
// Cove Nexus's installer already verifies these when present; the long-term
// goal is to flip verification to mandatory once every cove-* tool ships
// them. See user CLAUDE.md "Releases under ~/Projects/".

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Includes the NSIS .blockmap because it IS in `buildResult.artifactPaths`
// at hook time and is integrity-relevant for delta auto-update.
//
// `latest*.yml` deliberately omitted: electron-builder writes the auto-update
// metadata inside `publishManager.awaitTasks()`, which runs AFTER this hook
// returns (see app-builder-lib/out/index.js and out/publish/PublishManager.js
// `writeUpdateInfoFiles`). Sidecars for those files are produced by
// `build/postReleaseSidecars.js`, chained into `npm run release`.
const SHIP_PATTERNS = [
  /-Setup\.exe$/i,
  /-Portable\.exe$/i,
  /\.AppImage$/i,
  /\.deb$/i,
  /\.blockmap$/i,
];

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  const extras = [];
  const failures = [];
  // Per-artifact try/catch so a single failure doesn't skip later artifacts
  // (the original loop aborted on first reject, leaving the rest unsigned).
  // We collect every failure, then throw once after the loop — the release
  // must fail if any required sidecar is missing, otherwise publish=always
  // would ship under-verified binaries.
  for (const artifact of buildResult.artifactPaths || []) {
    const base = path.basename(artifact);
    if (!SHIP_PATTERNS.some((re) => re.test(base))) continue;
    try {
      const hex = await sha256File(artifact);
      const sidecar = `${artifact}.sha256`;
      fs.writeFileSync(sidecar, `${hex}  ${base}\n`, 'utf8');
      extras.push(sidecar);
      console.log(`  • sha256 sidecar  file=${path.basename(sidecar)}`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`  ✗ sha256 sidecar failed  file=${base}  err=${msg}`);
      failures.push({ file: base, err: msg });
    }
  }
  if (failures.length) {
    const summary = failures.map(f => `${f.file} (${f.err})`).join('; ');
    throw new Error(`afterAllArtifactBuild: ${failures.length} sidecar(s) failed: ${summary}`);
  }
  return extras;
};
