# Handover — 2026-05-11 — T-001 Foxy Mode v1 plan ready

## Done this session

Wrote a concrete v1 implementation plan into
`.story/tickets/T-001-foxy-mode-v1.md`. No app source files were modified
and nothing was committed. The plan covers:

- Settings layer changes in `main.js` (validation + IPC projection + accept
  in `setPreferences`).
- A small `cove:launch` hide-skip so `closeAfterLaunch` does not hide the
  window while Foxy Mode is on.
- Renderer state extensions in `launcher.js` (`foxyMode`, `tabs`, `activeTabId`),
  plus `ensureTab` / `closeTab` / `setFoxyMode` helpers.
- UI shell additions in `renderer/index.html` (tab strip container,
  tool-session container, Settings checkbox row, CSS toggles driven by
  `body[data-foxy]` and `main.main.tab-tool`).
- Edge-case decisions (launch failure → no tab, uninstall → close tab,
  sidebar click → return to Home, no persistence of tabs across restart).

## What the next session should do

Open T-001 and execute the plan as a single implementation pass.
Suggested order:

1. **main.js** — `readConfig`, `cove:config:get`, `cove:config:setPreferences`,
   then the one-line `cove:launch` hide-skip.
2. **renderer/index.html** — tab strip container, tool-session container,
   Settings "Interface" row with `#pref-foxy-mode`, CSS.
3. **renderer/assets/launcher.js** — `state` fields, helpers, hooks into
   `doLaunch` / `doUninstall` / sidebar click handler / `init()` / settings
   listener, hide the Foxy Mode row when `!IS_DESKTOP`.

No `preload.js` change is needed — `coveAPI.config.setPreferences` already
forwards arbitrary preference patches.

## Out of scope for the implementation pass

- Native embedding, OS window reparenting, in-tab rendering of external
  app UIs — explicitly deferred.
- Tab persistence across restarts, drag-reorder of tabs, tab pinning.
- "Bring app to front" button — deferred (OS window enumeration).
- Packaging, release, or version bump — separate task.

## Verification once implemented

Run the manual-checks block at the bottom of T-001 (12 checks covering
default-off behavior, on-state launch + dedupe, sidebar interaction,
`closeAfterLaunch` interaction, uninstall-with-open-tab, theme parity,
browser preview).

## Files NOT touched this session

- `main.js`
- `preload.js`
- `renderer/index.html`
- `renderer/assets/launcher.js`
- `renderer/assets/programs.js`
- `package.json`, build configs, release scripts
- No commit was made.

## References

- Plan: `.story/tickets/T-001-foxy-mode-v1.md`
- Settings IPC code: `main.js:395-455`, `main.js:1073-1136`
- Launch IPC: `main.js:1246-1278`
- Renderer state + launch UI: `renderer/assets/launcher.js:18-34`, `:369-392`
- Settings modal: `renderer/index.html:917-967`
- Main content shell: `renderer/index.html:803-870`
