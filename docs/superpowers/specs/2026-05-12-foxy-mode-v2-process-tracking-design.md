# Foxy Mode v2 — Process Tracking Design

**Date:** 2026-05-12  
**Status:** Approved for implementation  
**Scope:** Process lifecycle tracking and running-state UI for tools launched by Cove Nexus

---

## Context

Foxy Mode v1 (shipped in commits `ffa5420`, `d343432`) adds browser-style tool tabs to the
Cove Nexus launcher. The main process spawns tools as detached child processes and immediately
calls `child.unref()`, losing all reference to their lifecycle. The renderer tracks only a
transient `state.busy[slug]` that clears once the 600 ms IPC timeout resolves. There is no
running state, no duplicate-launch prevention, and no feedback when a tool exits.

v2 adds a focused process-tracking layer on top of v1 without changing launcher architecture,
install/update behavior, or window embedding.

---

## Scope

**In scope:**
- Process registry in the main process (slug → lifecycle entry)
- Push-based process state updates to the renderer via `webContents.send`
- Bootstrap snapshot API (`cove:process:list`) for renderer init/reload resilience
- Duplicate launch prevention with structured IPC response
- Running-state UI on the Foxy session/tool tab page (the "live surface")
- Subtle running indicator on grid cards when Foxy Mode is on
- Fix `closeAfterLaunch` to not hide Nexus when Foxy Mode is on
- "Focus App" as a conservative UI-level action (no OS focus tricks)
- Optional: toast notification when a running tool exits

**Explicitly deferred (v3+):**
- OS-level window focus (wmctrl, xdotool, PowerShell)
- Tab persistence across restarts
- Multi-instance awareness
- Native app embedding or OS window reparenting
- Cove app protocol layer
- Plugin-style embedded apps
- Version bump (not part of this patch)

---

## Architecture

### Principle: main process is the sole source of truth

All state transitions happen in the main process. The renderer mirrors state and renders it.
The renderer never derives canonical status from its own observations.

### Process registry

```
processRegistry: Map<slug, RegistryEntry>

RegistryEntry {
  child:           ChildProcess | null   // cleared after exit/error; null-safe
  pid:             number | null         // preserved after exit (lastKnownPid)
  slug:            string
  status:          'launching' | 'running' | 'exited' | 'failed'
  startedAt:       number                // Date.now() at spawn
  exitedAt:        number | null
  exitCode:        number | null
  signal:          string | null
  lastError:       string | null
  processUpdatedAt: number               // Date.now() on every transition
}
```

**`status` semantics:**
- `launching` — IPC call accepted, spawn in progress, before 600 ms timeout
- `running` — 600 ms passed with no error, process assumed healthy
- `exited` — process exited normally (ordinary close by the user)
- `failed` — spawn error (`ENOENT`, `EACCES`, etc.) or runtime error event before running

`exited` means the user closed the tool. `failed` means it never ran or crashed at spawn time.
Do not use `failed` for normal app termination.

### Serialization

`serializeEntry(slug)` produces a plain object safe for IPC (omits `child`):

```js
{ slug, pid, status, startedAt, exitedAt, exitCode, signal, lastError, processUpdatedAt }
```

### Event payload

```js
{
  slug: string,
  previousStatus: string | null,
  state: SerializedEntry        // null-safe; renderer treats missing fields as null
}
```

---

## Main process changes (`main.js`)

### Module-level

```js
const processRegistry = new Map();
```

### `broadcastProcessUpdate(slug, previousStatus)`

```js
function broadcastProcessUpdate(slug, previousStatus) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('cove:process:update', {
    slug,
    previousStatus: previousStatus ?? null,
    state: serializeEntry(slug),
  });
}
```

### Modified `cove:launch` handler

Sequence:

1. **Validate** slug and path (unchanged).
2. **Nonce/race guard:** if `processRegistry.has(slug)` and status is `'launching'` or
   `'running'`, return `{ ok: true, alreadyRunning: true, kind: 'app' }` immediately. No spawn.
   This guard fires even before any async work, preventing race-condition duplicates on
   rapid double-clicks.
3. **Mark launching:** set registry entry `{ slug, status: 'launching', startedAt: Date.now(),
   processUpdatedAt: Date.now(), pid: null, child: null, ... }`. Broadcast immediately.
