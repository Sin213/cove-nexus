#!/usr/bin/env node
// Runs after both platform build jobs complete (in the finalize CI job).
// Downloads the partial checksums-sha256.txt from the draft release (written
// by afterAllArtifactBuild with binary hashes), appends checksums for the
// latest*.yml auto-update metadata files, re-uploads the combined bundle,
// and publishes the draft.
//
// Why a separate step: electron-builder writes latest*.yml AFTER the
// afterAllArtifactBuild hook returns, so those files don't exist at hook
// time. In CI, each platform builds in its own job; the finalize job runs
// after both complete and has the latest*.yml files available from the draft.
//
// Safety model:
//   * electron-publish defaults releaseType to 'draft' for the GitHub
//     provider, so end users never see the release until we publish it.
//   * We assert release.draft === true before touching anything.
//   * Atomic asset replacement: upload temp name, delete old, rename.
//   * Publish-the-draft is the last step. Any upstream failure leaves the
//     release as a draft.
//
// Env overrides:
//   COVE_RELEASE_DIR        directory containing latest*.yml (default release/)
//   COVE_SIDECAR_DRY_RUN=1  local-only mode, no API calls
//   COVE_KEEP_DRAFT=1       upload but don't publish
//   COVE_GH_API_BASE        override https://api.github.com (test mock)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'release');
const YML_PATTERNS = [/^latest.*\.yml$/i];
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const API_BASE = (process.env.COVE_GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

{
  const u = new URL(API_BASE);
  const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  if (u.protocol === 'http:' && !isLoopback) {
    console.error(`[post-release] COVE_GH_API_BASE must use https unless host is loopback: ${API_BASE}`);
    process.exit(1);
  }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function ghPublishConfig() {
  const cfg = (PKG.build?.publish || []).find(p => p?.provider === 'github') || {};
  return { owner: cfg.owner, repo: cfg.repo };
}

function authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'User-Agent': `cove-nexus-postrelease/${PKG.version}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function httpRequest({ method, url, headers = {}, body, expectedStatuses }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers,
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next;
          try { next = new URL(res.headers.location, url); }
          catch (e) { return reject(new Error(`bad redirect Location: ${res.headers.location}`)); }
          if (u.protocol === 'https:' && next.protocol === 'http:') {
            return reject(new Error(`refusing https->http redirect: ${next.href}`));
          }
          const sameOrigin = next.protocol === u.protocol && next.host === u.host;
          const nextHeaders = sameOrigin
            ? headers
            : Object.fromEntries(
                Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization')
              );
          return httpRequest({ method, url: next.href, headers: nextHeaders, body, expectedStatuses })
            .then(resolve, reject);
        }
        const buf = Buffer.concat(chunks);
        if (!expectedStatuses.includes(res.statusCode)) {
          return reject(new Error(`${method} ${u.pathname} -> ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        }
        const ct = res.headers['content-type'] || '';
        if (buf.length && /json/i.test(ct)) {
          try { return resolve(JSON.parse(buf.toString('utf8'))); }
          catch (e) { return reject(e); }
        }
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function findReleaseByTag({ owner, repo, tag, token }) {
  const releases = await httpRequest({
    method: 'GET',
    url: `${API_BASE}/repos/${owner}/${repo}/releases?per_page=100`,
    headers: authHeaders(token),
    expectedStatuses: [200],
  });
  const match = (Array.isArray(releases) ? releases : []).find(r => r?.tag_name === tag);
  if (!match) {
    const seen = (Array.isArray(releases) ? releases : []).map(r => r?.tag_name).filter(Boolean).slice(0, 8).join(', ');
    throw new Error(`no release found with tag_name=${tag} (saw: ${seen || 'none'})`);
  }
  return match;
}

async function downloadReleaseAsset({ owner, repo, assetId, token }) {
  return httpRequest({
    method: 'GET',
    url: `${API_BASE}/repos/${owner}/${repo}/releases/assets/${assetId}`,
    headers: {
      ...authHeaders(token),
      'Accept': 'application/octet-stream',
    },
    expectedStatuses: [200],
  });
}

async function deleteReleaseAsset({ owner, repo, assetId, token }) {
  return httpRequest({
    method: 'DELETE',
    url: `${API_BASE}/repos/${owner}/${repo}/releases/assets/${assetId}`,
    headers: authHeaders(token),
    expectedStatuses: [204],
  });
}

async function renameReleaseAsset({ owner, repo, assetId, newName, token }) {
  return httpRequest({
    method: 'PATCH',
    url: `${API_BASE}/repos/${owner}/${repo}/releases/assets/${assetId}`,
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
    expectedStatuses: [200],
  });
}

async function publishRelease({ owner, repo, releaseId, token }) {
  return httpRequest({
    method: 'PATCH',
    url: `${API_BASE}/repos/${owner}/${repo}/releases/${releaseId}`,
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false }),
    expectedStatuses: [200],
  });
}

