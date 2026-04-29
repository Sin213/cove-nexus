#!/usr/bin/env node
// Runs after `electron-builder` finishes. Generates `<file>.sha256` sidecars
// for the auto-update metadata files (latest.yml, latest-linux.yml, etc.)
// that electron-builder writes inside its publish phase, AFTER the
// `afterAllArtifactBuild` hook has returned. Then uploads each sidecar to
// the GitHub release and flips the draft flag off so the release only
// becomes public once every sidecar is in place.
//
// Why a separate step: app-builder-lib/out/index.js calls
// `afterAllArtifactBuild` first, then `publishManager.awaitTasks()` invokes
// `writeUpdateInfoFiles` — the yml files don't exist yet when the hook runs.
//
// Safety model:
//   * electron-publish defaults `releaseType: 'draft'` for the GitHub
//     provider (see node_modules/electron-publish/out/gitHubPublisher.js
//     line 55), so end users do NOT see the release until we publish it.
//   * We assert `release.draft === true` before touching anything; if a
//     prior process already promoted the release we refuse to do destructive
//     replacements on it.
//   * Per-asset replacement is atomic: upload-to-temp-name → delete old →
//     rename temp to target. If any step fails, the previously-uploaded
//     content is still present at SOME name on the draft (worst case, the
//     `.uploading` temp). No state where data is lost.
//   * Publish-the-draft is the last thing we do, AFTER every sidecar is in
//     place. A failure anywhere upstream leaves the release as a draft and
//     the operator can re-run.
//
// Env overrides:
//   COVE_RELEASE_DIR        directory to scan for latest*.yml (default release/)
//   COVE_SIDECAR_DRY_RUN=1  generate sidecars locally only, no API calls,
//                           tolerate empty match set (used by tests)
//   COVE_KEEP_DRAFT=1       upload sidecars but do NOT publish the draft
//                           afterwards (operator inspects, publishes by hand)
//   COVE_GH_API_BASE        override https://api.github.com (test mock)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'release');
const PATTERNS = [/^latest.*\.yml$/i];
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const API_BASE = (process.env.COVE_GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

// Refuse to ever send the GitHub token over plaintext. The COVE_GH_API_BASE
// override is only for tests, which bind a mock server on loopback — that's
// the one place http is acceptable. Anything else (e.g., a fat-fingered http
// production override, or a corporate proxy on a routable IP) is a credential
// leak waiting to happen.
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

// Minimal JSON/binary HTTPS client. Follows redirects (asset uploads commonly
// 302 to a temporary S3 host). Two safety rules on redirect:
//   1. Strip the Authorization header on cross-origin redirects so the
//      GitHub token can't leak to the redirect target. Same-origin redirects
//      (api → api, uploads → uploads) keep auth.
//   2. Refuse https → http downgrades.
// http is supported only for the test mock on loopback (gated above where
// API_BASE is parsed).
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
            return reject(new Error(`refusing https→http redirect: ${next.href}`));
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
          return reject(new Error(`${method} ${u.pathname} → ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
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

// Find the release by tag_name via the full list endpoint. We can't use
// `/releases/tags/{tag}` here: that endpoint resolves by *git* tag, but
// electron-publish creates the GitHub release as a draft BEFORE the git tag
// exists, so the by-tag endpoint returns 404 for the very release we just
// created. electron-publish itself avoids this endpoint for the same reason
// (see node_modules/electron-publish/out/gitHubPublisher.js
// `getOrCreateRelease`, with the comment "we don't use 'Get a release by tag
// name'"). Listing returns drafts inline for users with write access; the
// just-created draft is the most recent entry.
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

async function uploadReleaseAsset({ uploadUrl, name, filePath, token }) {
  const data = fs.readFileSync(filePath);
  // upload_url has a URI template suffix like "{?name,label}" — strip it.
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

// Atomic-replace pattern. If no existing same-named asset, upload directly.
// Otherwise: upload to a temp name, delete old, rename temp → target. Worst-
// case after a partial failure, the new content is still present under the
// temp name and the operator can rename via the GitHub UI.
async function placeSidecar({ release, owner, repo, token, assetName, filePath }) {
  const existing = (release.assets || []).find(a => a.name === assetName);
  if (!existing) {
    const asset = await uploadReleaseAsset({ uploadUrl: release.upload_url, name: assetName, filePath, token });
    return { mode: 'fresh', asset };
  }
  const tempName = `${assetName}.uploading.${process.pid}.${Date.now()}`;
  let temp;
  try {
    temp = await uploadReleaseAsset({ uploadUrl: release.upload_url, name: tempName, filePath, token });
  } catch (err) {
    throw new Error(`upload failed for ${assetName}: ${err.message} (existing asset preserved)`);
  }
  try {
    await deleteReleaseAsset({ owner, repo, assetId: existing.id, token });
  } catch (err) {
    throw new Error(
      `couldn't delete prior asset ${assetName}: ${err.message}; ` +
      `new content uploaded as ${tempName} — rename it manually or re-run.`
    );
  }
  try {
    await renameReleaseAsset({ owner, repo, assetId: temp.id, newName: assetName, token });
  } catch (err) {
    throw new Error(
      `couldn't rename ${tempName} → ${assetName}: ${err.message}; ` +
      `new content is on the draft under ${tempName}.`
    );
  }
  return { mode: 'replaced', asset: temp };
}

