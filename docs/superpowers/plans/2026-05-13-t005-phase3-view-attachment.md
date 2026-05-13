# T-005 Phase 3 — Tab-Web View Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach Electron `WebContentsView` instances to the active Nexus window, manage their bounds on every layout change, add a sidebar collapse control, and add a renderer placeholder region — completing the Nexus-side scaffold so a future tab-web app can render inside a Foxy tab.

**Architecture:** The renderer measures the `#tab-web-host` placeholder div via `ResizeObserver` + `getBoundingClientRect()` and sends `{x,y,width,height}` to main via IPC. Main calls `mainWindow.contentView.addChildView(view)` + `view.setBounds(bounds)` on show, and `removeChildView(view)` on hide. A sidebar collapse button toggles a CSS class on `.layout`; the ResizeObserver fires automatically as the sidebar width transitions, keeping bounds current with no extra wiring needed.

**Tech Stack:** Electron 33 (`WebContentsView`, `contentView`, `ipcMain`), vanilla JS renderer, CSS grid layout

---

## File Map

| File | Change |
|------|--------|
| `preload.js` | Add `showTabWebView(slug, bounds)` + `hideTabWebView(slug)` to `coveAPI` |
| `main.js` | Add `cove:tab-web:show` + `cove:tab-web:hide` handlers, `childViews` Set, update `destroyHostedView` |
| `renderer/index.html` | CSS: sidebar-collapsed state, tab-web-active layout, host placeholder, collapse button |
| `renderer/assets/launcher.js` | `state.sidebarCollapsed`, `state.activeHostedSlug`, `ResizeObserver` bounds loop, `renderToolSession` orchestration, collapse click handler |

---

## Task 1: IPC layer — expose view control from renderer

**Files:**
- Modify: `preload.js`

- [ ] **Step 1.1: Add two IPC methods to preload.js**

Open `preload.js`. After the `closeTabWeb` line (line 10), add:

```js
  showTabWebView:  (slug, bounds) => ipcRenderer.invoke('cove:tab-web:show', slug, bounds),
  hideTabWebView:  (slug)         => ipcRenderer.invoke('cove:tab-web:hide', slug),
```

Full updated block (lines 3–20 of preload.js):
```js
contextBridge.exposeInMainWorld('coveAPI', {
  appInfo:        () => ipcRenderer.invoke('cove:appInfo'),
  getState:       () => ipcRenderer.invoke('cove:getState'),
  scan:           () => ipcRenderer.invoke('cove:scan'),
  install:        (slug) => ipcRenderer.invoke('cove:install', slug),
  update:         (slug) => ipcRenderer.invoke('cove:update', slug),
  launch:         (slug, openMode) => ipcRenderer.invoke('cove:launch', slug, openMode),
  closeTabWeb:    (slug) => ipcRenderer.invoke('cove:tab-web:close', slug),
  showTabWebView: (slug, bounds) => ipcRenderer.invoke('cove:tab-web:show', slug, bounds),
  hideTabWebView: (slug)         => ipcRenderer.invoke('cove:tab-web:hide', slug),
  uninstall:      (slug) => ipcRenderer.invoke('cove:uninstall', slug),
  // ... rest unchanged
```

- [ ] **Step 1.2: Verify preload.js syntax**

```bash
node --check preload.js
```
Expected: no output (no syntax errors).

---

## Task 2: Main process — childViews tracking + show/hide handlers

**Files:**
- Modify: `main.js`

Context: `hostedViews` is a `Map<slug, WebContentsView>` declared at line ~1261. `destroyHostedView` is at line ~1269. The `cove:tab-web:close` handler is at line ~1850.

- [ ] **Step 2.1: Add `childViews` Set near `hostedViews`**

Find the line in `main.js` that reads:
```js
const hostedViews = new Map();
```

Add immediately after it:
```js
const childViews  = new Set(); // slugs whose view is currently addChildView'd
```

- [ ] **Step 2.2: Update `destroyHostedView` to evict from childViews**

Find `function destroyHostedView(slug)` at line ~1296. Its current body is:
```js
function destroyHostedView(slug) {
  const view = hostedViews.get(slug);
  if (!view) return;
  hostedViews.delete(slug);
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch { /* best-effort */ }
  // Clear stale tabUrl so the renderer knows this view is gone.
  const e = processRegistry.get(slug);
  if (e?.protocol?.tabUrl != null) {
    const proto = { ...e.protocol, tabUrl: null };
    processRegistry.set(slug, { ...e, protocol: proto, processUpdatedAt: Date.now() });
    broadcastProcessUpdate(slug, e.status);
  }
}
```

