# Foxy Mode v2 — Process Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add process lifecycle tracking to Cove Nexus so the Foxy Mode session page shows accurate running state and prevents duplicate launches.

**Architecture:** Main process owns a `processRegistry` Map that tracks spawned child processes through their full lifecycle. State is pushed to the renderer via `webContents.send` events; the renderer mirrors state in `state.processes` and renders it. The renderer never derives canonical status — it only displays what the main process tells it.

**Tech Stack:** Electron 33+, Node.js child_process, contextBridge IPC, vanilla JS renderer

**Spec:** `docs/superpowers/specs/2026-05-12-foxy-mode-v2-process-tracking-design.md`

---

## File map

| File | Change |
|------|--------|
| `main.js` | Add `processRegistry` Map, `serializeEntry`, `broadcastProcessUpdate`, `cove:process:list` handler; replace `cove:launch` handler |
| `preload.js` | Add `processList` and `onProcessUpdate` to `coveAPI` |
| `renderer/assets/launcher.js` | Add `state.processes`, helpers, init bootstrap, `doLaunch` guard, `renderToolSession` live UI, session click `'focus'` action, card running dot |
| `renderer/index.html` | Add CSS for `.foxy-pill` status variants and `.card-running-dot` |

No new files. No version bump. No changes to install/update/download paths.

---

## Task 1: Main process — process registry, helpers, and snapshot IPC

**Files:**
- Modify: `main.js` (before the `cove:launch` handler, ~line 1249)

### Steps

- [ ] **Step 1: Insert the registry and helpers into main.js**

  Find the line `ipcMain.handle('cove:launch', async (_e, slug) => {` (currently ~line 1249). Insert the following block **immediately before** that line:

  ```js
  // ── Process registry ──────────────────────────────────────────────────────
  // Main process is the sole source of truth for tool lifecycle state.
  // Renderer receives serialized snapshots only — child refs never cross IPC.

  const processRegistry = new Map();

  function serializeEntry(slug) {
    const e = processRegistry.get(slug);
    if (!e) return null;
    return {
      slug: e.slug,
      pid: e.pid ?? null,
      status: e.status,
      startedAt: e.startedAt,
      exitedAt: e.exitedAt ?? null,
      exitCode: e.exitCode ?? null,
      signal: e.signal ?? null,
      lastError: e.lastError ?? null,
      processUpdatedAt: e.processUpdatedAt,
    };
  }

  function broadcastProcessUpdate(slug, previousStatus) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('cove:process:update', {
      slug,
      previousStatus: previousStatus ?? null,
      state: serializeEntry(slug),
    });
  }

  ipcMain.handle('cove:process:list', () => {
    const out = {};
    for (const [slug] of processRegistry) out[slug] = serializeEntry(slug);
    return out;
  });

  ```

- [ ] **Step 2: Start the app to confirm no syntax errors**

  ```bash
  npm start
  ```

  Expected: app window opens normally. If it crashes, check the inserted block for typos.

- [ ] **Step 3: Commit**

  ```bash
  git add main.js
  git commit -m "feat(foxy-v2): add process registry, helpers, and cove:process:list IPC"
  ```

---

## Task 2: Main process — replace cove:launch handler

**Files:**
- Modify: `main.js` (the `cove:launch` handler, currently lines ~1249–1286)

### Steps

- [ ] **Step 1: Read the current handler before editing**

  Open `main.js` around line 1249. The current handler looks like:

  ```js
  ipcMain.handle('cove:launch', async (_e, slug) => {
    if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
    if (isLegacyClone(slug)) return { ok: false, error: '...' };

    const info = readRegistry()[slug];
    if (!info?.path) return { ok: false, error: 'Not installed.' };
    if (!exists(info.path)) return { ok: false, error: `Missing: ${info.path}` };

    const plan = planFromPath(info.path);
    const child = spawn(plan.cmd, plan.args, {
      cwd: path.dirname(info.path),
      detached: true,
      stdio: 'ignore',
      env: buildLaunchEnv(),
    });
    child.unref();
    return await new Promise((resolve) => {
      let settled = false;
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: String(err?.message || err) });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (readConfig().closeAfterLaunch && mainWindow) mainWindow.hide();
        resolve({ ok: true, kind: plan.kind });
      }, 600);
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  });
  ```

