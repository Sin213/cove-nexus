// Pure helpers for reconciling the installs.json registry against the
// artifact files actually present in the programs root. Apps can update
// themselves (electron-updater renames the AppImage; the Python fleet
// installs updates under the new versioned filename), so the registry's
// tag/path must be re-derived from disk instead of trusted blindly.
//
// No electron or fs imports - everything here is a pure function of its
// arguments so `node --test test/` can exercise the logic directly.

// electron-builder uses different casings per platform. Case-insensitive
// matching handles: cove-video-editor, Cove-Video-Editor, Cove-GIF-Maker.
function assetPatternsForSlug(slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Version must be well-formed dotted digits (1, 1.2, 1.2.0). A loose
  // `\d[\d.]*` also matched junk like `999..`, which isNewerSemver would parse
  // as [999,0,0] and let it win reconciliation, deleting valid managed files.
  const ver = '\\d+(?:\\.\\d+)*';
  return [
    new RegExp(`^${esc}-(${ver})-Portable(?:_[a-f0-9]+)?\\.exe$`, 'i'),
    new RegExp(`^${esc}-(${ver})-Setup(?:_[a-f0-9]+)?\\.exe$`, 'i'),
    new RegExp(`^${esc}-(${ver})-x86_64(?:_[a-f0-9]+)?\\.AppImage$`, 'i'),
    new RegExp(`^${esc}_(${ver})_amd64(?:_[a-f0-9]+)?\\.deb$`, 'i'),
  ];
}

function matchAsset(slug, filename) {
  for (const re of assetPatternsForSlug(slug)) {
    const m = filename.match(re);
    if (m) return { version: m[1] };
  }
  return null;
}

// Extract a cove-* slug from a release-artifact filename without knowing
// the slug in advance. Used by adoption when walking arbitrary folders.
// Slug segments must start with a letter - otherwise the greedy group
// swallows the version's major digit ("cove-pdf-editor-1") and every
// downstream matchAsset() lookup silently misses.
function detectSlugFromFilename(name) {
  const m = name.match(/^(cove(?:[-_][a-z][a-z0-9]*)*)(?:[-_.])(\d+(?:\.\d+)*)[-_.]/i);
  if (!m) return null;
  return m[1].toLowerCase().replace(/_/g, '-');
}

function isNewerSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Group recognizable artifact filenames by slug.
// names: string[] (basenames inside the programs root)
// joinPath: (name) => absolute path
// -> Map<slug, Array<{ path, name, version }>>
function listArtifactsFromNames(names, joinPath) {
  const bySlug = new Map();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const slug = detectSlugFromFilename(name);
    if (!slug) continue;
    const match = matchAsset(slug, name);
    if (!match) continue; // unparseable cove-* file: never adopt, never delete
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push({ path: joinPath(name), name, version: match.version });
  }
  return bySlug;
}

// Reconcile one slug's registry entry against its on-disk artifacts.
// artifacts: non-empty Array<{ path, name, version }>
// entry: current registry entry for the slug, or undefined
// pathExists: (path) => bool (injected; keeps this pure for tests)
// Returns { entry, deletions, changed }:
//   entry     - the entry the registry should hold (source/pinnedTag/
//               lastKnownLatestTag preserved when repointing)
//   deletions - artifact paths that are safe to delete (older/duplicate
//               copies; only ever non-empty for managed installs)
//   changed   - whether the returned entry differs from the input
function planReconcile(slug, artifacts, entry, pathExists) {
  // Best artifact = highest version; ties broken by preferring the
  // registered path, then stable sorted-name order.
  const sorted = [...artifacts].sort((a, b) => {
    if (isNewerSemver(a.version, b.version)) return -1;
    if (isNewerSemver(b.version, a.version)) return 1;
    return a.name.localeCompare(b.name);
  });
  let best = sorted[0];
  if (entry && entry.path) {
    const registeredArt = sorted.find(a => a.path === entry.path);
    if (registeredArt && !isNewerSemver(best.version, registeredArt.version)) {
      best = registeredArt;
    }
  }

  if (!entry) {
    return {
      entry: { tag: `v${best.version}`, path: best.path, source: 'adopted' },
      deletions: [], // adopted files belong to the user; never delete
      changed: true,
    };
  }

  const entryVer = String(entry.tag || '').replace(/^v/, '');
  const pathAlive = !!entry.path && pathExists(entry.path);
  const repoint = !pathAlive || isNewerSemver(best.version, entryVer);

  const next = repoint
    ? { ...entry, tag: `v${best.version}`, path: best.path }
    : entry;
  const keepPath = repoint ? best.path : entry.path;

  const deletions = (next.source === 'managed')
    ? sorted.filter(a => a.path !== keepPath).map(a => a.path)
    : [];

  return { entry: next, deletions, changed: repoint && (next.tag !== entry.tag || next.path !== entry.path) };
}

module.exports = {
  assetPatternsForSlug,
  matchAsset,
  detectSlugFromFilename,
  isNewerSemver,
  listArtifactsFromNames,
  planReconcile,
};
