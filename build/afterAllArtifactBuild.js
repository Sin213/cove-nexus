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

const SHIP_PATTERNS = [
  /-Setup\.exe$/i,
  /-Portable\.exe$/i,
  /\.AppImage$/i,
  /\.deb$/i,
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
  for (const artifact of buildResult.artifactPaths || []) {
    const base = path.basename(artifact);
    if (!SHIP_PATTERNS.some((re) => re.test(base))) continue;
    const hex = await sha256File(artifact);
    const sidecar = `${artifact}.sha256`;
    fs.writeFileSync(sidecar, `${hex}  ${base}\n`, 'utf8');
    extras.push(sidecar);
    console.log(`  • sha256 sidecar  file=${path.basename(sidecar)}`);
  }
  return extras;
};