- [ ] **Step 2: Replace the entire cove:launch handler**

  Replace the full handler (from `ipcMain.handle('cove:launch'` through the closing `});`) with:

  ```js
  ipcMain.handle('cove:launch', async (_e, slug) => {
    if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
    if (isLegacyClone(slug)) return { ok: false, error: 'This install is from an older version. Click Update to reinstall as a binary.' };

    // Nonce guard: prevent duplicate spawns. Fires before any async work so
    // rapid double-clicks resolved by the registry, not by the busy flag alone.
    const existing = processRegistry.get(slug);
    if (existing && (existing.status === 'launching' || existing.status === 'running')) {
      return { ok: true, alreadyRunning: true, kind: 'app' };
    }

    const info = readRegistry()[slug];
    if (!info?.path) return { ok: false, error: 'Not installed.' };
    if (!exists(info.path)) return { ok: false, error: `Missing: ${info.path}` };

    // Mark launching immediately — before spawn — so any concurrent IPC call
    // hits the nonce guard above.
    const now = Date.now();
    processRegistry.set(slug, {
      slug, child: null, pid: null, status: 'launching',
      startedAt: now, exitedAt: null, exitCode: null,
      signal: null, lastError: null, processUpdatedAt: now,
    });
    broadcastProcessUpdate(slug, null);

    try {
      const plan = planFromPath(info.path);
      const child = spawn(plan.cmd, plan.args, {
        cwd: path.dirname(info.path),
        detached: true,
        stdio: 'ignore',
        env: buildLaunchEnv(),
      });

      // Store child ref so GC doesn't collect it before exit fires.
      processRegistry.get(slug).child = child;

      // Exit listener — covers both normal close and crash.
      // 'failed' status from the error handler is not overwritten.
      child.once('exit', (code, signal) => {
        const prev = processRegistry.get(slug);
        if (!prev || prev.status === 'failed') return;
        const prevStatus = prev.status;
        processRegistry.set(slug, {
          ...prev,
          child: null,
          status: 'exited',
          exitCode: code ?? null,
          signal: signal ?? null,
          exitedAt: Date.now(),
          processUpdatedAt: Date.now(),
        });
        broadcastProcessUpdate(slug, prevStatus);
      });

      // Unref after listeners are attached so child outlives Nexus but
      // exit/error events still reach us while the event loop is running.
      child.unref();

      // Let the OS surface ENOENT/EACCES synchronously before reporting success.
      return await new Promise((resolve) => {
        let settled = false;

        child.once('error', (err) => {
          if (settled) return;
          settled = true;
          const prev = processRegistry.get(slug);
          const prevStatus = prev?.status ?? null;
          processRegistry.set(slug, {
            ...(prev ?? { slug }),
            child: null,
            status: 'failed',
            lastError: String(err?.message || err),
            exitedAt: Date.now(),
            processUpdatedAt: Date.now(),
          });
          broadcastProcessUpdate(slug, prevStatus);
          resolve({ ok: false, error: String(err?.message || err) });
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          const prev = processRegistry.get(slug);
          const prevStatus = prev?.status ?? null;
          // Only transition if still launching (process may have exited <600ms).
          if (prev?.status === 'launching') {
            processRegistry.set(slug, {
              ...prev,
              pid: child.pid ?? null,
              status: 'running',
              processUpdatedAt: Date.now(),
            });
            broadcastProcessUpdate(slug, prevStatus);
          }
          // Guard: do not hide Nexus while Foxy Mode is on.
          if (readConfig().closeAfterLaunch && !readConfig().foxyMode && mainWindow) mainWindow.hide();
          resolve({ ok: true, kind: plan.kind });
        }, 600);
      });
    } catch (err) {
      const prev = processRegistry.get(slug);
      const prevStatus = prev?.status ?? null;
      processRegistry.set(slug, {
        ...(prev ?? { slug }),
        child: null,
        status: 'failed',
        lastError: String(err?.message || err),
        exitedAt: Date.now(),
        processUpdatedAt: Date.now(),
      });
      broadcastProcessUpdate(slug, prevStatus);
      return { ok: false, error: String(err?.message || err) };
    }
  });
  ```