async function uploadReleaseAsset({ uploadUrl, name, data, token }) {
  const baseUrl = uploadUrl.replace(/\{[^}]+\}$/, '');
  const url = `${baseUrl}?name=${encodeURIComponent(name)}`;
  return httpRequest({
    method: 'POST',
    url,
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
    },
    body: data,
    expectedStatuses: [201],
  });
}

async function replaceAsset({ release, owner, repo, token, assetName, data }) {
  const existing = (release.assets || []).find(a => a.name === assetName);
  if (!existing) {
    return uploadReleaseAsset({ uploadUrl: release.upload_url, name: assetName, data, token });
  }
  const tempName = `${assetName}.uploading.${process.pid}.${Date.now()}`;
  let temp;
  try {
    temp = await uploadReleaseAsset({ uploadUrl: release.upload_url, name: tempName, data, token });
  } catch (err) {
    throw new Error(`upload failed for ${assetName}: ${err.message} (existing asset preserved)`);
  }
  try {
    await deleteReleaseAsset({ owner, repo, assetId: existing.id, token });
  } catch (err) {
    throw new Error(
      `couldn't delete prior asset ${assetName}: ${err.message}; ` +
      `new content uploaded as ${tempName} - rename it manually or re-run.`
    );
  }
  try {
    await renameReleaseAsset({ owner, repo, assetId: temp.id, newName: assetName, token });
  } catch (err) {
    throw new Error(
      `couldn't rename ${tempName} -> ${assetName}: ${err.message}; ` +
      `new content is on the draft under ${tempName}.`
    );
  }
  return temp;
}

