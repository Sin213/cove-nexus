// The release is usable only when both supported platforms and every checksum
// are present. Keep this gate independent of HTTP so it can be tested locally.
function expectedReleaseAssets(pkg) {
  const resolved = new Set();
  const artifacts = ['appImage', 'deb', 'nsis', 'portable'].map(target => {
    const pattern = pkg.build?.[target]?.artifactName;
    if (typeof pattern !== 'string') throw new Error(`Missing ${target} artifactName`);
    const name = pattern.replaceAll('${version}', pkg.version);
    if (name.includes('${') || /[/\\]/.test(name)) {
      throw new Error(`Unsupported ${target} artifactName: ${pattern}`);
    }
    if (resolved.has(name)) {
      throw new Error(`Conflicting artifactName: two build targets resolve to the same asset name: ${name}`);
    }
    resolved.add(name);
    return name;
  });
  return [...artifacts, 'latest.yml', 'latest-linux.yml'];
}

function validateReleaseAssets(release, pkg, { metadataSidecarsPending = false } = {}) {
  if (release?.draft !== true) throw new Error('Refusing to modify a public release (draft=false).');
  const assets = release.assets || [];
  const names = new Set();
  for (const asset of assets) {
    if (typeof asset.name !== 'string' || names.has(asset.name)) {
      throw new Error(`Invalid or duplicate release asset: ${asset.name}`);
    }
    if (asset.name.includes('.uploading.')) {
      throw new Error(`Unfinished release asset upload: ${asset.name}`);
    }
    if (asset.state !== 'uploaded' || !Number.isFinite(asset.size) || asset.size <= 0) {
      throw new Error(`Release asset is empty or not uploaded: ${asset.name}`);
    }
    names.add(asset.name);
  }
  const required = new Set(expectedReleaseAssets(pkg));
  for (const name of names) {
    if (name.endsWith('.sha256')) {
      required.add(name.slice(0, -'.sha256'.length));
    } else {
      required.add(name);
    }
  }
  for (const name of [...required]) {
    if (!metadataSidecarsPending || !/^latest.*\.yml$/i.test(name)) {
      required.add(`${name}.sha256`);
    }
  }
  const missing = [...required].filter(name => !names.has(name));
  if (missing.length) throw new Error(`Incomplete release; missing: ${missing.join(', ')}`);
}

module.exports = { expectedReleaseAssets, validateReleaseAssets };
