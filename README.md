# Cove Suite

**The Cove Nexus — install, launch, and update every Cove tool from a single window.**

![Cove Suite](docs/screenshot.png)

Cove Suite is a desktop launcher for the [Sin213](https://github.com/Sin213) fleet of Cove tools (upscaler, compressor, PDF kit, meme maker, video editor, and more). Browse the whole collection, install any tool with one click, launch it, and keep it up to date — all from one place.

---

## Install

### Linux

Download the latest [`Cove-Suite-<version>-x86_64.AppImage`](https://github.com/Sin213/cove-suite/releases/latest) from the Releases page.

```bash
chmod +x Cove-Suite-*.AppImage
./Cove-Suite-*.AppImage
```

The AppImage is self-contained — no installation step, no dependencies to manage. On first launch it creates `~/.cove-suite/` to store installed tools.

### Windows

Two options from the [Releases](https://github.com/Sin213/cove-suite/releases/latest) page:

- **`Cove-Suite-<version>-Setup.exe`** — installed build. Silent, per-user (no admin prompt), and **updates itself silently in the background**. Recommended.
- **`Cove-Suite-<version>-Portable.exe`** — single-file build. No install, nothing touches the registry; run it from anywhere including a USB stick. Silent auto-update is best-effort on portable (it requires the `.exe` to be writable where you keep it, which fails for read-only locations like Program Files), so for portable you're effectively in charge of updates.

> On first launch, Windows SmartScreen may show a warning because the `.exe` isn't code-signed yet. Click **More info** → **Run anyway**. This only happens once for the installed build; the portable build may show the warning each time until SmartScreen's reputation system accepts it.

---

## Features

- **One-window launcher** for every Cove tool — no more hunting for AppImages, `.exe`s, and `python` commands.
- **Auto-discovery from GitHub** — any `cove-*` repo on your account shows up automatically.
- **Install / launch / update** — each tool is a single click. Installs via `git clone`, launches via auto-detected entry point, updates via `git pull`.
- **Real update detection** — compares local `HEAD` to `origin/HEAD` for every installed program so the "Updates" filter is actually truthful.
- **Silent self-updates** — Cove Suite itself updates in the background from GitHub releases and relaunches seamlessly.
- **Themeable** — seven accent colors, three layout densities, two window chrome modes (press `Ctrl+,` to open the Tweaks panel).
- **Cross-platform** — Linux AppImage and Windows NSIS installer (plus a portable `.exe`).

---

## How it works

### Auto-discovery

On launch, Cove Suite calls the GitHub API (`GET /users/Sin213/repos`) and filters the response to repos named `cove-*`. Anything not already in the static registry gets added to the grid automatically with a default icon and the "Utilities" category. The grid auto-refreshes:

- On startup
- When you click the titlebar refresh button
- Every 10 minutes while the window is open
- When the window regains focus after being idle

If you push a new `cove-newtool` repo to GitHub, you don't need to ship a new version of Cove Suite — it'll appear on its own. (The GitHub API is rate-limited to 60 requests/hour for unauthenticated clients; a 5-minute cache keeps us well within that.)

### Launching a program

When you click **Launch**, Cove Suite tries entry points in this order:

1. **`.cove.json` manifest** at the repo root (see below).
2. **Prebuilt AppImage** in `release/`, `dist/`, or `build/`.
3. **`launch.sh`** at the repo root.
4. **`package.json`** with a `start` or `dev` script (runs via `npm start`).
5. **Python entry**: `<slug>.py`, `main.py`, `app.py`, or `src/<slug>/__main__.py`.

If none of those resolve, Cove Suite shows an actionable error telling you what it looked for.

### `.cove.json` manifest (optional)

Any Cove repo can include a `.cove.json` at its root to declare how it should appear and launch:

```json
{
  "name": "Cove PDF Kit",
  "icon": "pdf",
  "category": "cat-docs",
  "description": "Merge, split, compress, protect, rotate, OCR.",
  "version": "1.0.8",
  "entry": "src/cove_pdf_kit/__main__.py"
}
```

All fields are optional. The manifest fields override the registry defaults for installed programs.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `icon` | string | One of: `upscale`, `download`, `compress`, `convert`, `pdf`, `meme`, `gif`, `pdf-edit`, `video` |
| `category` | string | One of: `cat-media`, `cat-docs`, `cat-utils`, `cat-create` |
| `description` | string | One-line tagline shown in the info tooltip |
| `version` | string | Displayed on the card |
| `entry` | string \| object | Launch target — see below |

**`entry` forms:**
- `"main.py"` — string path; interpreter inferred from extension (`.py` → `python3`, `.sh` → `bash`, `.AppImage` → direct exec, `.js` → `node`)
- `{ "cmd": "cargo", "args": ["run", "--release"] }` — explicit command
- `{ "kind": "appimage", "path": "release/Tool.AppImage" }` — explicit AppImage

### Silent auto-updates

Cove Suite uses [`electron-updater`](https://www.electron.build/auto-update) to check `github.com/Sin213/cove-suite/releases/latest` on launch and hourly while running. When a newer release is found it downloads in the background and relaunches silently when ready. There's no prompt — this is intentional.

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

Requirements: Node 18+, git.

```bash
git clone https://github.com/Sin213/cove-suite.git
cd cove-suite
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
  index.html                        App shell
  assets/
    programs.js                     Static program registry (icons, categories, descriptions)
    launcher.js                     All renderer logic (grid, filters, install/launch/update)
    cove_icon.png                   App icon
    cove-video-editor-preview.png   Featured-banner screenshot
build/
  icon.png                          Packaging icon (512×512)
```

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+,` | Toggle Tweaks panel |
| `Esc` | Close Tweaks panel |

---

## License

MIT. See [`LICENSE`](./LICENSE).