- [ ] **Step 3: Start the app and verify launch still works**

  ```bash
  npm start
  ```

  With Foxy Mode OFF: launch a tool, confirm it opens and the launcher behaves as before.
  With Foxy Mode ON: launch a tool, confirm the tab appears and the window is not hidden.

- [ ] **Step 4: Commit**

  ```bash
  git add main.js
  git commit -m "feat(foxy-v2): process registry lifecycle tracking in cove:launch"
  ```

---

## Task 3: Preload — expose processList and onProcessUpdate

**Files:**
- Modify: `preload.js`

### Steps

- [ ] **Step 1: Find the onInstallProgress entry in preload.js**

  The relevant section looks like (around lines 23–28):

  ```js
    onInstallProgress: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('cove:install:progress', h);
      return () => ipcRenderer.removeListener('cove:install:progress', h);
    },
  ```

- [ ] **Step 2: Add processList and onProcessUpdate after onInstallProgress**

  Insert immediately after the closing `,` of `onInstallProgress`:

  ```js
    processList: () => ipcRenderer.invoke('cove:process:list'),
    onProcessUpdate: (cb) => {
      const h = (_e, payload) => cb(payload);
      ipcRenderer.on('cove:process:update', h);
      return () => ipcRenderer.removeListener('cove:process:update', h);
    },
  ```

- [ ] **Step 3: Start the app to confirm no preload errors**

  ```bash
  npm start
  ```

  Open DevTools console. If `coveAPI.processList` is undefined, the insertion point was wrong.

- [ ] **Step 4: Commit**

  ```bash
  git add preload.js
  git commit -m "feat(foxy-v2): expose processList and onProcessUpdate in coveAPI"
  ```

---

## Task 4: Renderer — state extension and process status helpers

**Files:**
- Modify: `renderer/assets/launcher.js`

### Steps

- [ ] **Step 1: Add processes to the state object**

  Find the `let state = {` block (around line 18). It currently ends with:

  ```js
    foxyMode: false,
    tabs: [],
    activeTabId: 'home',
  };
  ```

  Add `processes: {}` as the last entry:

  ```js
    foxyMode: false,
    tabs: [],
    activeTabId: 'home',
    processes: {},
  };
  ```

- [ ] **Step 2: Add processStatusFor and displayStatusFor helpers**

  Find the `// ── Foxy Mode helpers` comment block (around line 43). After the last function in that block (`closeTab`, which ends around line 82), insert:

  ```js
  function processStatusFor(slug) {
    return state.processes[slug]?.status ?? 'not_running';
  }

  // Maps canonical lifecycle state to a UI label.
  // 'exited' renders as "Not running" so closed apps feel cleanly stopped.
  function displayStatusFor(slug) {
    const s = processStatusFor(slug);
    if (s === 'running')   return 'Running';
    if (s === 'launching') return 'Launching';
    if (s === 'failed')    return 'Failed';
    return 'Not running';
  }
  ```

- [ ] **Step 3: Start and confirm no JS errors in DevTools**

  ```bash
  npm start
  ```

  Open DevTools → Console. No errors expected.

- [ ] **Step 4: Commit**

  ```bash
  git add renderer/assets/launcher.js
  git commit -m "feat(foxy-v2): add state.processes and processStatusFor/displayStatusFor helpers"
  ```

---

## Task 5: Renderer — init bootstrap and onProcessUpdate subscription

**Files:**
- Modify: `renderer/assets/launcher.js` (the `init()` function, ~line 1476)

### Steps

- [ ] **Step 1: Find the IS_DESKTOP block inside init()**

  The current init has this structure:

  ```js
  async function init() {
    if (IS_DESKTOP) {
      try {
        const [info, quickState, cfg] = await Promise.all([
          coveAPI.appInfo(),
          coveAPI.getState(),
          coveAPI.config.get(),
        ]);
        // ... populate state from cfg ...
        if (cfg.foxyMode) {
          state.foxyMode = true;
          // ...
        }
      } catch {}
    }
    render();
    // ... slow path ...
  }
  ```

