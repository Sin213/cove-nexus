// electron-builder afterAllArtifactBuild hook.
// Writes a single `checksums-sha256.txt` in the release/ folder with one
// sha256sum-compatible line per shippable artifact. Returns the path so
// electron-builder uploads it alongside the binaries on publish=always.
//
// `latest*.yml` are deliberately omitted here: electron-builder writes
// auto-update metadata AFTER this hook returns. postReleaseSidecars.js
// appends their hashes to the bundled file before publishing the draft.

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
  const lines = [];
  const failures = [];
  let outDir = null;

  for (const artifact of buildResult.artifactPaths || []) {
    const base = path.basename(artifact);
    if (!SHIP_PATTERNS.some((re) => re.test(base))) continue;
    if (!outDir) outDir = path.dirname(artifact);
    try {
      const hex = await sha256File(artifact);
      lines.push(`${hex}  ${base}`);
      console.log(`  • checksum  ${base}`);
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

  if (!lines.length || !outDir) return [];

  const bundle = path.join(outDir, 'checksums-sha256.txt');
  fs.writeFileSync(bundle, lines.join('\n') + '\n', 'utf8');
  console.log(`  • checksums-sha256.txt  (${lines.length} entries)`);

  const sidecars = [];
  for (const line of lines) {
    const [hex, base] = line.split(/\s{2}/);
    const sidecarPath = path.join(outDir, `${base}.sha256`);
    fs.writeFileSync(sidecarPath, `${hex}  ${base}\n`, 'utf8');
    sidecars.push(sidecarPath);
    console.log(`  • ${base}.sha256`);
  }

  return [bundle, ...sidecars];
};