(async () => {
  const dir = process.env.COVE_RELEASE_DIR || RELEASE_DIR;
  const dryRun = process.env.COVE_SIDECAR_DRY_RUN === '1';
  const keepDraft = process.env.COVE_KEEP_DRAFT === '1';

  let matched = [];
  if (fs.existsSync(dir)) {
    matched = fs.readdirSync(dir).filter(n => PATTERNS.some(re => re.test(n)));
  } else {
    console.warn(`[post-release] release dir not found: ${dir}`);
  }

  if (matched.length === 0) {
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

  // Phase 1: hash + write sidecars locally.
  const generated = [];
  const failures = [];
  for (const name of matched) {
    const src = path.join(dir, name);
    const sidecar = `${src}.sha256`;
    try {
      const hex = await sha256File(src);
      fs.writeFileSync(sidecar, `${hex}  ${name}\n`, 'utf8');
      generated.push({ src, sidecar, assetName: path.basename(sidecar) });
      console.log(`  • sha256 sidecar  file=${path.basename(sidecar)}`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`  ✗ sha256 sidecar failed  file=${name}  err=${msg}`);
      failures.push({ file: name, err: msg });
    }
  }
  if (failures.length) {
    const summary = failures.map(f => `${f.file} (${f.err})`).join('; ');
    console.error(`[post-release] ${failures.length} sidecar(s) failed: ${summary}`);
    process.exit(1);
  }

  // Phase 2: upload (skipped in dry-run).
  if (dryRun) {
    console.log('[post-release] dry-run: upload skipped.');
    return;
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[post-release] GH_TOKEN/GITHUB_TOKEN not set — cannot upload sidecars.');
    process.exit(1);
  }
  const { owner, repo } = ghPublishConfig();
  if (!owner || !repo) {
    console.error('[post-release] GitHub publish config missing owner/repo in package.json build.publish.');
    process.exit(1);
  }
  const tag = `v${PKG.version}`;
  console.log(`[post-release] uploading ${generated.length} sidecar(s) to ${owner}/${repo}@${tag}…`);

  let release;
  try {
    release = await findReleaseByTag({ owner, repo, tag, token });
  } catch (err) {
    console.error(`[post-release] couldn't fetch release ${tag}: ${err.message}`);
    process.exit(1);
  }

  // Refuse to do destructive replacement on a release that's already public.
  // (The default electron-publish flow leaves it draft; if we land here on a
  // non-draft, something has manually published it, and a re-run is unsafe.)
  if (!release.draft) {
    console.error(
      `[post-release] release ${tag} is already published (draft=false). ` +
      'Refusing to replace assets on a public release. ' +
      'Inspect the release and remove/upload sidecars manually if needed.'
    );
    process.exit(1);
  }

  for (const g of generated) {
    try {
      const r = await placeSidecar({ release, owner, repo, token, assetName: g.assetName, filePath: g.sidecar });
      console.log(`  ↑ ${r.mode === 'replaced' ? 'replaced' : 'uploaded'}  ${g.assetName}`);
    } catch (err) {
      console.error(`  ✗ ${g.assetName}: ${err.message}`);
      console.error('[post-release] aborting. Release left as draft so it does not go public without sidecars.');
      process.exit(1);
    }
  }

  // Phase 3: flip the draft flag. Until this succeeds, end users can't see
  // the release at all.
  if (keepDraft) {
    console.log(`[post-release] sidecars uploaded. COVE_KEEP_DRAFT=1 — leaving ${tag} as draft for manual review.`);
    return;
  }
  try {
    await publishRelease({ owner, repo, releaseId: release.id, token });
    console.log(`[post-release] published ${tag}.`);
  } catch (err) {
    console.error(`[post-release] couldn't publish ${tag}: ${err.message}`);
    console.error('  sidecars uploaded successfully — publish the draft manually from the GitHub UI.');
    process.exit(1);
  }
})().catch((err) => {
  console.error('[post-release]', err?.message || err);
  process.exit(1);
});
