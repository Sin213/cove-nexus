# T-001 — Foxy Mode v1: browser-style tool tabs

**Status:** planned
**Created:** 2026-05-11
**Plan updated:** 2026-05-11
**Owner:** unassigned

## Summary

Add an opt-in "Foxy Mode" to Cove Nexus that renders launched tools as
browser-style tabs inside the launcher window, with a permanent Home tab.
v1 is renderer-level only — no native window embedding, no OS window
reparenting, no in-tab rendering of external app UIs. External Cove apps
still launch as detached child processes; the tab is a Nexus UI affordance
on top of the existing launch path.

## Requirements

### Settings

- Add a Settings toggle named **"Foxy Mode"**.
- Default: **off**.
- Persist through the existing `~/.config/cove-nexus/config.json` via the
  current `cove:config:setPreferences` IPC. No new store, no new IPC channel.

### Off (default) behavior

- Preserve current launcher behavior exactly.
- No tab strip, no Home tab, no tab-related UI surface.
- `closeAfterLaunch` continues to hide the window after launch (unchanged).

### On behavior

- Launching a tool **creates or activates** a tab for that tool.
  - If a tab for the same slug already exists: activate it (no duplicate).
  - Otherwise: create a new tab and activate it.
- A **Home** tab is always present and always first; it cannot be closed.
- Tool tabs are **closeable** via an "x" affordance.
- Closing a tab **does not** uninstall or kill the underlying app process.
- External apps still spawn via the existing `cove:launch` path.
- While Foxy Mode is on, `closeAfterLaunch` is suppressed — the launcher
  window stays visible so the user can return to the tab. Setting value
  itself is preserved; only the post-launch `mainWindow.hide()` call is
  skipped.

### Explicitly out of scope for v1

- Native window embedding.
- OS-level window reparenting.
- Tab drag-reorder, tab pinning, tab persistence across restarts.
- Per-tool web views or in-tab rendering of external app UIs.
- "Bring external app window to front" (deferred — would need OS window
  enumeration).

## Acceptance criteria

- Settings shows a "Foxy Mode" toggle, defaults off, persists across restarts
  in `config.json`.
- With Foxy Mode off, no behavioral change vs. the current build.
- With Foxy Mode on:
  - Home tab is always present and not closeable.
  - Launching a tool produces or activates a tab; relaunching the same tool
    does not produce a duplicate.
  - Closing a tool tab leaves the underlying app process running.
  - External-process spawn path is unchanged.
  - `closeAfterLaunch` does not hide the window after launch.
- Toggling Foxy Mode off clears in-memory tabs and returns the UI to the
  pre-Foxy layout without a restart.

## Implementation plan

### 1. Settings layer (main.js)

Touchpoints: `readConfig` (line 395), `writeConfig` (442), IPC handlers
`cove:config:get` (1073) and `cove:config:setPreferences` (1093).

- `readConfig`: include `foxyMode: !!raw?.foxyMode` in the validated return.
- `cove:config:get`: include `foxyMode: !!cfg.foxyMode`.
- `cove:config:setPreferences`: accept the new field with the same
  field-by-field pattern as the other booleans:

  ```js
  if (typeof prefs.foxyMode === 'boolean') cfg.foxyMode = prefs.foxyMode;
  ```

  Echo `foxyMode` back in the response object alongside the other prefs.
- `cove:launch` handler (line 1276): change the post-spawn hide call so it
  only fires when Foxy Mode is off:

  ```js
  const cfgNow = readConfig();
  if (cfgNow.closeAfterLaunch && !cfgNow.foxyMode && mainWindow) mainWindow.hide();
  ```

  No other change to the launch path. Spawn semantics, env, detached flag
  remain identical.

### 2. Preload (preload.js)

No change. `coveAPI.config.setPreferences(prefs)` and `coveAPI.config.get()`
already carry arbitrary preference patches.

### 3. UI shell (renderer/index.html)

- Inside `<main class="main">` (line 803), insert a tab strip container as
  the first child:

  ```html
  <div class="foxy-tabs" id="foxy-tabs" hidden></div>
  ```

- After the existing grid (line 869), add a hidden tool-session container
  as a sibling, so the tab strip can swap between the Home view (hero +
  banners + featured + grid) and a tool-session view:

  ```html
  <section class="foxy-session" id="foxy-session" hidden></section>
  ```