- [ ] **Step 2: Add bootstrap and subscription after the existing IS_DESKTOP try/catch**

  Insert immediately after the closing `}` of the first `if (IS_DESKTOP) { try { ... } catch {} }` block, before `render()`:

  ```js
    if (IS_DESKTOP) {
      try {
        const snapshot = await coveAPI.processList();
        if (snapshot && typeof snapshot === 'object') state.processes = snapshot;
      } catch {}
      coveAPI.onProcessUpdate(({ slug, state: s } = {}) => {
        if (slug && s && typeof s === 'object') {
          state.processes[slug] = s;
          render();
          renderToolSession();
        }
      });
    }
  ```

  > Note: The destructuring default `= {}` makes the handler null-safe against malformed payloads.

- [ ] **Step 3: Start and verify bootstrap works**

  ```bash
  npm start
  ```

  Launch a tool with Foxy Mode ON. Open DevTools and run:
  ```js
  state.processes
  ```
  You should see an entry for the launched tool slug with `status: 'running'` after ~600ms.
  (Access state via the global if exposed, or add a temporary `window._state = state;` for debugging — remove it after.)

- [ ] **Step 4: Commit**

  ```bash
  git add renderer/assets/launcher.js
  git commit -m "feat(foxy-v2): bootstrap process state from main on init and subscribe to push updates"
  ```

---

## Task 6: Renderer — doLaunch alreadyRunning guard

**Files:**
- Modify: `renderer/assets/launcher.js` (the `doLaunch` function, ~line 545)

### Steps

- [ ] **Step 1: Find the doLaunch function**

  The current relevant section:

  ```js
  async function doLaunch(prog) {
    const slug = prog.slug;
    if (state.busy[slug]) return;
    state.busy[slug] = 'launching';
    render();
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.launch(slug);
        if (!res.ok) throw new Error(res.error || 'launch failed');
        toast(`${prog.name} launched (${res.kind})`);
      } else {
        await new Promise(r => setTimeout(r, 900));
      }
      if (state.foxyMode) { ensureTab(prog); }
    } catch (e) {
      toast(`Launch failed: ${e.message}`, 'error');
    } finally {
      state.busy[slug] = null;
      render();
    }
  }
  ```

- [ ] **Step 2: Add alreadyRunning handling inside the IS_DESKTOP block**

  Replace only the inner `IS_DESKTOP` branch:

  ```js
  async function doLaunch(prog) {
    const slug = prog.slug;
    if (state.busy[slug]) return;
    state.busy[slug] = 'launching';
    render();
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.launch(slug);
        if (res.alreadyRunning) {
          if (state.foxyMode) ensureTab(prog);
          toast(`${prog.name} is already running.`);
          return;
        }
        if (!res.ok) throw new Error(res.error || 'launch failed');
        toast(`${prog.name} launched (${res.kind})`);
      } else {
        await new Promise(r => setTimeout(r, 900));
      }
      if (state.foxyMode) { ensureTab(prog); }
    } catch (e) {
      toast(`Launch failed: ${e.message}`, 'error');
    } finally {
      state.busy[slug] = null;
      render();
    }
  }
  ```

  The `finally` block still clears `busy` and calls `render()` on all paths including the early return.

- [ ] **Step 3: Start and test duplicate launch prevention**

  ```bash
  npm start
  ```

  With Foxy Mode ON: launch a tool. While it's running, click Launch again (from the session page or the main grid). Expected: toast "already running", no duplicate process spawned.

- [ ] **Step 4: Commit**

  ```bash
  git add renderer/assets/launcher.js
  git commit -m "feat(foxy-v2): handle alreadyRunning response in doLaunch"
  ```

---

## Task 7: Renderer — renderToolSession live status UI and Focus App

**Files:**
- Modify: `renderer/assets/launcher.js` (the `renderToolSession` function, ~line 101)

### Steps