(async () => {
  const dir = process.env.COVE_RELEASE_DIR || RELEASE_DIR;
  const dryRun = process.env.COVE_SIDECAR_DRY_RUN === '1';
  const keepDraft = process.env.COVE_KEEP_DRAFT === '1';

  // Find latest*.yml files to hash.
  let ymlFiles = [];
  if (fs.existsSync(dir)) {
    ymlFiles = fs.readdirSync(dir).filter(n => YML_PATTERNS.some(re => re.test(n)));
  } else {
    console.warn(`[post-release] release dir not found: ${dir}`);
  }

  if (ymlFiles.length === 0) {
    if (dryRun) {
      console.log('[post-release] dry-run: no latest*.yml present, exiting 0.');
      return;
    }
    console.error(
      `[post-release] expected at least one latest*.yml in ${dir}, found 0. ` +
      'Set COVE_SIDECAR_DRY_RUN=1 if running outside a real release.'
    );
    process.exit(1);
  }

  // Hash local latest*.yml files.
  const ymlLines = [];
  for (const name of ymlFiles) {
    const hex = await sha256File(path.join(dir, name));
    ymlLines.push(`${hex}  ${name}`);
    console.log(`  • checksum  ${name}`);
  }

  if (dryRun) {
    console.log('[post-release] dry-run: would append to checksums-sha256.txt:');
    ymlLines.forEach(l => console.log(`    ${l}`));
    return;
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[post-release] GH_TOKEN/GITHUB_TOKEN not set.');
    process.exit(1);
  }
  const { owner, repo } = ghPublishConfig();
  if (!owner || !repo) {
    console.error('[post-release] GitHub publish config missing owner/repo in package.json build.publish.');
    process.exit(1);
  }
  const tag = `v${PKG.version}`;
  console.log(`[post-release] finalizing checksums-sha256.txt for ${owner}/${repo}@${tag}...`);

  let release;
  try {
    release = await findReleaseByTag({ owner, repo, tag, token });
  } catch (err) {
    console.error(`[post-release] couldn't fetch release ${tag}: ${err.message}`);
    process.exit(1);
  }

  if (!release.draft) {
    console.error(
      `[post-release] release ${tag} is already published (draft=false). ` +
      'Refusing to modify a public release.'
    );
    process.exit(1);
  }

  // Download the existing checksums-sha256.txt (uploaded by afterAllArtifactBuild
  // via each platform build job). Both jobs write their own file; the second
  // upload replaces the first. We download whatever is there and check for
  // missing binaries - if one platform's checksums were overwritten, we
  // re-download those assets and regenerate their hashes.
  const checksumAsset = (release.assets || []).find(a => a.name === 'checksums-sha256.txt');
  let existingLines = [];
  if (checksumAsset) {
    try {
      const buf = await downloadReleaseAsset({ owner, repo, assetId: checksumAsset.id, token });
      existingLines = buf.toString('utf8').trim().split('\n').filter(Boolean);
      console.log(`  • downloaded existing checksums-sha256.txt (${existingLines.length} entries)`);
    } catch (err) {
      console.warn(`  ! couldn't download existing checksums-sha256.txt: ${err.message}`);
      console.warn('    will regenerate from release assets');
    }
  }

  // Check for binary assets missing from the partial checksum file.
  const BINARY_PATTERNS = [/-Setup\.exe$/i, /-Portable\.exe$/i, /\.AppImage$/i, /\.deb$/i, /\.blockmap$/i];
  const binaryAssets = (release.assets || []).filter(a =>
    BINARY_PATTERNS.some(re => re.test(a.name))
  );
  const existingNames = new Set(existingLines.map(l => l.split(/\s+/).pop()));
  const missingBinaries = binaryAssets.filter(a => !existingNames.has(a.name));

  if (missingBinaries.length > 0) {
    console.log(`  • ${missingBinaries.length} binary asset(s) missing from partial checksums, downloading...`);
    for (const asset of missingBinaries) {
      try {
        const buf = await downloadReleaseAsset({ owner, repo, assetId: asset.id, token });
        const hex = crypto.createHash('sha256').update(buf).digest('hex');
        existingLines.push(`${hex}  ${asset.name}`);
        console.log(`  • checksum  ${asset.name} (downloaded)`);
      } catch (err) {
        console.error(`  ✗ couldn't download ${asset.name}: ${err.message}`);
        console.error('[post-release] aborting. Release left as draft.');
        process.exit(1);
      }
    }
  }

  // Combine binary + yml checksums into the final bundle.
  const allLines = [...existingLines, ...ymlLines];
  const combined = allLines.join('\n') + '\n';
  console.log(`  • final checksums-sha256.txt: ${allLines.length} entries`);

  try {
    await replaceAsset({
      release, owner, repo, token,
      assetName: 'checksums-sha256.txt',
      data: Buffer.from(combined, 'utf8'),
    });
    console.log('  ↑ uploaded checksums-sha256.txt');
  } catch (err) {
    console.error(`  ✗ checksums-sha256.txt: ${err.message}`);
    console.error('[post-release] aborting. Release left as draft.');
    process.exit(1);
  }

  if (keepDraft) {
    console.log(`[post-release] checksums finalized. COVE_KEEP_DRAFT=1 - leaving ${tag} as draft.`);
    return;
  }

  // Verify latest*.yml files are present on the draft before publishing.
  // If missing, upload them from the local release directory.
  const refreshedRelease = await findReleaseByTag({ owner, repo, tag, token });
  const draftYmlAssets = (refreshedRelease.assets || []).filter(a =>
    YML_PATTERNS.some(re => re.test(a.name))
  );
  const draftYmlNames = new Set(draftYmlAssets.map(a => a.name));
  const missingYmls = ymlFiles.filter(n => !draftYmlNames.has(n));
  if (missingYmls.length > 0) {
    console.log(`  ! ${missingYmls.length} latest*.yml file(s) missing from draft, uploading...`);
    for (const name of missingYmls) {
      const data = fs.readFileSync(path.join(dir, name));
      try {
        await replaceAsset({ release: refreshedRelease, owner, repo, token, assetName: name, data });
        console.log(`  + uploaded ${name}`);
      } catch (err) {
        console.error(`  x failed to upload ${name}: ${err.message}`);
        console.error('[post-release] aborting. Release left as draft.');
        process.exit(1);
      }
    }
  }

  // Final gate: re-check that yml files are on the release.
  const finalRelease = missingYmls.length > 0
    ? await findReleaseByTag({ owner, repo, tag, token })
    : refreshedRelease;
  const finalYmlCount = (finalRelease.assets || []).filter(a =>
    YML_PATTERNS.some(re => re.test(a.name))
  ).length;
  if (finalYmlCount === 0) {
    console.error('[post-release] no latest*.yml on draft after upload attempt. Refusing to publish.');
    process.exit(1);
  }

  try {
    await publishRelease({ owner, repo, releaseId: release.id, token });
    console.log(`[post-release] published ${tag}.`);
  } catch (err) {
    console.error(`[post-release] couldn't publish ${tag}: ${err.message}`);
    console.error('  checksums uploaded - publish the draft manually from the GitHub UI.');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[post-release]', err?.message || err);
  process.exit(1);
});
