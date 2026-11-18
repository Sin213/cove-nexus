# Cove Nexus

**Install, launch, and update every Cove tool from a single window.**

https://github.com/user-attachments/assets/56f60194-8609-4ceb-8b84-86e650f57024

Cove Nexus is a desktop launcher for the [Sin213](https://github.com/Sin213) fleet of Cove tools (upscaler, compressor, PDF kit, meme maker, video editor, and more). Browse the whole collection, install any tool with one click, launch it, and keep it up to date — all from one place.

Supported Cove tools can also open directly **inside** Nexus via **Foxy Mode**, so you don't have to juggle separate windows. Cove Meme Maker is the first tool wired up for it; the rest still launch as their own apps and behave exactly like before.

Embedded Foxy Mode currently uses the Linux protocol transport. On Windows, tools launch as external apps. If an embedded page fails to load, Nexus shows the error and offers a retry when the app has reported its address.

---

## Install

### Linux

Download the latest [`Cove-Nexus-<version>-x86_64.AppImage`](https://github.com/Sin213/cove-nexus/releases/latest) from the Releases page.

```bash
chmod +x Cove-Nexus-*.AppImage
./Cove-Nexus-*.AppImage
```

The AppImage is self-contained - no installation step, no dependencies to manage.

On Debian/Ubuntu you can use the `.deb` instead:

```bash
sudo apt install ./Cove-Nexus-*-amd64.deb
```

### Windows

Two options from the [Releases](https://github.com/Sin213/cove-nexus/releases/latest) page:

- **`Cove-Nexus-<version>-Setup.exe`** — installed build. Silent, per-user (no admin prompt), and **updates itself silently in the background**. Recommended.
- **`Cove-Nexus-<version>-Portable.exe`** — single-file build. No install, nothing touches the registry; run it from anywhere including a USB stick. Silent auto-update only works on the installed build, so with portable you're in charge of updates.

> On first launch, Windows SmartScreen may show a warning because the `.exe` isn't code-signed. Click **More info** → **Run anyway**.

### Where Cove Nexus keeps its files

- **Config + registry** (never moves): `~/.config/cove-nexus/` on Linux, `%APPDATA%\cove-nexus\` on Windows. Holds `config.json` and `installs.json`.
- **Tool binaries** (user-configurable): defaults to `~/.local/share/cove-nexus/programs/` on Linux, `%LOCALAPPDATA%\cove-nexus\programs\` on Windows. Change it any time via the gear icon → **Programs folder** → Change…

---

## Features

- **One-window launcher** for every Cove tool — no hunting for AppImages or `.exe`s.
- **Foxy Mode** — supported tools open as a tab inside Nexus instead of a separate window. The card swaps **Launch** for **Running** while it's open; clicking **Running** focuses the existing tab instead of spawning a duplicate. Cove Meme Maker is the first tool to ship with Foxy Mode; everything else launches standalone as usual.
- **Auto-discovery from GitHub** — any `cove-*` repo on the account shows up automatically (`cove-*-bot` repos are filtered out).
- **Views + categories** - filter the grid by All / Installed / Updates / Not Installed, or by category tab (Media, Documents, Utilities, Create).
- **Program search** — search names, slugs, and descriptions within the current view or category. Press Escape to clear; bookmarks and drag order still work with search active.
- **Bookmarks** - star any tool and it joins a dedicated Bookmarks view for one-click access to your favorites.
- **Drag-to-reorder** - drag cards to arrange the grid your way; your order sticks and works in every view.
- **Install / launch / update** — each tool is a single click, with a live progress bar showing download bytes and verification status.
- **Repair / reinstall** — the card menu can download a managed tool's currently installed release again after confirmation. Close the tool first; its version, pin, and settings are preserved. Adopted files cannot be repaired, and failed downloads or checksum checks leave the existing binary intact.
- **Per-tool release notes** — the latest version and a short changelog preview sit on every card, fetched live from GitHub.
- **Update all** - one button updates every outdated tool and reports exactly which updates succeeded and which failed.
- **Works offline** - installed tools stay listed and launchable when GitHub is unreachable.
- **SHA-256 verification** - when a release ships a `<asset>.sha256` sidecar (or an older `checksums-sha256.txt` bundle), Cove Nexus verifies the download before replacing the old binary. A mismatch or failed check aborts the install; releases without checksums skip verification.
- **Tray icon + minimize-to-tray** — close the window and Nexus keeps running in the tray with a "Check for updates" option. Start-minimized and launch-on-startup are one-click toggles in Settings.
- **Optional update notifications** — off by default in Settings. Existing update scans can send one combined native notification while Nexus is in the background, once per program release tag across restarts. Click it to show Nexus.
- **Bring-your-own folder** — point Cove Nexus at a folder you already use (e.g., `~/Applications/`), and it auto-detects any Cove AppImage or `.exe` already living there.
- **Adopted vs. managed** — files Cove Nexus downloads are "managed" (replaced on update). Files it merely adopted from your folder are "adopted" (left alone on update; you clean up old versions on your own schedule).
- **Background self-updates** — installed Windows builds restart automatically when no hosted session is active. Active sessions get a restart action. AppImages are replaced in place and take effect on the next launch; portable users get a download banner.
- **Pin + unpin versions** — choose a specific tag for any tool and stay on it until you unpin; updates won't override your choice.
- **GitHub rate-limit aware** - transparent 5-minute cache, `X-RateLimit-*` backoff, cached data reused for up to 7 days when GitHub is down or rate-limited, and an optional PAT in Settings bumps the limit from 60/hr to 5000/hr.
- **Themeable** — light + dark themes, seven accent colors, three densities, two chrome modes (`Ctrl+,` for the Tweaks panel).
- **UI zoom** - `Ctrl/Cmd +` / `-` / `0` scales the whole interface up, down, or back to default.
- **Cross-platform** - Linux AppImage and `.deb`, Windows NSIS installer, Windows portable `.exe`.

---

## How it works

### Auto-discovery

On launch, Cove Nexus calls `GET /users/Sin213/repos` and filters to repos named `cove-*`. Anything not already in the static registry is added to the grid on the fly. Installed tools are populated from the local registry even when GitHub is unavailable. The grid refreshes on startup, on the titlebar refresh button, every 30 minutes, and when the window regains focus after more than 10 minutes away.

GitHub requests share a bounded queue and reuse requests already in flight. Successful unauthenticated API responses are cached on disk for offline use; authenticated responses stay in memory. A forced refresh bypasses cached responses.

### Install / update

Clicking **Install** on a card fetches `GET /repos/Sin213/<slug>/releases/latest`, picks the platform-appropriate asset (Portable.exe on Windows, AppImage on Linux), downloads it into your programs folder, and records the tag in `installs.json`. Update repeats the same flow if the tag has moved.

Each install downloads over HTTPS into its own temporary folder, with size limits and cleanup on failure. The file is verified and marked executable before it replaces the old binary, so a failed install leaves the working version in place.

### Adoption

On every scan, Cove Nexus walks your programs folder. Recognized AppImages on Linux and portable executables on Windows that aren't already tracked get registered as **adopted** — version parsed from the filename, no download needed. Scans ignore installers and other platforms' binaries, preserve live pinned versions, and never delete files based on their names. After a verified update, Nexus can remove the previous binary it managed.

Removing or forgetting a tool stops the next scan from adopting it again from the same folder. Installing it again or picking its file by hand clears that.

### Launching

Cove Nexus spawns the tracked binary directly. Failures to spawn (missing binary, wrong permissions) surface as errors in the UI instead of silent fake-success toasts.

### Foxy Mode

Some Cove tools expose an embedded web UI that Nexus can host directly. When a tool is marked as Foxy-capable in the registry, **Launch** opens it as a tab inside the Nexus window instead of starting it as a separate process.

While a Foxy Mode app is open, its card shows **Running**. Clicking **Running** snaps focus back to the existing tab — Nexus never opens a duplicate. Closing the tab returns the card to its normal **Launch** state.

If a hosted page fails, crashes, or does not finish loading within 15 seconds, the tab shows the error and offers a retry. Exports and downloads from a Foxy tab are saved to your Downloads folder; an existing file is never overwritten (a `(1)` suffix is added instead), and a toast names the saved file.

Foxy Mode is opt-in per tool: tools that don't advertise it still install, launch, and update as standalone apps. Nexus continues to manage every binary in your configured programs folder either way.

**For developers:** Foxy-capable tools advertise a small embedded web endpoint that Nexus loads inside an isolated, sandboxed view. Each tool gets its own session: permissions are denied by default (clipboard writes are the one exception), navigation stays on the tool's own origin, and popups are blocked. Standalone launches are unaffected.

### Silent self-update

Cove Nexus uses [`electron-updater`](https://www.electron.build/auto-update) to check `github.com/Sin213/cove-nexus/releases/latest` on launch and hourly while running. New releases download in the background. Windows restarts automatically while idle; if a hosted session is active, Nexus waits for the user to choose **Restart and update**. Linux replaces the AppImage in place and offers the same restart action without closing active work automatically.

The Windows **Portable** build is the one exception — `electron-updater` can't hot-swap a running `.exe` that the user dropped somewhere themselves, so portable users get a dismissable in-app banner instead. Setup.exe and AppImage builds update in the background as described above.

---

## Built-in programs

The static registry includes these ten tools by default. Any other `cove-*` repo on the Sin213 account is auto-discovered.

| Tool | What it does |
|---|---|
| [cove-narrator](https://github.com/Sin213/cove-narrator) | Offline text-to-speech with voice blending and document reading |
| [cove-image-upscaler](https://github.com/Sin213/cove-image-upscaler) | Offline image upscaler for photos and anime (NCNN Vulkan) |
| [cove-video-downloader](https://github.com/Sin213/cove-video-downloader) | Downloads from YouTube, Twitter, TikTok, etc. |
| [cove-compressor](https://github.com/Sin213/cove-compressor) | Shrinks video, images, and PDFs |
| [cove-universal-converter](https://github.com/Sin213/cove-universal-converter) | One converter for every file format |
| [cove-pdf-kit](https://github.com/Sin213/cove-pdf-kit) | Merge, split, compress, OCR PDFs |
| [cove-pdf-editor](https://github.com/Sin213/cove-pdf-editor) | Edit PDFs like native documents |
| [cove-meme-maker](https://github.com/Sin213/cove-meme-maker) | Meme templates with a live editor — opens inside Nexus via **Foxy Mode** |
| [cove-gif-maker](https://github.com/Sin213/cove-gif-maker) | Clips → pixel-perfect GIFs |
| [cove-video-editor](https://github.com/Sin213/cove-video-editor) | Keyboard-driven timeline editor |

Auto-discovery currently adds these as well:

| Tool | What it does |
|---|---|
| [cove-download-manager](https://github.com/Sin213/cove-download-manager) | Multi-connection download manager built on aria2 |
| [cove-file-toolkit](https://github.com/Sin213/cove-file-toolkit) | File search, disk usage, and bulk rename in one app |
| [cove-image-lab](https://github.com/Sin213/cove-image-lab) | Two-image comparison and inspection |
| [cove-image-viewer](https://github.com/Sin213/cove-image-viewer) | Image viewer for 60+ formats |
| [cove-screen-recorder](https://github.com/Sin213/cove-screen-recorder) | Region / screen / window recorder to MP4 or GIF |

---

## Building from source

Requirements: Node 22 (the version CI builds with).

```bash
git clone https://github.com/Sin213/cove-nexus.git
cd cove-nexus
npm install
npm start                # dev run
npm run check            # lint and run the Node test suite
npm run dist:linux       # build AppImage + .deb → release/
npm run dist:win         # build Windows NSIS Setup.exe + Portable.exe → release/ (needs Wine on Linux)
npm run release          # build Linux + Windows, publish to GitHub, upload sha256 sidecars (needs GH_TOKEN)
```

Every shipped binary (AppImage, .deb, Setup.exe, Portable.exe) gets a matching `<asset>.sha256` sidecar in `release/`, written by `build/afterAllArtifactBuild.js`. The `release` script additionally runs `build/postReleaseSidecars.js` to generate and upload sidecars for the auto-update metadata files (`latest*.yml`).

Pull requests and branch pushes run lint and tests on Linux and Windows. Tag releases must pass the same checks before either platform builds. The finalizer requires all four platform artifacts, `latest.yml`, `latest-linux.yml`, and a checksum sidecar for every asset; missing, empty, or unfinished assets fail the release. CI sets the release notes and leaves the release as a draft to publish by hand.


### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+,` | Toggle Tweaks panel |
| `Ctrl/Cmd +` / `-` | Zoom UI in / out |
| `Ctrl/Cmd 0` | Reset UI zoom |
| `Esc` | Clear program search / close Tweaks panel / settings modal |

---

## License

MIT. See [`LICENSE`](./LICENSE).