- [ ] **Step 1: Find the badges array and launch label in renderToolSession**

  Current badges block (~lines 135–145):

  ```js
  const badges = [
    installed
      ? `<span class="foxy-pill installed">Installed${version ? ' ' + version : ''}</span>`
      : `<span class="foxy-pill">Not installed</span>`,
    update
      ? `<span class="foxy-pill update">Update available${latestTag ? ' v' + latestTag : ''}</span>`
      : '',
    installed
      ? `<span class="foxy-pill running">Running</span>`
      : '',
  ].filter(Boolean).join('');

  const launchLabel = busy === 'launching' ? 'Launching…'
    : busy === 'installing' ? 'Installing…'
    : !installed ? 'Install & Launch'
    : 'Launch';
  const launchAction = !installed ? 'install' : 'launch';
  ```

- [ ] **Step 2: Replace the badges and launch label blocks**

  Replace everything from `const badges = [` through `const launchAction = ...;` with:

  ```js
  const procStatus = processStatusFor(prog.slug);
  const procCssClass = procStatus.replace(/_/g, '-'); // 'not_running' → 'not-running'

  const badges = [
    installed
      ? `<span class="foxy-pill installed">Installed${version ? ' ' + version : ''}</span>`
      : `<span class="foxy-pill">Not installed</span>`,
    update
      ? `<span class="foxy-pill update">Update available${latestTag ? ' v' + latestTag : ''}</span>`
      : '',
    installed
      ? `<span class="foxy-pill ${procCssClass}">${displayStatusFor(prog.slug)}</span>`
      : '',
  ].filter(Boolean).join('');

  const isRunning   = procStatus === 'running';
  const isLaunching = procStatus === 'launching' || busy === 'launching';

  // Priority: installing > launching > not-installed > running > default
  const launchLabel = busy === 'installing' ? 'Installing…'
    : isLaunching ? 'Launching…'
    : !installed ? 'Install & Launch'
    : isRunning ? 'Focus App'
    : 'Launch';
  const launchAction = !installed ? 'install' : isRunning ? 'focus' : 'launch';
  const launchDisabled = isLaunching || busy === 'installing';
  ```

- [ ] **Step 3: Update the button markup to use launchDisabled**

  Find the session action button in the `session.innerHTML` template string:

  ```js
  <button class="btn btn-primary" data-action="${launchAction}" data-slug="${slug}"${busy ? ' disabled' : ''}>
  ```

  Replace `${busy ? ' disabled' : ''}` with `${launchDisabled ? ' disabled' : ''}`:

  ```js
  <button class="btn btn-primary" data-action="${launchAction}" data-slug="${slug}"${launchDisabled ? ' disabled' : ''}>
  ```

- [ ] **Step 4: Add 'focus' action to the session click handler**

  Find the session delegated click handler (~line 196):

  ```js
  if (action === 'launch') doLaunch(prog);
  else if (action === 'install') doInstall(prog);
  else if (action === 'update') doUpdate(prog);
  else if (action === 'reveal' && IS_DESKTOP) coveAPI.revealInstall(prog.slug);
  ```

  Add the `'focus'` case before `'launch'`:

  ```js
  if (action === 'focus') {
    // v2: conservative focus — no OS-level window focus hacks yet.
    if (state.foxyMode) ensureTab(prog);
    toast(`${prog.name} is already running.`);
  }
  else if (action === 'launch') doLaunch(prog);
  else if (action === 'install') doInstall(prog);
  else if (action === 'update') doUpdate(prog);
  else if (action === 'reveal' && IS_DESKTOP) coveAPI.revealInstall(prog.slug);
  ```

- [ ] **Step 5: Start and verify session page live states**

  ```bash
  npm start
  ```

  With Foxy Mode ON:
  - Launch a tool. Session page should show **"Launching"** pill → then **"Running"** pill after ~600ms.
  - Primary button should show **"Focus App"** when running.
  - Click **"Focus App"**: toast appears, no new process. Session page stays on the tool tab.
  - Close the external app (from OS). Session page should show **"Not running"** within a second.
  - Primary button returns to **"Launch"**.

- [ ] **Step 6: Commit**

  ```bash
  git add renderer/assets/launcher.js
  git commit -m "feat(foxy-v2): renderToolSession live process status and Focus App action"
  ```

---

## Task 8: Renderer — card running dot