Replace the entire function with this (adds removeChildView before closing webContents):
```js
function destroyHostedView(slug) {
  const view = hostedViews.get(slug);
  if (!view) return;
  hostedViews.delete(slug);
  if (childViews.has(slug)) {
    try { mainWindow?.contentView?.removeChildView(view); } catch (_) {}
    childViews.delete(slug);
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch { /* best-effort */ }
  // Clear stale tabUrl so the renderer knows this view is gone.
  const e = processRegistry.get(slug);
  if (e?.protocol?.tabUrl != null) {
    const proto = { ...e.protocol, tabUrl: null };
    processRegistry.set(slug, { ...e, protocol: proto, processUpdatedAt: Date.now() });
    broadcastProcessUpdate(slug, e.status);
  }
}
```

- [ ] **Step 2.3: Add `cove:tab-web:show` IPC handler**

Find the `cove:tab-web:close` handler at line ~1850:
```js
ipcMain.handle('cove:tab-web:close', (_e, slug) => {
```

Add the following two handlers BEFORE that line:

```js
ipcMain.handle('cove:tab-web:show', (_e, slug, bounds) => {
  if (!isValidSlug(slug)) return;
  const view = hostedViews.get(slug);
  if (!view || view.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!childViews.has(slug)) {
    mainWindow.contentView.addChildView(view);
    childViews.add(slug);
  }
  if (bounds && typeof bounds.x === 'number') {
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width:  Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    });
  }
});

ipcMain.handle('cove:tab-web:hide', (_e, slug) => {
  if (!isValidSlug(slug)) return;
  const view = hostedViews.get(slug);
  if (!view || !childViews.has(slug)) return;
  try { mainWindow?.contentView?.removeChildView(view); } catch (_) {}
  childViews.delete(slug);
});
```

- [ ] **Step 2.4: Verify main.js syntax**

```bash
node --check main.js
```
Expected: no output.

---

## Task 3: CSS — sidebar collapse + tab-web host layout

**Files:**
- Modify: `renderer/index.html`

All changes are in the `<style>` block.

- [ ] **Step 3.1: Add sidebar collapse button CSS**

Find the `.sidebar-footer` rule (around line 246). After it, add:

```css
  /* Sidebar collapse button */
  .sidebar-collapse {
    margin-top: auto; align-self: flex-start;
    all: unset; cursor: pointer;
    width: 32px; height: 32px;
    display: grid; place-items: center; border-radius: 7px;
    color: var(--text-faint);
    transition: color 100ms, background 100ms;
  }
  .sidebar-collapse:hover { color: var(--text); background: var(--surface); }
  .sidebar-collapse svg { width: 16px; height: 16px; display: block; }
```

- [ ] **Step 3.2: Add sidebar-collapsed layout CSS**

Find the `@media (max-width: 900px)` block (around line 651). Add immediately BEFORE it:

```css
  /* Sidebar collapse */
  .layout { transition: grid-template-columns 200ms ease; }
  .layout.sidebar-collapsed { grid-template-columns: 48px 1fr; }
  .layout.sidebar-collapsed .sidebar { padding: 12px 8px; overflow: hidden; }
  .layout.sidebar-collapsed .brand .name,
  .layout.sidebar-collapsed .nav-label,
  .layout.sidebar-collapsed .nav button > *:not(.ico),
  .layout.sidebar-collapsed .nav button .count { display: none; }
  .layout.sidebar-collapsed .nav button { padding: 8px; justify-content: center; }
  .layout.sidebar-collapsed .sidebar-collapse { align-self: center; transform: scaleX(-1); }
```

- [ ] **Step 3.3: Add tab-web-active layout CSS**

Find the `/* Tool session page */` comment (around line 799). After the existing rules for `.foxy-tabweb-hosted` (around line 884), add:

```css
  /* Tab-web active layout: host fills remaining space */
  main.main.tab-tool.tab-web-active {
    display: flex; flex-direction: column; overflow: hidden; padding-bottom: 0;
  }
  main.main.tab-tool.tab-web-active > #foxy-session {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    overflow: hidden; padding-bottom: 0;
  }
  #tab-web-host {
    flex: 1; min-height: 200px; border-radius: 8px; overflow: hidden;
  }
```

- [ ] **Step 3.4: Add sidebar collapse button HTML**

Find `</aside>` (line ~962). Replace it with:

```html
        <button id="sidebar-collapse-btn" class="sidebar-collapse" title="Collapse sidebar" aria-label="Collapse sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m15 18-6-6 6-6"/>
          </svg>
        </button>
      </aside>
```

- [ ] **Step 3.5: Quick visual check**

```bash
npm start
```