4. **Spawn** with same options as today (`detached: true, stdio: 'ignore', env: buildLaunchEnv()`).
5. **`child.unref()`** — still called so the child outlives Nexus exit. The reference is kept
   in the registry (not GC'd), so exit/error events still fire.
6. **Attach `child.once('error', ...)`:**
   - Update registry: `status: 'failed'`, `lastError: err.message`, `exitedAt: Date.now()`,
     `processUpdatedAt: Date.now()`, `child: null`.
   - Broadcast.
   - Resolve `{ ok: false, error: ... }` as today.
7. **Attach `child.once('exit', (code, signal) => ...)`:**
   - Update registry: `status: 'exited'`, `exitCode: code`, `signal`, `exitedAt: Date.now()`,
     `processUpdatedAt: Date.now()`, `child: null`. **`pid` is preserved** (lastKnownPid).
   - Broadcast.
   - Optional: also trigger a renderer-level toast event `cove:process:exit-toast` with slug.
8. **600 ms timeout:** if not settled by error, transition `'launching' → 'running'`:
   - Update registry: `status: 'running'`, `pid: child.pid`, `processUpdatedAt: Date.now()`.
   - Broadcast.
   - **`closeAfterLaunch` guard:** `if (readConfig().closeAfterLaunch && !readConfig().foxyMode && mainWindow) mainWindow.hide();`
   - Resolve `{ ok: true, kind: plan.kind }`.

### New `cove:process:list` handler

```js
ipcMain.handle('cove:process:list', () => {
  const out = {};
  for (const [slug] of processRegistry) out[slug] = serializeEntry(slug);
  return out;
});
```

Returns a snapshot for bootstrap. Not a polling API.

---

## Preload changes (`preload.js`)

Two new top-level entries in `coveAPI`, alongside `onInstallProgress` and `onTrayCheckUpdates`:

```js
processList: () => ipcRenderer.invoke('cove:process:list'),
onProcessUpdate: (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on('cove:process:update', h);
  return () => ipcRenderer.removeListener('cove:process:update', h);
},
```

Pattern mirrors `onInstallProgress`. Subscribe once during `init()`, unsubscribe on teardown
if applicable.

---

## Renderer state (`launcher.js`)

### State extension

```js
processes: {},  // { [slug]: SerializedEntry } — mirrored from main
```

### Helpers

```js
function processStatusFor(slug) {
  return state.processes[slug]?.status ?? 'not_running';
}

// Maps canonical lifecycle state → display label
function displayStatusFor(slug) {
  const s = processStatusFor(slug);
  if (s === 'running')   return 'Running';
  if (s === 'launching') return 'Launching';
  if (s === 'failed')    return 'Failed';
  return 'Not running';  // covers 'exited', 'not_running', unknown
}
```

`displayStatusFor` is the only function that collapses state into UI labels. The raw
`processStatusFor` is used for action logic.

### `init()`

1. `const snapshot = await coveAPI.processList(); state.processes = snapshot ?? {};`
2. `coveAPI.onProcessUpdate(({ slug, state: s }) => { if (slug && s) state.processes[slug] = s; render(); });`

Both calls happen once during init. After bootstrap, state is maintained exclusively via push
events.

### `doLaunch` change

```js
if (res.alreadyRunning) {
  ensureTab(prog);
  toast(`${prog.name} is already running.`);
  return;
}
```

### `renderToolSession` (Foxy session page — live surface)

Status pill shows `displayStatusFor(slug)` with matching CSS class (`.running`, `.launching`,
`.not-running`, `.failed`).

Primary action button:
- `'running'` → label "Focus App", action `'focus'`
- `'launching'` → label "Launching…", disabled
- default (`'exited'`, `'failed'`, `'not_running'`) → label "Launch", action `'launch'`

**`'focus'` action handler:**

Conservative — no OS focus tricks in v2:
1. Call `ensureTab(prog)` (keep Nexus on the tool tab).
2. Show toast: `"${prog.name} is already running."` (or a status line in the session page).

This is intentionally conservative. v2 Focus App means: prevent duplicate launch + surface the
Foxy tab. OS-level window raising is a v3+ concern.

### Optional: exit toast

If the optional exit toast is implemented, listen for `cove:process:exit-toast` in `init()`:
```js
coveAPI.onProcessExitToast?.(({ slug }) => {
  const prog = window.PROGRAMS.find(p => p.slug === slug);
  if (prog) toast(`${prog.name} closed.`);
});
```

Mark as optional — skip if it adds noise.

### `card()` (grid — stable)

- Keep "Launch" label. No `primaryButton` change.
- Add running indicator when `state.foxyMode && processStatusFor(p.slug) === 'running'`:
  ```html
  <span class="card-running-dot" aria-label="Running"></span>
  ```
  Injected into card markup alongside existing badge area. Hidden via CSS when Foxy off.

### `renderFeatured()` and `primaryButton()`

No changes.

---

## HTML/CSS (`renderer/index.html`)

### Session page status pills

Extend `.foxy-pill` with state variants:
```css
.foxy-pill.running   { /* existing green */ }
.foxy-pill.launching { color: var(--accent); opacity: 0.7; }
.foxy-pill.not-running { color: var(--text-muted); }
.foxy-pill.failed    { color: var(--error); }
```

### Card running dot

```css
.card-running-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  /* no animation — subtle only, avoid gaming-launcher vibes */
}

body:not([data-foxy]) .card-running-dot {
  display: none;
}
```

---

## Foxy Mode OFF behavior

- Process registry operates internally regardless of Foxy Mode state.
- No tab, no session page, no running dot is visible.
- `closeAfterLaunch` works normally (hide only when `!foxyMode`).
- Normal duplicate-launch prevention still applies at the IPC level.

---

## Storybloq

Create ticket **T-002: Foxy Mode v2 — process tracking / running state** in the `features` phase.

---

## Verification checklist

```
git status --short
git diff --check
npm start

git grep -n "foxyMode\|foxy-tab\|Focus App\|Not running\|running" \
  -- main.js renderer/index.html renderer/assets/launcher.js
```

Manual:
- [ ] Foxy Mode OFF: tools launch normally, `closeAfterLaunch` hides Nexus
- [ ] Foxy Mode ON: `closeAfterLaunch` does not hide Nexus
- [ ] Foxy Mode ON: Home tab present at launch
- [ ] Launching a tool creates/activates one tab
- [ ] Launching the same running tool: no duplicate process, toast shown, tab activated
- [ ] Running tool session page: shows "Running" pill and "Focus App" button
- [ ] Clicking "Focus App": toast shown, no new process
- [ ] External app exits: tab preserved, session page shows "Not running"
- [ ] Closing a Foxy tab: external app is NOT killed
- [ ] Grid card: subtle running dot visible when tool is running (Foxy on)
- [ ] Grid card: "Launch" label unchanged regardless of running state
- [ ] Featured section: labels unchanged
- [ ] Theme: dark/light parity on pills and dot
