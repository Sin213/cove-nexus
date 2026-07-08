# Handoff: issue #5 - AppImage self-update EPIPE with AppImageLauncher

## Scope
Fix https://github.com/Sin213/cove-nexus/issues/5 only. Single file: `main.js`.

electron-updater's built-in `AppImageUpdater.doInstall()` launches the new
AppImage via `execFileSync`; AppImageLauncher intercepts that exec (binfmt
handler), the child exits early, and Node throws EPIPE. The old
`update-downloaded` handler called `autoUpdater.quitAndInstall(true, true)`
inside a bare `try/catch`, so the failure was silent and the app never updated.

The issue's originally proposed `appimageupdatetool` route is not viable:
electron-builder has no `appImageUpdateTool` config and electron-updater 6.3.9
has no integration with it. The fix instead follows the pattern already shipped
for the same bug in cove-screen-recorder#9 (commit 0d81776 there).

## Change (main.js only)
- New `fsyncPath()` + `installAppImageUpdate(downloadedFile, appImagePath)`:
  atomic in-place file swap. Copy the sha512-verified download into the
  AppImage's directory under a random dot-prefixed staging name with
  `COPYFILE_EXCL` (refuses pre-existing/planted paths), `chmod 0755`, fsync,
  then same-directory atomic `rename()` onto `$APPIMAGE`, then best-effort
  directory fsync and cache cleanup. On any failure the staging file is
  removed and the error rethrown. No child process is spawned, so
  AppImageLauncher has nothing to intercept. The running process keeps the
  old inode; the new version applies on next launch.
- `setupAutoUpdater()` branches on `process.platform === 'linux' &&
  process.env.APPIMAGE`:
  - AppImage: `autoInstallOnAppQuit = false` (keeps the broken `doInstall`
    path from ever running on quit); `update-downloaded` calls
    `installAppImageUpdate()` and logs failures via `console.error` instead
    of swallowing them.
  - Everything else (Windows NSIS): unchanged behavior
    (`autoInstallOnAppQuit = true`, `quitAndInstall(true, true)`), except the
    catch now logs instead of swallowing.
- electron-updater still handles detection and the sha512-verified download
  (from latest-linux.yml); only the install step is replaced.

## Deliberately out of scope
- No renderer/UI changes. Nexus's auto-update is silent by design ("No
  prompt. No toast.") - the issue's step 4 (renderer download progress) is a
  UX addition, not part of the defect, and is deferred.
- No packaging/electron-builder changes.

## Verification
- `node --check main.js` - pass
- `node --test test/reconcile.test.js` - 13/13 pass
- `ESLINT_USE_FLAT_CONFIG=false npx eslint main.js` - 0 errors, 7 warnings;
  identical warning set on the pre-change baseline (verified via stash), so
  no new lint issues.
- Full end-to-end (AppImage updating itself on an AppImageLauncher machine)
  requires a published release to update from; real-world confirmation
  happens on the next release, same as cove-screen-recorder v3.2.1.
