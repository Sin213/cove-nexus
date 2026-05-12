# Handover — 2026-05-11 — Bootstrap `.story/`

## What was done

Created a minimal `.story/` workflow scaffold for Cove Nexus. No app source files were modified.

### Files created

- `.story/README.md` — layout + conventions for `.story/`.
- `.story/project-state.md` — snapshot of current known project state: stack, key source files, platforms, recent releases (through v2.0.8 + Linux autostart), upcoming work.
- `.story/tickets/T-001-foxy-mode-v1.md` — initial ticket for Foxy Mode v1 (browser-style tool tabs, opt-in, no embedding/reparenting in v1).
- `.story/handovers/2026-05-11-bootstrap-story.md` — this handover.
- `.story/notes/` — created (empty) for future freeform notes.

### Files NOT touched

- `main.js`, `preload.js`, `renderer/index.html`, `renderer/assets/launcher.js`, `renderer/assets/programs.js`, and all other app source remain unchanged.
- No commit was made.

## Recommended next step

Open **T-001 Foxy Mode v1** as the next implementation session:

1. Decide the Settings UI placement for the "Foxy Mode" toggle and confirm the existing config key naming convention to reuse.
2. Design the tab-strip data model in `renderer/assets/launcher.js` (tabs list, active tab, Home tab as a fixed first entry, dedupe-by-tool-id on launch).
3. Wire the launch path so that, when Foxy Mode is on, launching a tool routes through the tab manager (create-or-activate) while leaving the external-process spawn path untouched.
4. Confirm v1 scope boundaries before coding: no embedding, no reparenting, no persistence beyond what falls out of the existing config.

Keep changes surgical and bounded to the renderer + settings layer for v1.