**Files:**
- Modify: `renderer/assets/launcher.js` (the `card()` function, ~line 370)

### Steps

- [ ] **Step 1: Find the card article markup in the card() function**

  The card template (~line 376):

  ```js
  return `
    <article class="card ${update ? 'pending' : ''} ${bookmarked ? 'bookmarked' : ''}" data-slug="${escapeAttr(p.slug)}" draggable="${reorderEnabled() ? 'true' : 'false'}">
      <div class="card-top">
        <div class="app-icon">${iconFor(p.icon)}</div>
        ...
  ```

- [ ] **Step 2: Add the running dot to the card-top div**

  Add a `processStatusFor` call and inject the dot inside the `card-top` div, before `<div class="app-icon">`:

  ```js
  const cardRunning = state.foxyMode && processStatusFor(p.slug) === 'running';

  return `
    <article class="card ${update ? 'pending' : ''} ${bookmarked ? 'bookmarked' : ''}" data-slug="${escapeAttr(p.slug)}" draggable="${reorderEnabled() ? 'true' : 'false'}">
      <div class="card-top">
        ${cardRunning ? '<span class="card-running-dot" aria-label="Running" title="Running"></span>' : ''}
        <div class="app-icon">${iconFor(p.icon)}</div>
        ...
  ```

  Insert the `const cardRunning = ...` line at the very top of the return block, just before `return \``.

- [ ] **Step 3: Start and verify the dot appears only when appropriate**

  ```bash
  npm start
  ```

  With Foxy Mode ON, launch a tool. The grid card for that tool should show a small dot (after CSS is added in Task 9 — the span is in the DOM but invisible until then).
  With Foxy Mode OFF, no dot should appear.
  Tools that are NOT running should not show a dot.
  Grid primary button labels should remain "Launch" in all cases.

- [ ] **Step 4: Commit**

  ```bash
  git add renderer/assets/launcher.js
  git commit -m "feat(foxy-v2): add running dot to grid cards when Foxy Mode is on"
  ```

---

## Task 9: HTML/CSS — pill status variants and card running dot

**Files:**
- Modify: `renderer/index.html`

### Steps

- [ ] **Step 1: Find the existing foxy-pill CSS**

  Current block (~line 818–826):

  ```css
  .foxy-pill {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 20px; font-size: 0.6875rem; font-weight: 500;
    border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-dim);
  }
  .foxy-pill.installed { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); }
  .foxy-pill.update    { background: color-mix(in srgb, #f59e0b 12%, transparent); border-color: color-mix(in srgb, #f59e0b 30%, transparent); color: #f59e0b; }
  .foxy-pill.running   { background: color-mix(in srgb, #22c55e 12%, transparent); border-color: color-mix(in srgb, #22c55e 30%, transparent); color: #22c55e; }
  ```

- [ ] **Step 2: Add status pill variants after the .foxy-pill.running line**

  Append immediately after `.foxy-pill.running { ... }`:

  ```css
  .foxy-pill.launching  { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); opacity: 0.7; }
  .foxy-pill.not-running,
  .foxy-pill.exited     { background: var(--surface-2); border-color: var(--border); color: var(--text-faint); }
  .foxy-pill.failed     { background: color-mix(in srgb, #ef4444 10%, transparent); border-color: color-mix(in srgb, #ef4444 25%, transparent); color: #ef4444; }
  ```

  > Note: `not-running` is the catch-all CSS class for unknown/exited states. `exited` is added as a synonym for safety since the registry value is `'exited'` but the CSS class is set to the return of `processStatusFor()`.

- [ ] **Step 3: Add card-running-dot CSS**

  Find a good anchor point — the `.card` rules or the area near `.card-top`. Add near the card section (search for `.card {` or `.card-top`):

  ```css
  .card { position: relative; }
  .card-running-dot {
    position: absolute; top: 8px; right: 8px;
    width: 6px; height: 6px; border-radius: 50%;
    background: #22c55e;
    pointer-events: none;
  }
  body:not([data-foxy]) .card-running-dot { display: none; }
  ```

  > No animation — subtle indicator only. The `pointer-events: none` ensures the dot doesn't interfere with clicks. If `.card` already has `position: relative`, omit that line.