Open Nexus. The sidebar should look identical to before (collapse button is a small chevron at the bottom-left). No functionality yet — just CSS + HTML. Close the app.

---

## Task 4: Launcher — bounds management + renderToolSession orchestration

**Files:**
- Modify: `renderer/assets/launcher.js`

- [ ] **Step 4.1: Add `activeHostedSlug` and `sidebarCollapsed` to state**

Find the `let state = {` block (around line 18). Add two new fields after `lastNotifTs`:

```js
  activeHostedSlug: null,   // slug of the hosted view currently shown, or null
  sidebarCollapsed: false,
```

- [ ] **Step 4.2: Add `sendHostedBounds` helper**

Find the `function processStatusFor(slug)` definition (around line 96). Add the following block immediately BEFORE it:

```js
  let _boundsRaf = null;

  function sendHostedBounds(slug) {
    const hostEl = document.getElementById('tab-web-host');
    if (!hostEl) return;
    const r = hostEl.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    coveAPI.showTabWebView(slug, { x: r.x, y: r.y, width: r.width, height: r.height })
      .catch(() => {});
  }

  function scheduleBoundsUpdate(slug) {
    if (_boundsRaf) cancelAnimationFrame(_boundsRaf);
    _boundsRaf = requestAnimationFrame(() => {
      _boundsRaf = null;
      sendHostedBounds(slug);
    });
  }

  let _hostedRO = null; // active ResizeObserver for #tab-web-host

  function attachHostedRO(slug) {
    detachHostedRO();
    const hostEl = document.getElementById('tab-web-host');
    if (!hostEl) return;
    _hostedRO = new ResizeObserver(() => scheduleBoundsUpdate(slug));
    _hostedRO.observe(hostEl);
    sendHostedBounds(slug); // fire immediately
  }

  function detachHostedRO() {
    if (_hostedRO) { _hostedRO.disconnect(); _hostedRO = null; }
    if (_boundsRaf) { cancelAnimationFrame(_boundsRaf); _boundsRaf = null; }
  }
```

- [ ] **Step 4.3: Update `renderToolSession` to manage show/hide and `.tab-web-active`**

Find the `function renderToolSession()` or the inline section that sets `session.innerHTML`. The key area is in the tool session rendering where `sessionNote` is built and `session.innerHTML` is assigned.

Locate the line where `session.hidden = false;` and `mainEl.classList.add('tab-tool');` are called (around line 270–272). The full update for that function is below.

First, find the block starting with:
```js
    let sessionNote;
    if (isTabWeb && tabUrl) {
      sessionNote = `<p class="foxy-session-note foxy-tabweb-hosted">App UI is loading in Nexus…</p>`;
```

Replace the ENTIRE `sessionNote` assignment block with:

```js
    let sessionNote;
    const showHostedView = isTabWeb && !!tabUrl;
    if (showHostedView) {
      sessionNote = `<div id="tab-web-host"></div>`;
    } else if (isTabWeb && isRunning) {
      sessionNote = `<div class="foxy-tabweb-loading"><span class="foxy-tabweb-loading-text">Loading app UI…</span></div>`;
    } else if (openMode === 'tab-web' && tabFallback) {
      sessionNote = `<p class="foxy-session-note">App opened externally — it was unable to load inside Nexus.</p>`;
    } else {
      sessionNote = `<p class="foxy-session-note">The app runs as a separate window outside Cove Nexus. Switch to it in your OS taskbar to use it.</p>`;
    }
```

Then find the block right after `session.hidden = false;`:
```js
    session.hidden = false;
    mainEl.classList.add('tab-tool');
```

Replace that (and any immediately following related lines within this function scope) with:

```js
    session.hidden = false;
    mainEl.classList.add('tab-tool');
    mainEl.classList.toggle('tab-web-active', showHostedView);

    // Show or hide the hosted WebContentsView
    const prevSlug = state.activeHostedSlug;
    if (showHostedView) {
      if (prevSlug && prevSlug !== slug) {
        coveAPI.hideTabWebView(prevSlug).catch(() => {});
      }
      state.activeHostedSlug = slug;
      attachHostedRO(slug); // sets bounds immediately
    } else {
      if (prevSlug) {
        detachHostedRO();
        coveAPI.hideTabWebView(prevSlug).catch(() => {});
        state.activeHostedSlug = null;
      }
    }
```

- [ ] **Step 4.4: Handle the Home tab case in renderToolSession**

Find the section in `renderToolSession` that handles the Home tab (where `session.hidden = true` and `mainEl.classList.remove('tab-tool')` are set). This is the branch for non-tool tabs. It will look something like:

