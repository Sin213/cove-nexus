const fsp = require('node:fs/promises');
const path = require('node:path');

// Keep temporary artifacts on the destination filesystem so the final rename
// is atomic. Each transaction owns its files, including legacy checksum names.
async function withInstallWorkspace(root, work) {
  const directory = await fsp.mkdtemp(path.join(root, '.install-'));
  try { return await work(directory); }
  finally { await fsp.rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

function checksumForAsset(text, assetName, bundled = false) {
  if (!bundled) return (text.trim().split(/\s+/)[0] || '').toLowerCase();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  return '';
}

function installAssetPath(root, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
      || path.posix.basename(name) !== name || path.win32.basename(name) !== name
      || /[<>:"|?*]/.test(name)
      || [...name].some(ch => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127)) {
    throw new Error('invalid release asset filename');
  }
  const destination = path.resolve(root, name);
  if (path.dirname(destination) !== path.resolve(root)) throw new Error('release asset escapes the programs directory');
  return destination;
}

module.exports = { withInstallWorkspace, checksumForAsset, installAssetPath };
