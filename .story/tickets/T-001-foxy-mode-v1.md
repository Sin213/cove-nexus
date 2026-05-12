# T-001 — Foxy Mode v1: browser-style tool tabs

**Status:** open
**Created:** 2026-05-11
**Owner:** unassigned

## Summary

Add an opt-in "Foxy Mode" to Cove Nexus that renders launched tools as browser-style tabs inside the launcher window, with a permanent Home tab. v1 is renderer-level only — no native window embedding, no OS window reparenting.

## Requirements

### Settings

- Add a Settings toggle named **"Foxy Mode"**.
- Default: **off**.
- Persist through the existing config / preferences system (do not introduce a new store).

### Off (default) behavior

- Preserve current launcher behavior exactly.
- No tab strip, no Home tab, no tab-related UI surface.

### On behavior

- Launching a tool **creates or activates** a browser-style tab for that tool.
  - If a tab for the tool already exists: activate it.
  - Otherwise: create a new tab and activate it.
- Always include a **Home** tab (the existing launcher view).
- Tool tabs are **closeable**.
- Closing a tab **must not** uninstall or kill the underlying app.
- **External apps still launch normally** — Foxy Mode does not change how processes are spawned for tools that run as external apps; the tab is a UI affordance, not a process container.

### Explicitly out of scope for v1

- Native window embedding.
- OS-level window reparenting.
- Tab drag-reorder, tab pinning, tab persistence across restarts (defer to v2).
- Per-tool web views or in-tab rendering of external app UIs (deferred).

## Acceptance criteria

- Toggle visible in Settings, defaults off, persists across restarts.
- With Foxy Mode off, no behavioral change vs. current build.
- With Foxy Mode on:
  - Home tab is always present.
  - Launching a tool produces/activates a tab; relaunching the same tool does not produce duplicates.
  - Closing a tool tab leaves the underlying app process untouched.
  - External app launching path is unchanged.

## Open questions

- Where does the tab strip render relative to the existing header? (UI placement to be decided during implementation.)
- Should the active tab survive a launcher restart in v1, or always reset to Home? (Default assumption: reset to Home; revisit if needed.)

## Touchpoints (anticipated)

- `renderer/index.html` — tab strip shell.
- `renderer/assets/launcher.js` — tab state, activation, close handlers, Home-tab wiring.
- Settings / config layer — new boolean preference.
- `main.js` / `preload.js` — likely no change for v1 (no embedding).
