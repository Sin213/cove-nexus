// electron-builder afterAllArtifactBuild hook.
// Writes a per-artifact <name>.sha256 sidecar for each shippable binary.
// Returns the sidecar paths so electron-builder uploads them alongside the
// binaries on publish=always.
//
// `latest*.yml` are handled separately by postReleaseSidecars.js — electron-builder
// writes auto-update metadata AFTER this hook returns.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  const failures = [];
  const sidecars = [];
  let outDir = null;

  for (const artifact of buildResult.artifactPaths || []) {
    const base = path.basename(artifact);
    if (!SHIP_PATTERNS.some((re) => re.test(base))) continue;
    if (!outDir) outDir = path.dirname(artifact);
    try {
      const hex = await sha256File(artifact);
      const sidecarPath = path.join(path.dirname(artifact), `${base}.sha256`);
      fs.writeFileSync(sidecarPath, `${hex}  ${base}\n`, 'utf8');
      sidecars.push(sidecarPath);
      console.log(`  • ${base}.sha256`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`  ✗ checksum failed  file=${base}  err=${msg}`);
      failures.push({ file: base, err: msg });
    }
  }

  if (failures.length) {
    const summary = failures.map(f => `${f.file} (${f.err})`).join('; ');
    throw new Error(`afterAllArtifactBuild: ${failures.length} checksum(s) failed: ${summary}`);
  }

  return sidecars;
};
