# Cove Nexus

**Install, launch, and update every Cove tool from a single window.**

![Cove Nexus](docs/screenshot.png)

Cove Nexus is a desktop launcher for the [Sin213](https://github.com/Sin213) fleet of Cove tools (upscaler, compressor, PDF kit, meme maker, video editor, and more). Browse the whole collection, install any tool with one click, launch it, and keep it up to date — all from one place.

---

## Install

### Linux

Download the latest [`Cove-Nexus-<version>-x86_64.AppImage`](https://github.com/Sin213/cove-nexus/releases/latest) from the Releases page.

```bash
chmod +x Cove-Nexus-*.AppImage
./Cove-Nexus-*.AppImage
```

The AppImage is self-contained — no installation step, no dependencies to manage.

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
- **Auto-discovery from GitHub** — any `cove-*` repo on the account shows up automatically (`cove-*-bot` repos are filtered out).
- **Install / launch / update** — each tool is a single click, with a live progress bar showing download bytes and verification status.
- **Per-tool release notes** — the latest version and a short changelog preview sit on every card, fetched live from GitHub.
- **Optional SHA-256 verification** — when a release ships a `<asset>.sha256` companion, Cove Nexus downloads and verifies before replacing the old binary. Missing → skipped.
- **Tray icon + minimize-to-tray** — close the window and Nexus keeps running in the tray with a "Check for updates" option. Start-minimized and launch-on-startup are one-click toggles in Settings.
- **Bring-your-own folder** — point Cove Nexus at a folder you already use (e.g., `~/Applications/`), and it auto-detects any Cove AppImage or `.exe` already living there.
- **Adopted vs. managed** — files Cove Nexus downloads are "managed" (replaced on update). Files it merely adopted from your folder are "adopted" (left alone on update; you clean up old versions on your own schedule).
- **Silent self-updates** — the launcher itself updates in the background from GitHub releases and relaunches seamlessly (Setup.exe + AppImage). Portable users get a one-click in-app banner.
- **Pin + unpin versions** — choose a specific tag for any tool and stay on it until you unpin; updates won't override your choice.
- **GitHub rate-limit aware** — transparent 5-minute cache, `X-RateLimit-*` backoff, optional PAT in Settings bumps the limit from 60/hr to 5000/hr.
- **Themeable** — seven accent colors, three densities, two chrome modes (`Ctrl+,` for the Tweaks panel).
- **Cross-platform** — Linux AppImage, Windows NSIS installer, Windows portable `.exe`.

---

## How it works

### Auto-discovery

On launch, Cove Nexus calls `GET /users/Sin213/repos` and filters to repos named `cove-*`. Anything not already in the static registry is added to the grid on the fly. The grid refreshes on startup, on the titlebar refresh button, every 10 minutes while the window is open, and when the window regains focus after > 30s idle.

### Install / update

Clicking **Install** on a card fetches `GET /repos/Sin213/<slug>/releases/latest`, picks the platform-appropriate asset (Portable.exe on Windows, AppImage on Linux), downloads it into your programs folder, and records the tag in `installs.json`. Update repeats the same flow if the tag has moved.

### Adoption

On every scan, Cove Nexus walks your programs folder. Any file matching a Cove release-asset pattern (`cove-<name>-<version>-Portable.exe`, `Cove-<Name>-<version>-x86_64.AppImage`, etc.) that isn't already tracked gets registered as **adopted** — version parsed from the filename, no download needed. Point the folder at your existing `~/Applications/` and every Cove tool you've already downloaded shows up as installed.

### Launching

Cove Nexus spawns the tracked binary directly. Failures to spawn (missing binary, wrong permissions) surface as errors in the UI instead of silent fake-success toasts.

### Silent self-update

Cove Nexus uses [`electron-updater`](https://www.electron.build/auto-update) to check `github.com/Sin213/cove-nexus/releases/latest` on launch and hourly while running. When a newer release is found it downloads in the background and relaunches silently when ready. No prompt.

The Windows **Portable** build is the one exception — `electron-updater` can't hot-swap a running `.exe` that the user dropped somewhere themselves, so portable users get a dismissable in-app banner instead. Setup.exe and AppImage continue to update silently.

---

## Built-in programs

The static registry includes these nine tools by default. Any other `cove-*` repo on the Sin213 account is auto-discovered.

| Tool | What it does |
|---|---|
| [cove-upscaler](https://github.com/Sin213/cove-upscaler) | AI image/video upscaler (Real-ESRGAN) |
| [cove-video-downloader](https://github.com/Sin213/cove-video-downloader) | Downloads from YouTube, Twitter, TikTok, etc. |
| [cove-compressor](https://github.com/Sin213/cove-compressor) | Shrinks video, images, and PDFs |
| [cove-universal-converter](https://github.com/Sin213/cove-universal-converter) | One converter for every file format |
| [cove-pdf-kit](https://github.com/Sin213/cove-pdf-kit) | Merge, split, compress, OCR PDFs |
| [cove-pdf-editor](https://github.com/Sin213/cove-pdf-editor) | Edit PDFs like native documents |
| [cove-meme-maker](https://github.com/Sin213/cove-meme-maker) | Meme templates with a live editor |
| [cove-gif-maker](https://github.com/Sin213/cove-gif-maker) | Clips → pixel-perfect GIFs |
| [cove-video-editor](https://github.com/Sin213/cove-video-editor) | Keyboard-driven timeline editor |

---

## Building from source

Requirements: Node 18+.

```bash
git clone https://github.com/Sin213/cove-nexus.git
cd cove-nexus
npm install
npm start                # dev run
npm run dist:linux       # build AppImage → release/
npm run dist:win         # build Windows NSIS + portable → release/ (needs Wine on Linux)
npm run release          # build + publish to GitHub (needs GH_TOKEN env var)
```

### Project layout

```
main.js                             Electron main process, IPC handlers, auto-updater
preload.js                          contextBridge exposing coveAPI to the renderer
renderer/
  index.html                        App shell + settings modal
  assets/
    programs.js                     Static program registry (icons, categories, descriptions)
    launcher.js                     Renderer logic (grid, filters, install/launch/update, settings)
    cove_icon.png                   App icon
    cove-video-editor-preview.png   Featured-banner screenshot
build/
  icon.png                          Packaging icon (512×512)
```

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+,` | Toggle Tweaks panel |
| `Esc` | Close Tweaks panel / settings modal |

---

## License

MIT. See [`LICENSE`](./LICENSE).