- [ ] **Step 4: Start and visually confirm all states**

  ```bash
  npm start
  ```

  Check:
  - Running tool session page: green "Running" pill, "Focus App" button
  - Exited tool session page: muted "Not running" pill, "Launch" button
  - Launching tool session page: faded accent "Launching" pill, button disabled
  - Running tool grid card: small green dot at top-right (Foxy Mode ON only)
  - Foxy Mode OFF: no dot visible anywhere

- [ ] **Step 5: Commit**

  ```bash
  git add renderer/index.html
  git commit -m "feat(foxy-v2): add pill status variants and card running dot CSS"
  ```

---

## Task 10: Storybloq — create T-002 and snapshot

**Steps**

- [ ] **Step 1: Create T-002 in Storybloq**

  Call `storybloq_ticket_create` with:
  ```
  title: "Foxy Mode v2 — process tracking / running state"
  type: "feature"
  phase: "features"
  description: "Add process lifecycle tracking to Cove Nexus Foxy Mode. Main process owns a processRegistry Map; renderer mirrors state via push IPC events. Adds duplicate launch prevention, live status pills on the session page (Running / Launching / Not running / Failed), 'Focus App' conservative action, and a subtle running dot on grid cards. Scope: main.js, preload.js, launcher.js, index.html only. Deferred: OS focus hacks, tab persistence, multi-instance awareness."
  ```

- [ ] **Step 2: Mark T-002 as complete**

  Call `storybloq_ticket_update` with `id: "T-002"` and `status: "complete"`.

- [ ] **Step 3: Take a snapshot**

  Call `storybloq_snapshot`.

---

## Task 11: Full verification

**Steps**

- [ ] **Step 1: Run git checks**

  ```bash
  git status --short
  git diff --check
  ```

  Expected: clean working tree, no whitespace errors.

- [ ] **Step 2: Run targeted grep to confirm all v2 symbols are present**

  ```bash
  git grep -n "processRegistry\|broadcastProcessUpdate\|serializeEntry\|cove:process:list\|cove:process:update\|processList\|onProcessUpdate\|processStatusFor\|displayStatusFor\|alreadyRunning\|Focus App\|card-running-dot\|not-running\|foxy-pill.launching\|foxy-pill.failed" \
    -- main.js preload.js renderer/assets/launcher.js renderer/index.html
  ```

  Expected: all symbols appear in the expected files.

- [ ] **Step 3: Run targeted grep to confirm no v3+ deferred items slipped in**

  ```bash
  git grep -n "wmctrl\|xdotool\|PowerShell\|BrowserWindow.*embed\|reparent\|persistTab" \
    -- main.js renderer/assets/launcher.js
  ```

  Expected: no matches.

- [ ] **Step 4: Start the app and run the manual checklist**

  ```bash
  npm start
  ```

  Work through this checklist manually:

  - [ ] Foxy Mode OFF: tools launch normally
  - [ ] Foxy Mode OFF: `closeAfterLaunch` still hides Nexus after launch
  - [ ] Foxy Mode ON: `closeAfterLaunch` does NOT hide Nexus after launch
  - [ ] Foxy Mode ON: Home tab is present on window open
  - [ ] Launching a tool creates/activates one Foxy tab
  - [ ] Launching the same running tool: no duplicate process, toast "already running", tab activated
  - [ ] Running tool session page: "Running" pill, "Focus App" button
  - [ ] Clicking "Focus App": toast shown, no new process started, Nexus stays on tool tab
  - [ ] External app exits normally: tab preserved, session page shows "Not running", button returns to "Launch"
  - [ ] Closing a Foxy tab: external app is NOT killed (verify via OS task manager)
  - [ ] Grid card: small green dot visible for running tool (Foxy Mode ON)
  - [ ] Grid card: dot NOT visible when Foxy Mode is OFF
  - [ ] Grid card: dot NOT visible for tools that are NOT running
  - [ ] Grid card: "Launch" label unchanged regardless of running state
  - [ ] Featured section: no label changes
  - [ ] Light mode: pills and dot render correctly
  - [ ] Dark mode: pills and dot render correctly