```js
    session.hidden = true;
    mainEl.classList.remove('tab-tool');
```

Add the hosted view teardown here too:

```js
    session.hidden = true;
    mainEl.classList.remove('tab-tool');
    mainEl.classList.remove('tab-web-active');
    if (state.activeHostedSlug) {
      detachHostedRO();
      coveAPI.hideTabWebView(state.activeHostedSlug).catch(() => {});
      state.activeHostedSlug = null;
    }
```

- [ ] **Step 4.5: Verify launcher.js syntax**

```bash
node --check renderer/assets/launcher.js
```
Expected: no output.

---

## Task 5: Sidebar collapse button handler

**Files:**
- Modify: `renderer/assets/launcher.js`

- [ ] **Step 5.1: Add collapse button click handler**

Find the init block at the bottom of launcher.js where other event listeners are wired (e.g., the `document.getElementById('foxy-session')?.addEventListener` block around line 292). After the existing foxy session click handler block, add:

```js
  document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    document.querySelector('.layout')?.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    // Bounds update is handled automatically by ResizeObserver on #tab-web-host
  });
```

- [ ] **Step 5.2: Verify launcher.js syntax**

```bash
node --check renderer/assets/launcher.js
```
Expected: no output.

---

## Task 6: Verify and commit

- [ ] **Step 6.1: Start Nexus and run manual sanity checks**

```bash
npm start
```

Manual checks (all must pass):

1. **Startup clean**: Nexus starts without errors. DevTools console is clean.
2. **Sidebar collapse**: Click the chevron button at the bottom of the sidebar. Sidebar collapses to ~48px (icons only). Chevron flips to point right.
3. **Sidebar expand**: Click the chevron again. Sidebar expands back to 240px. Navigation labels and counts re-appear.
4. **No hosted view by default**: Foxy Mode can be enabled. Existing apps launch externally. Switching tabs does not cause blank/ghost hosted content.
5. **External Foxy tabs**: Launch an external app in Foxy Mode. Its tab shows the session header + actions + "The app runs as a separate window…" note. Closing the tab does not kill the app.
6. **Foxy Mode off**: Toggling Foxy Mode off clears tabs. `state.activeHostedSlug` is null (no orphan view).
7. **Release/version cards**: Home tab still shows the featured card and programs grid. Version badges render correctly.
8. **No `.tab-web-active` on non-hosted tabs**: Open a non-tab-web Foxy tab. `main.main` should NOT have the `tab-web-active` class.

- [ ] **Step 6.2: Confirm no orphan views (code inspection)**

```bash
git grep -n "addChildView\|removeChildView\|childViews\|destroyHostedView\|cove:tab-web:show\|cove:tab-web:hide" -- main.js
```

Confirm:
- `addChildView` only in `cove:tab-web:show` handler
- `removeChildView` in `cove:tab-web:hide` handler AND in `destroyHostedView`
- `childViews.delete` in `destroyHostedView`, `cove:tab-web:hide` handler
- `childViews.add` only in `cove:tab-web:show` handler

- [ ] **Step 6.3: Check git status**

```bash
git status --short
git diff --check
```

Expected changed files:
- `M preload.js`
- `M main.js`
- `M renderer/index.html`
- `M renderer/assets/launcher.js`

- [ ] **Step 6.4: Summarize changes** (do not commit — user will decide)

Report:
- Files changed
- How attached view works: `cove:tab-web:show` flow
- How bounds update: ResizeObserver → `sendHostedBounds` → IPC → `view.setBounds`
- How sidebar collapse works
- What remains deferred

---

## What remains deferred before the first Cove app conversion

1. **Convert cove-meme-maker** (or chosen first app) — set `openMode: 'tab-web'` in programs.js, implement HTTP server + `tab_ready` in the app.
2. **Edge-to-edge layout** — current hosted view has 40px inset (matching session padding). May want edge-to-edge for immersive apps; can be adjusted when first real app is tested.
3. **DevTools for hosted view** — add a way to open DevTools on the hosted WebContentsView for debugging. Can be a dev-only keyboard shortcut in `createHostedView`.
4. **Window resize direct handler** — currently handled by ResizeObserver. If ResizeObserver fires after a visible flash, add a direct `window.addEventListener('resize', …)` fallback.
5. **Tab title from `status_update.label`** — currently shows app name. Phase 3 open question from spec.
6. **Process termination policy** — spec open question: destroy view + leave process vs. kill process on tab close. Current default is (a): destroy view, leave process.
7. **Sidebar collapse persistence** — `sidebarCollapsed` is not persisted to config. Can be added to preferences if needed.
8. **Accessibility** — sidebar collapse button needs `aria-expanded` state updates.
