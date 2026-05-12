# Cove Nexus — Project State

_Last updated: 2026-05-11_

## What it is

Cove Nexus is an Electron-based launcher for Cove tools. It installs, launches, updates, pins, adopts, and manages Cove tools from a single UI.

## Platforms

- Linux: AppImage
- Windows: Setup installer + Portable build

## Key source files

- `main.js` — Electron main process; lifecycle, IPC, install/update orchestration.
- `preload.js` — preload bridge between main and renderer.
- `renderer/index.html` — launcher UI shell.
- `renderer/assets/launcher.js` — launcher behavior (views, actions, state).
- `renderer/assets/programs.js` — tool catalog / program definitions.

## Existing systems to reuse

- Settings / config: persisted user preferences already exist; future toggles (including Foxy Mode) should reuse this rather than introduce a parallel store.
- Views supported by drag-reorder: All / Installed / Updates / Not Installed / categories / Bookmarks.

## Recent work

- Linux autostart support added/fixed (most recent commit on `main`).
- v2.0.8: Ctrl/Cmd `+`/`-`/`0` UI zoom, rem refactor.
- v2.0.7: drag-reorder, bookmarks, light mode, update fix, GitHub Actions release.
- v2.0.6: Codex security review follow-up.
- v2.0.5: close-after-launch setting.

## Upcoming

- **T-001 Foxy Mode v1** — browser-style tool tabs inside the launcher (opt-in, default off). See `.story/tickets/T-001-foxy-mode-v1.md`.

## Conventions / constraints

- Releases under `~/Projects/` publish `<asset>.sha256` sidecars alongside each binary.
- Repo boundary rules apply: do not borrow workflows from sibling repos; this repo is the source of truth for build/package/release.
- Don't redesign or expand scope beyond the active task / handoff.