- Settings modal (line 950): add a new row "Interface" with a Foxy Mode
  `.pref-check` checkbox:

  ```html
  <label class="pref-check"><input type="checkbox" id="pref-foxy-mode" />
    <span><b>Foxy Mode</b> <small>— launched tools appear as tabs inside Cove Nexus.</small></span></label>
  ```

- Add CSS in the existing `<style>` block for: `.foxy-tabs` row (height,
  flex, border-bottom using existing tokens), `.foxy-tab` (padding,
  border-radius, hover, active state), `.foxy-tab .close` (small "x"
  matching the existing close-button visual language), `.foxy-session`
  (padded section with tool icon + name + status pill + close-tab button),
  and a body/main toggle that hides hero/featured/grid when a tool tab is
  active.

  Toggle pattern (simplest): drive visibility off `body[data-foxy]` and a
  `main.main.tab-tool` class:

  ```css
  body[data-foxy="off"] #foxy-tabs,
  body[data-foxy="off"] #foxy-session { display: none; }
  main.main.tab-tool > .hero,
  main.main.tab-tool > .featured,
  main.main.tab-tool > .section-head,
  main.main.tab-tool > #grid,
  main.main.tab-tool > .rate-banner,
  main.main.tab-tool > .self-update-banner,
  main.main.tab-tool > .update-banner { display: none; }
  main.main.tab-tool > #foxy-session { display: block; }
  ```

### 4. Renderer state + behavior (renderer/assets/launcher.js)

- Extend the `state` object (line 18) with:

  ```js
  foxyMode: false,
  tabs: [],           // [{ id: 'home' | slug, kind: 'home' | 'tool', slug, title }]
  activeTabId: 'home',
  ```

  Home is always modeled as a real entry (`{ id: 'home', kind: 'home',
  title: 'Home' }`) and is seeded at init when Foxy Mode is on.

- Add helpers near the existing render logic:
  - `ensureTab(prog)` — find by `slug`; activate if present, else push and activate.
  - `closeTab(id)` — if `id !== 'home'`, remove from `state.tabs`; if it was active, fall back to the previous tab (default Home).
  - `setFoxyMode(on)` — flip flag, set `body[data-foxy]`, seed/clear tabs, re-render.
  - `renderTabs()` — rebuild the `#foxy-tabs` strip from `state.tabs`; mark the active tab; wire click + close handlers (delegated).
  - `renderToolSession()` — when `activeTabId !== 'home'`, populate `#foxy-session` with tool icon, name, a "Running" status pill, a "Close tab" button, and one-line note ("Switch to its window in your OS to use it; the app is running outside Cove Nexus"). Toggle the `tab-tool` class on `<main>`.

- Hook `doLaunch(prog)` (line 369): after the IPC succeeds, when
  `state.foxyMode` is true, call `ensureTab(prog)` then re-render. Tab is
  created only on successful launch — failure path is unchanged (no zombie
  tabs).

- Hook `doUninstall(prog)` (line 419): when `state.foxyMode` is true, call
  `closeTab(prog.slug)` after the uninstall completes.

- Hook `refreshSettingsPaths()` (line 1016): read `cfg.foxyMode` and set
  `pref-foxy-mode.checked`.

- Add a change listener on `#pref-foxy-mode`:

  ```js
  document.getElementById('pref-foxy-mode')?.addEventListener('change', (e) => {
    setFoxyMode(e.target.checked);
    savePrefs({ foxyMode: e.target.checked });
  });
  ```

