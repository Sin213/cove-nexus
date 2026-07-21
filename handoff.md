# Handoff: security/correctness fixes from read-only audit

Scope: fix the audit findings. All code-level findings are addressed; the js-yaml
CVE is fixed via an override. The Electron CVE is the one item NOT auto-applied
(see "Deferred" for the reason).

## Changes

### main.js
1. Stale launch callbacks (runId guard). `exit`, `error`, and the settle-timeout
   handlers now bail when `prev.runId !== runId`, so a superseded launch's late
   callback can no longer mark a newer run failed or destroy its state.
2. Checksum fail-open closed. When a `.sha256` sidecar (or bundle) exists but the
   fetch/hash errors, the install now aborts (removes the temp file, throws)
   instead of `console.warn` + installing an unverified binary.
3. Legacy clone deletion reordered. `cove:install` / `cove:update` now delete the
   `~/.cove-suite` git clone only AFTER `installOrUpdate` succeeds, so a failed
   download no longer leaves the user with neither.
4. Token-erasure guard in `writeConfig`. If encryption is unavailable and no new
   token was supplied, the existing `githubTokenEnc` is preserved instead of
   being wiped when saving an unrelated preference.
5. Atomic writes for `writeConfig` and `writeRegistry` (temp file + rename; mode
   set on temp before rename), so a torn write can't be read back as defaults/{}.
6. `cove:uninstall` no longer calls `forgetInstall` when file deletion fails
   (e.g. locked/running binary); it returns an error and keeps the entry.
7. Redirect handling hardened in `httpsGetJson` and `downloadToFile`: relative
   `Location` values are resolved against the current URL (no ERR_INVALID_URL
   crash), and the GitHub auth token is dropped on any cross-origin redirect
   (`ghHeaders(noAuth)`).
8. Concurrent same-slug install/update lock (`installsInFlight`): a second
   install of the same program while one is in flight now rejects instead of
   racing over the shared `.part` temp path and the registry read/modify/write.
9. `installOrUpdate` now renames the new binary into place BEFORE deleting the
   prior managed file (no window with neither present), and a failed `chmod`
   aborts the install instead of registering an unlaunchable binary as success.
10. `.deb` removed from `assetPreferencesForPlatform`: Nexus runs a managed
    binary directly, but a `.deb` has no runnable target, so it was only ever
    "launchable" by reopening the system package installer. (The self-build
    `.deb` target for installing Nexus itself is unrelated and unchanged.)
    Token-clear correctness: `writeConfig` takes `tokenAuthoritative` so an
    explicit token clear is honored while unrelated writes preserve the stored
    encrypted token (fixes the loop-1 Codex finding).

### renderer/assets/launcher.js
11. `p.latestTag` is now `escapeAttr`-wrapped in the update-button `title`
    (card()), closing the one genuinely unescaped remote-string sink. (The
    foxy-pill use was already escaped via a local `latestTag`.)

### renderer/index.html
12. Content-Security-Policy meta added. `script-src 'self'` + sha256 hashes for
    the three existing inline scripts (no `'unsafe-inline'`, so injected inline
    scripts/handlers are blocked); `style-src` allows inline styles + Google
    Fonts CSS; `font-src` gstatic; `img-src 'self' data:`; everything else
    `'none'`. Verified against the page's actual resource use (inline scripts,
    inline styles, remote fonts, `assets/*.png` images; no fetch/XHR/webview).

### lib/reconcile.js
13. Version capture tightened from `\d[\d.]*` to `\d+(?:\.\d+)*` in
    `assetPatternsForSlug` and `detectSlugFromFilename`, so malformed names like
    `999..` no longer parse as a winning version and delete valid managed files.

### portable.js
14. Portable mode auto-enables when `PORTABLE_EXECUTABLE_DIR` is set (the
    electron-builder portable target always sets it), so a pristine portable exe
    no longer writes into the host user profile on first run.

### package.json / package-lock.json
15. `overrides.js-yaml: ^4.3.0` pins the transitive js-yaml up to the patched
    same-major release, clearing the quadratic-DoS advisory (`npm audit` no
    longer reports js-yaml). API-compatible with the 4.1.x it replaces.

### .github/workflows/release.yml
16. Both build jobs gain a guard that fails the build if the tag does not match
    `package.json` version, preventing assets/finalize from splitting across two
    releases.

## Verification
- `node -c` on main.js, portable.js, lib/reconcile.js, build/postReleaseSidecars.js: all OK.
- `node --test test/reconcile.test.js`: 13 pass / 0 fail.
- CSP: the three inline-script sha256 hashes recomputed and confirmed present in
  the policy.
- `npm install --package-lock-only` + `npm audit`: js-yaml advisory cleared.

## Deferred (with reason)
- Electron CVE (electron <=39.8.4): NOT auto-applied. Current 33.4.11 is EOL with
  no patched release, so the fix is a 6+ major jump to a supported line
  (39.8.10+ / 43.x) that removes/changes APIs this app uses (e.g. BrowserView).
  It cannot be verified in this headless environment and needs a supervised
  upgrade with real GUI regression testing on Windows + Linux.
- `brace-expansion` advisory: dev/build-tooling only (electron-builder + eslint),
  ships in no runtime artifact, and was not among the audit findings in scope.