- Hide the Foxy Mode row entirely when `!IS_DESKTOP` (the browser preview
  in `cove-tool-launcher` has no IPC and can't launch).

- In `init()` (line 1287): after loading `cfg` from `coveAPI.config.get()`,
  set `state.foxyMode = !!cfg.foxyMode` and apply `body[data-foxy]`
  attribute. Seed `state.tabs` with the Home entry only when Foxy Mode is
  on. Do NOT restore prior tool tabs — tabs are session-only in v1.

### 5. Dedupe + close semantics summary

- Dedupe key: `tab.slug === prog.slug`.
- Closing a tool tab: removes the tab from `state.tabs`. No IPC call. No
  process signal. External app keeps running.
- Closing the active tool tab: fall back to the tab to its left, defaulting
  to Home.
- Toggling Foxy Mode off mid-session: `state.tabs = []`, `state.activeTabId = 'home'`, then re-render. No persistence implications.

## Files to change

- `main.js` — readConfig validation, cove:config:get projection,
  cove:config:setPreferences acceptance, cove:launch hide-skip when foxy.
- `renderer/index.html` — tab strip container, tool-session container,
  CSS for tabs/session/Foxy-driven visibility, Settings checkbox.
- `renderer/assets/launcher.js` — state extension, tab helpers, doLaunch
  hook, doUninstall hook, settings load + change listener, init wiring.

Out of touch:

- `preload.js` — no change.
- `renderer/assets/programs.js` — no change.
- Packaging/build files — no change.

## Risks and edge cases

1. **`closeAfterLaunch` interaction** — already handled by the main.js
   hide-skip when `cfg.foxyMode` is on. Settings value is preserved so
   toggling Foxy Mode off restores prior behavior.
2. **Launch failure leaving an empty tab** — avoided by creating the tab
   only after `coveAPI.launch` resolves successfully.
3. **Uninstalling a tool with an open tab** — `doUninstall` closes the tab
   when Foxy Mode is on; otherwise nothing to do.
4. **Active tab on restart** — tabs do not persist (per ticket scope).
   Each session starts with Home only.
5. **Toggling Foxy Mode off while tabs are open** — handled by `setFoxyMode(false)`: clear tabs, drop `tab-tool` class, restore prior layout.
6. **Long tool names** — tab elements need `max-width` + ellipsis to avoid the strip expanding past the content width.
7. **Browser preview (`!IS_DESKTOP`)** — toggle row is hidden; Foxy Mode is a no-op in browser mode because the launch IPC is absent.
8. **Theme / light mode** — tab strip and session view must use existing CSS variables so light/dark both work without per-mode rules.
9. **Sidebar navigation while a tool tab is active** — clicking a sidebar filter (All / Installed / Updates / Bookmarks / category) implicitly returns to the Home tab. Implementation: in the existing sidebar click handler (line 629), if Foxy Mode is on, also set `state.activeTabId = 'home'` and re-render.
10. **Spurious dedupe across reinstall** — slugs are stable, so a tab opened before uninstall and not closed would still dedupe against the same slug after reinstall. Closing the tab in `doUninstall` removes this edge case.
11. **Drag-reorder vs tab strip** — drag-reorder is grid-card level only; the tab strip has no drag in v1 per scope.

## Manual checks (run after patch)

1. Fresh launch with no `foxyMode` in `config.json`: Settings shows the
   toggle, off. Toggle on, close Settings, confirm `~/.config/cove-nexus/config.json` now contains `"foxyMode": true`.
2. With Foxy Mode on: tab strip is visible at top of main pane with only the Home tab. Launching a tool spawns the external process, opens a tab, activates it, and shows the tool-session view. The launcher window stays visible even with `closeAfterLaunch` on.
3. Relaunch the same tool: no duplicate tab; existing tab activates; external process spawn happens again (unchanged from today).
4. Launch a second tool: two tool tabs + Home. Clicking each tab swaps the main content.
5. Close a tool tab: tool process keeps running (verify via OS process list); active tab falls back to Home or the prior tab.
6. Click a sidebar filter while a tool tab is active: returns to Home tab content with the chosen filter applied.
7. Toggle Foxy Mode off: tab strip and session view disappear, UI returns to the pre-Foxy layout, tabs cleared.
8. Restart: setting persists; tabs do not.
9. With Foxy Mode OFF and `closeAfterLaunch` ON: launch hides the window (unchanged baseline).
10. With Foxy Mode ON and `closeAfterLaunch` ON: launch does NOT hide the window.
11. Uninstall a tool that has an open tab: tab is automatically closed.
12. Light + dark themes: tab strip + session view legible in both.
13. Browser preview (open `renderer/index.html` outside Electron): the Foxy Mode row is hidden; rest of the UI unaffected.

## Open questions (resolved by this plan)

- **Tab strip placement** — top of `<main class="main">`, sidebar remains usable across tabs.
- **Active-tab persistence** — does not persist in v1; each restart starts on Home.

## Touchpoints (final)

- `main.js` — settings projection + launch hide-skip.
- `renderer/index.html` — tab strip, session container, Settings checkbox, CSS.
- `renderer/assets/launcher.js` — state, tab helpers, launch/uninstall hooks, settings binding.
