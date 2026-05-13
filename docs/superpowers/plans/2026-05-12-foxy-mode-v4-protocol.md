# Foxy Mode v4 — Cove App Protocol Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the optional Cove app protocol foundation for Foxy Mode v4 — Unix domain socket server, NDJSON message handling, protocol state in processRegistry, and renderer UI enrichment — without changing any existing launch, install, update, or v1/v2/v3 behavior.

**Architecture:** Main process creates a per-launch Unix socket, injects `COVE_NEXUS_*` env vars into spawned apps, parses inbound NDJSON messages into `processRegistry[slug].protocol`, and broadcasts updates via the existing `cove:process:update` channel. Renderer enriches the Foxy session panel when `protocol` is non-null, using only existing IPC. No new preload API. Protocol is entirely optional — apps that ignore it see unchanged v2 behavior.

**Tech Stack:** Node.js `net` module (Unix sockets), NDJSON framing, `crypto.randomUUID()`, XDG_RUNTIME_DIR, `fs.mkdtemp`, Electron IPC (`cove:process:update`), vanilla JS renderer DOM manipulation.

---

## File Map

| File | Change |
|---|---|
| `main.js` | Add `net`, `crypto` top-level requires; constants; pure helpers; socket server infrastructure; protocol message handler; wire into `cove:launch`; app lifecycle hooks |
| `renderer/assets/launcher.js` | Add `lastNotifTs` to state; extend process update handler for notifications; add `buildProtocolHtml()` helper; inject protocol section in `renderToolSession()` |
| `renderer/index.html` | Add CSS for protocol pill variants, doc line, and progress bar |

---

### Task 1: Top-level requires, constants, and pure helpers

**Files:**
- Modify: `main.js:1-8` (add requires after line 7)
- Modify: `main.js` (add after `sha256File` function, around line 938)

**Context:** `main.js` currently requires crypto inline inside `sha256File()` at line 930. We hoist it to top-level (line 8 area) so it is available everywhere. `net` is new. We also add pure helper functions with no side effects so they can be tested in isolation.

- [ ] **Step 1: Add top-level requires**

In `main.js`, after line 7 (`const https = require('node:https');`), add:

```js
const net = require('node:net');
const crypto = require('node:crypto');
```

Then remove the inline `const crypto = require('node:crypto');` from `sha256File()` at line 930 (leave the rest of the function intact):

```js
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
```

- [ ] **Step 2: Add protocol constants and pure helpers**

After the `sha256File` function (after line 938), add:

```js
// ---------- foxy v4 protocol ----------

const SUPPORTED_PROTOCOL_VERSION = 1;
const MAX_PROTO_LINE = 4096;

function slugToDisplayName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function truncate(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

function clampPercent(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

function buildNexusEnv(slug, runId, appName, socketPath) {
  const env = {
    COVE_NEXUS: '1',
    COVE_NEXUS_PROTOCOL_VERSION: String(SUPPORTED_PROTOCOL_VERSION),
    COVE_NEXUS_TOOL_SLUG: slug,
    COVE_NEXUS_RUN_ID: runId,
    COVE_NEXUS_APP_NAME: appName,
  };
  if (socketPath) env.COVE_NEXUS_SOCKET = socketPath;
  return env;
}
```

- [ ] **Step 3: Verify no syntax errors**

Open a Node.js REPL or review the added code. The pure helpers have no dependencies other than built-ins. Confirm:
- `slugToDisplayName('cove-video-editor')` → `'Cove Video Editor'`
- `truncate('hello', 3)` → `'hel'`
- `clampPercent(150)` → `100`
- `clampPercent(-5)` → `0`

---

### Task 2: Extend processRegistry entry shape

**Files:**
- Modify: `main.js:1262-1276` (`serializeEntry`)
- Modify: `main.js:1343-1348` (initial `processRegistry.set` in `cove:launch`)

**Context:** Every registry entry needs `runId` and `protocol: null` from the start. `serializeEntry` must include `protocol` so the renderer receives it.

- [ ] **Step 1: Extend `serializeEntry`**

In `serializeEntry(slug)`, add `protocol` to the returned object:

```js
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
    protocol: e.protocol ?? null,
  };
}
```

- [ ] **Step 2: Add `runId` and `protocol: null` to initial registry entry in `cove:launch`**

The existing `processRegistry.set` at line 1343 sets the initial launching state. Add `runId` and `protocol`:

```js
  const runId = crypto.randomUUID();
  const now = Date.now();
  processRegistry.set(slug, {
    slug, child: null, pid: null, status: 'launching',
    startedAt: now, exitedAt: null, exitCode: null,
    signal: null, lastError: null, processUpdatedAt: now,
    runId, protocol: null,
  });
  broadcastProcessUpdate(slug, null);
```

The `const runId = crypto.randomUUID();` line goes just before the existing `const now = Date.now();` line.

---

### Task 3: Socket server infrastructure

**Files:**
- Modify: `main.js` (add after `buildNexusEnv`, before the `// ---------- scan ----------` section or nearby)

**Context:** This is the core socket layer. `socketServers` tracks open servers by slug. `createSocketDir` resolves the per-launch socket directory. `cleanupSocketServer` tears it down. `handleSocketConnection` manages one connection's lifecycle. `processProtocolLine` validates and dispatches a single NDJSON line.

- [ ] **Step 1: Add `socketServers` and `notificationRateLimits` Maps**

After `buildNexusEnv`, add:

```js
const socketServers = new Map(); // slug → { server, sockPath, sockDir }
const notificationRateLimits = new Map(); // slug → lastNotifTimestamp (ms)
```

- [ ] **Step 2: Add `createSocketDir()`**

```js
async function createSocketDir(runId) {
  const xdgDir = process.env.XDG_RUNTIME_DIR;
  if (xdgDir) {
    try {
      const dir = path.join(xdgDir, 'cove-nexus');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    } catch { /* fall through */ }
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cove-nexus-'));
  try { await fsp.chmod(tmp, 0o700); } catch { /* best effort */ }
  return tmp;
}
```

- [ ] **Step 3: Add `cleanupSocketServer(slug)`**

```js
async function cleanupSocketServer(slug) {
  const entry = socketServers.get(slug);
  if (!entry) return;
  socketServers.delete(slug);
  const { server, sockPath, sockDir, xdgBased } = entry;
  try { server.close(); } catch { /* ignore */ }
  try { await fsp.unlink(sockPath); } catch { /* ignore */ }
  if (!xdgBased) {
    try { await fsp.rmdir(sockDir); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Add `listenOnSocket(server, sockPath)` helper**

This wraps `server.listen` in a Promise with EADDRINUSE retry (unlink stale socket and retry once):

```js
function listenOnSocket(server, sockPath) {
  return new Promise((resolve, reject) => {
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        try { await fsp.unlink(sockPath); } catch { /* ignore */ }
        server.listen(sockPath, resolve);
        server.once('error', reject);
      } else {
        reject(err);
      }
    });
    server.listen(sockPath, resolve);
  });
}
```

- [ ] **Step 5: Add `processProtocolLine(slug, rawLine)`**

This validates a single parsed line against the spec's validation rules (in order), then calls `handleProtocolMessage`.

```js
function processProtocolLine(slug, rawLine) {
  let msg;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    // rate-limit parse error logs (once per minute per slug via console.warn)
    return;
  }

  // Envelope check
  if (!msg || typeof msg !== 'object') return;
  if (!msg.type || !msg.runId || msg.protocolVersion === undefined || !msg.ts) return;

  // runId match — registry entry must be launching or running
  const entry = processRegistry.get(slug);
  if (!entry || !['launching', 'running'].includes(entry.status)) return;
  if (msg.runId !== entry.runId) return;

  // Protocol version guard
  if (typeof msg.protocolVersion !== 'number' || msg.protocolVersion > SUPPORTED_PROTOCOL_VERSION) return;

  // Unknown type → drop silently (forward compat)
  const known = ['app_ready', 'status_update', 'active_document', 'progress_update', 'notification', 'app_exiting'];
  if (!known.includes(msg.type)) return;

  handleProtocolMessage(slug, msg);
}
```

- [ ] **Step 6: Add `handleSocketConnection(slug, socket)`**

One connection per launch. Buffers partial NDJSON lines. Enforces 4096-byte buffer limit.

```js
function handleSocketConnection(slug, socket) {
  let buf = '';
  const slugKey = slug; // capture for closure

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (buf.length > MAX_PROTO_LINE) {
      // Oversized buffer: destroy and log (rate-limited via console.warn)
      console.warn(`[cove-proto] oversized buffer from ${slugKey}, dropping connection`);
      socket.destroy();
      buf = '';
      return;
    }
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) processProtocolLine(slugKey, line);
    }
  });

  socket.on('error', () => { /* connection errors are normal — app crashed etc */ });
}
```

- [ ] **Step 7: Add `createSocketServer(slug, runId)`**

Creates the socket directory, starts the server, returns the socket path (or null on failure).

```js
async function createSocketServer(slug, runId) {
  if (process.platform !== 'linux') return null;

  let sockDir, xdgBased;
  try {
    const xdgDir = process.env.XDG_RUNTIME_DIR;
    sockDir = await createSocketDir(runId);
    xdgBased = !!(xdgDir && sockDir.startsWith(xdgDir));
  } catch {
    return null;
  }

  const sockPath = path.join(sockDir, `${runId}.sock`);
  const server = net.createServer((socket) => handleSocketConnection(slug, socket));

  try {
    await listenOnSocket(server, sockPath);
  } catch (err) {
    console.warn(`[cove-proto] socket listen failed for ${slug}:`, err?.message);
    try { server.close(); } catch { /* ignore */ }
    if (!xdgBased) {
      try { await fsp.rmdir(sockDir); } catch { /* ignore */ }
    }
    return null;
  }

  socketServers.set(slug, { server, sockPath, sockDir, xdgBased });
  return sockPath;
}
```

- [ ] **Step 8: Add `cleanupStaleProtocolSockets()`**

Best-effort cleanup of stale `cove-nexus/` directories under XDG_RUNTIME_DIR. Called once at startup.

```js
async function cleanupStaleProtocolSockets() {
  if (process.platform !== 'linux') return;
  const xdgDir = process.env.XDG_RUNTIME_DIR;
  if (!xdgDir) return;
  const dir = path.join(xdgDir, 'cove-nexus');
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSocket() || e.name.endsWith('.sock')) {
        try { await fsp.unlink(path.join(dir, e.name)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — dir may not exist */ }
}
```

---

### Task 4: Protocol message handler

**Files:**
- Modify: `main.js` (add after `processProtocolLine`)

**Context:** `handleProtocolMessage` applies field validation and string limits from the spec, updates `processRegistry[slug].protocol`, and calls `broadcastProcessUpdate`. Rate-limits toast notifications. Auto-clears progress at 100% after 2 seconds.

- [ ] **Step 1: Add `handleProtocolMessage(slug, msg)`**

```js
function handleProtocolMessage(slug, msg) {
  const entry = processRegistry.get(slug);
  if (!entry) return;

  const proto = entry.protocol ? { ...entry.protocol } : {
    connected: false,
    status: null,
    statusLabel: null,
    activePath: null,
    projectLabel: null,
    progress: null,
    progressLabel: null,
    lifecycle: null,
  };

  proto.connected = true;

  switch (msg.type) {
    case 'app_ready':
      proto.status = 'idle';
      break;

    case 'status_update': {
      const validStatuses = ['idle', 'busy', 'processing', 'error'];
      if (!validStatuses.includes(msg.status)) return; // required field invalid → drop
      proto.status = msg.status;
      proto.statusLabel = msg.label != null ? truncate(String(msg.label), 80) : null;
      break;
    }

    case 'active_document':
      proto.activePath = msg.path != null ? truncate(String(msg.path), 260) : null;
      proto.projectLabel = msg.projectLabel != null ? truncate(String(msg.projectLabel), 60) : null;
      break;

    case 'progress_update': {
      if (msg.percent === undefined || msg.percent === null) return; // required → drop
      proto.progress = clampPercent(msg.percent);
      proto.progressLabel = msg.label != null ? truncate(String(msg.label), 80) : null;
      // Auto-clear progress bar 2s after reaching 100
      if (proto.progress === 100) {
        setTimeout(() => {
          const e2 = processRegistry.get(slug);
          if (!e2 || !e2.protocol) return;
          if (e2.protocol.progress !== 100) return; // superseded
          processRegistry.set(slug, {
            ...e2,
            protocol: { ...e2.protocol, progress: null, progressLabel: null },
            processUpdatedAt: Date.now(),
          });
          broadcastProcessUpdate(slug, e2.status);
        }, 2000);
      }
      break;
    }

    case 'notification': {
      const validLevels = ['info', 'success', 'warning', 'error'];
      if (!validLevels.includes(msg.level)) return; // required → drop
      if (!msg.title || typeof msg.title !== 'string') return; // required → drop
      // Rate limit: one notification per 5 seconds per app
      const now = Date.now();
      const lastTs = notificationRateLimits.get(slug) ?? 0;
      if (now - lastTs < 5000) break; // drop silently within window
      notificationRateLimits.set(slug, now);
      // Store on protocol so renderer can detect new notifications
      proto.notification = {
        title: truncate(String(msg.title), 60),
        body: msg.body != null ? truncate(String(msg.body), 160) : null,
        level: msg.level,
        ts: msg.ts,
      };
      break;
    }

    case 'app_exiting':
      proto.lifecycle = 'closing';
      // Canonical processRegistry status (running) is NOT changed here
      break;

    default:
      return;
  }

  processRegistry.set(slug, {
    ...entry,
    protocol: proto,
    processUpdatedAt: Date.now(),
  });
  broadcastProcessUpdate(slug, entry.status);
}
```

---

### Task 5: Wire socket server into launch handler and app lifecycle

**Files:**
- Modify: `main.js:1323-1441` (`cove:launch` handler)
- Modify: `main.js:252-265` (`app.whenReady()`)
- Modify: `main.js:267` (`app.on('before-quit', ...)`)

**Context:** `createSocketServer` must be called before `spawn`. The returned `sockPath` (may be null) is merged into the spawn env via `buildNexusEnv`. On exit/error/catch, `cleanupSocketServer` must be called AFTER updating the registry status. Stale cleanup runs once at startup. Shutdown cleanup iterates all open servers.

- [ ] **Step 1: Update `cove:launch` to create socket before spawn and inject env**

Replace the `processRegistry.set` block and the `spawn` call with the updated version. The full updated handler (showing only the changed sections — the rest stays identical):

```js
ipcMain.handle('cove:launch', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  if (isLegacyClone(slug)) {
    return { ok: false, error: 'This install is from an older version. Click Update to reinstall as a binary.' };
  }

  const existing = processRegistry.get(slug);
  if (existing && (existing.status === 'launching' || existing.status === 'running')) {
    return { ok: true, alreadyRunning: true, kind: 'app' };
  }

  const info = readRegistry()[slug];
  if (!info?.path) return { ok: false, error: 'Not installed.' };
  if (!exists(info.path)) return { ok: false, error: `Missing: ${info.path}` };

  const runId = crypto.randomUUID();
  const now = Date.now();
  processRegistry.set(slug, {
    slug, child: null, pid: null, status: 'launching',
    startedAt: now, exitedAt: null, exitCode: null,
    signal: null, lastError: null, processUpdatedAt: now,
    runId, protocol: null,
  });
  broadcastProcessUpdate(slug, null);

  // Create socket server before spawn (Linux only; null on other platforms or failure)
  const appName = slugToDisplayName(slug);
  const sockPath = await createSocketServer(slug, runId);
  const nexusEnv = buildNexusEnv(slug, runId, appName, sockPath);

  const plan = planFromPath(info.path);
  try {
    const child = spawn(plan.cmd, plan.args, {
      cwd: path.dirname(info.path),
      detached: true,
      stdio: 'ignore',
      env: { ...buildLaunchEnv(), ...nexusEnv },
    });

    processRegistry.get(slug).child = child;
    processRegistry.get(slug).pid = child.pid ?? null;

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
      cleanupSocketServer(slug); // async, best-effort
    });

    child.unref();

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
        cleanupSocketServer(slug); // async, best-effort
        resolve({ ok: false, error: String(err?.message || err) });
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        const prev = processRegistry.get(slug);
        const prevStatus = prev?.status ?? null;
        if (prev?.status === 'launching') {
          processRegistry.set(slug, {
            ...prev,
            pid: child.pid ?? null,
            status: 'running',
            processUpdatedAt: Date.now(),
          });
          broadcastProcessUpdate(slug, prevStatus);
        }
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
    cleanupSocketServer(slug); // async, best-effort
    return { ok: false, error: String(err?.message || err) };
  }
});
```

- [ ] **Step 2: Add stale socket cleanup to `app.whenReady()`**

In the `app.whenReady().then(...)` block, add `cleanupStaleProtocolSockets()` as the first call:

```js
app.whenReady().then(() => {
  cleanupStaleProtocolSockets(); // best-effort, non-blocking
  migrateLegacyInstalls();
  // ... rest unchanged ...
});
```

- [ ] **Step 3: Add socket shutdown to `before-quit`**

The existing `before-quit` handler only sets `app.isQuitting = true`. Add a new handler that closes all socket servers:

```js
app.on('before-quit', () => { app.isQuitting = true; });

app.on('before-quit', () => {
  for (const [slug] of socketServers) {
    cleanupSocketServer(slug); // async, best-effort
  }
});
```

---

### Task 6: Renderer — notification detection

**Files:**
- Modify: `renderer/assets/launcher.js:18-38` (`state` object)
- Modify: `renderer/assets/launcher.js:1558-1570` (process update handler)

**Context:** The renderer receives `cove:process:update` events. When a new `protocol.notification` arrives (detected by comparing `ts` against the last seen `ts` per slug), it calls the existing `toast()` function. `lastNotifTs` tracks the last notification `ts` string per slug in the renderer, preventing replay on re-render.

- [ ] **Step 1: Add `lastNotifTs` to state**

In the `state` object, add `lastNotifTs: {}` after `processes: {}`:

```js
  let state = {
    filter: 'all',
    busy: {},
    progress: {},
    installedOverride: {},
    updated: {},
    onDisk: new Set(),
    manifests: {},
    remoteUpdates: new Set(),
    releaseNotes: {},
    appVersion: '',
    rateLimitedUntil: 0,
    hasGithubToken: false,
    toolOrder: [],
    bookmarks: new Set(),
    theme: 'dark',
    foxyMode: false,
    tabs: [],
    activeTabId: 'home',
    processes: {},
    lastNotifTs: {},
  };
```

- [ ] **Step 2: Extend process update handler with notification detection**

The existing handler (around line 1564) is:

```js
  coveAPI.onProcessUpdate(({ slug, state: s }) => {
    if (slug && s && typeof s === 'object') {
      state.processes[slug] = s;
      render();
      renderToolSession();
    }
  });
```

Extend it to detect new notifications before re-rendering:

```js
  coveAPI.onProcessUpdate(({ slug, state: s }) => {
    if (slug && s && typeof s === 'object') {
      state.processes[slug] = s;

      // Notification detection: fire toast when a new notification arrives
      const notif = s?.protocol?.notification;
      if (notif && notif.ts && notif.ts !== state.lastNotifTs[slug]) {
        state.lastNotifTs[slug] = notif.ts;
        const kind = notif.level === 'error' ? 'error'
          : notif.level === 'warning' ? 'warn'
          : notif.level === 'success' ? 'success'
          : 'info';
        const msg = notif.body ? `${notif.title}: ${notif.body}` : notif.title;
        toast(msg, kind);
      }

      render();
      renderToolSession();
    }
  });
```

---

### Task 7: Renderer — protocol UI in session panel

**Files:**
- Modify: `renderer/assets/launcher.js` (add `buildProtocolHtml` helper before `renderToolSession`)
- Modify: `renderer/assets/launcher.js:116+` (`renderToolSession` — inject protocol section into `session.innerHTML`)

**Context:** `renderToolSession()` builds the Foxy session panel HTML. When the active tab's process has a non-null `protocol`, we inject a protocol block. All user-supplied strings must pass through `escapeAttr()` before any DOM use. No `innerHTML` with raw values. The `escapeAttr` function already exists in the renderer.

- [ ] **Step 1: Add `buildProtocolHtml(proto)` helper**

Add this function just before `renderToolSession`:

```js
  function buildProtocolHtml(proto) {
    if (!proto) return '';
    const parts = [];

    // Status badge
    const lifecycle = proto.lifecycle;
    const status = proto.status;
    if (lifecycle === 'closing') {
      parts.push(`<span class="foxy-pill proto-closing">Closing…</span>`);
    } else if (status) {
      const label = status === 'idle' ? 'Idle'
        : status === 'busy' ? 'Busy'
        : status === 'processing' ? 'Processing'
        : status === 'error' ? 'Error'
        : '';
      if (label) {
        parts.push(`<span class="foxy-pill proto-${escapeAttr(status)}">${label}</span>`);
      }
    }

    // Status label
    if (proto.statusLabel) {
      parts.push(`<div class="foxy-proto-state">${escapeAttr(proto.statusLabel)}</div>`);
    }

    // Active document / project
    const docLine = proto.projectLabel || proto.activePath;
    if (docLine) {
      parts.push(`<div class="foxy-proto-doc">${escapeAttr(docLine)}</div>`);
    }

    // Progress bar
    if (proto.progress != null) {
      const pct = proto.progress;
      const pLabel = proto.progressLabel ? escapeAttr(proto.progressLabel) : '';
      parts.push(`
        <div class="foxy-proto-progress">
          <div class="foxy-proto-progress-bar" style="width:${pct}%"></div>
          <span class="foxy-proto-progress-label">${pLabel ? pLabel + ' — ' : ''}${pct}%</span>
        </div>`);
    }

    return parts.length ? `<div class="foxy-proto-block">${parts.join('')}</div>` : '';
  }
```

- [ ] **Step 2: Inject protocol block into `renderToolSession`**

In `renderToolSession()`, find where `session.innerHTML` is set (after all the existing badge/button HTML is assembled). The existing code builds a string and assigns it. Add the protocol block at the end of the content, after the existing badges and before or after the action buttons section.

Locate the `session.innerHTML = \`...\`` assignment in `renderToolSession`. At the end of the template string, before the closing backtick, add:

```js
      ${buildProtocolHtml(state.processes[tab.slug]?.protocol ?? null)}
```

The exact insertion point is inside the template literal, after the last existing content block (action buttons / session note), before `\`;`. The resulting change looks like:

```js
    session.innerHTML = `
      <div class="foxy-session-header">
        ... existing header content ...
      </div>
      <div class="foxy-session-actions">
        ... existing action buttons ...
      </div>
      ${buildProtocolHtml(state.processes[tab.slug]?.protocol ?? null)}
    `;
```

---

### Task 8: CSS for protocol UI elements

**Files:**
- Modify: `renderer/index.html:837` (after existing `.foxy-pill.failed` rule, before `.foxy-session-actions`)

**Context:** Add protocol pill variants (one per status + closing), the status label line, active document line, and progress bar. All inside the existing `<style>` block.

- [ ] **Step 1: Add protocol CSS**

After line 837 (`.foxy-pill.failed { ... }`), insert:

```css
  .foxy-pill.proto-idle       { background: color-mix(in srgb, #94a3b8 10%, transparent); border-color: color-mix(in srgb, #94a3b8 25%, transparent); color: #94a3b8; }
  .foxy-pill.proto-busy       { background: color-mix(in srgb, #f59e0b 10%, transparent); border-color: color-mix(in srgb, #f59e0b 25%, transparent); color: #f59e0b; }
  .foxy-pill.proto-processing { background: color-mix(in srgb, #f59e0b 10%, transparent); border-color: color-mix(in srgb, #f59e0b 25%, transparent); color: #f59e0b; }
  .foxy-pill.proto-error      { background: color-mix(in srgb, #ef4444 10%, transparent); border-color: color-mix(in srgb, #ef4444 25%, transparent); color: #ef4444; }
  .foxy-pill.proto-closing    { background: var(--surface-2); border-color: var(--border); color: var(--text-faint); }

  .foxy-proto-block { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .foxy-proto-state { font-size: 0.75rem; color: var(--text-faint); padding-left: 2px; }
  .foxy-proto-doc   { font-size: 0.7rem; color: var(--text-faint); padding-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  .foxy-proto-progress {
    position: relative;
    height: 4px;
    background: var(--surface-2);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 4px;
  }
  .foxy-proto-progress-bar {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
  .foxy-proto-progress-label {
    display: block;
    font-size: 0.7rem;
    color: var(--text-faint);
    margin-top: 2px;
    padding-left: 2px;
  }
```

---

### Task 9: Verification

- [ ] **Step 1: Check git status**

```bash
git status --short
```

Expected: modified files in M column — `main.js`, `renderer/assets/launcher.js`, `renderer/index.html`. No untracked files.

- [ ] **Step 2: Check for whitespace/merge errors**

```bash
git diff --check
```

Expected: clean output (no trailing whitespace warnings).

- [ ] **Step 3: Summarize files changed**

Report:
- `main.js`: added `net`, `crypto` top-level requires; added `SUPPORTED_PROTOCOL_VERSION`, `MAX_PROTO_LINE`, `slugToDisplayName`, `truncate`, `clampPercent`, `buildNexusEnv`, `socketServers`, `notificationRateLimits`, `createSocketDir`, `cleanupSocketServer`, `listenOnSocket`, `processProtocolLine`, `handleSocketConnection`, `createSocketServer`, `cleanupStaleProtocolSockets`, `handleProtocolMessage`; extended `serializeEntry` with `protocol`; extended `cove:launch` with runId, socket creation, nexus env, and cleanup calls; added `cleanupStaleProtocolSockets` call in `whenReady`; added socket shutdown in `before-quit`
- `renderer/assets/launcher.js`: added `lastNotifTs` to state; extended process update handler for toast notifications; added `buildProtocolHtml`; injected protocol block into `renderToolSession`
- `renderer/index.html`: added protocol pill CSS and progress bar CSS

- [ ] **Step 4: Summarize behavior added**

- Protocol-aware Cove apps launched from Foxy Mode now receive `COVE_NEXUS=1`, `COVE_NEXUS_PROTOCOL_VERSION`, `COVE_NEXUS_TOOL_SLUG`, `COVE_NEXUS_RUN_ID`, `COVE_NEXUS_APP_NAME`, and `COVE_NEXUS_SOCKET` (Linux only).
- Nexus accepts NDJSON messages from apps on a per-launch Unix socket and updates `processRegistry[slug].protocol`.
- Session panel shows: status badge (idle/busy/processing/error/closing), status label, active document/project, progress bar with auto-clear, and toast notifications (rate-limited 1/5s).
- Non-protocol apps see zero behavior change.

- [ ] **Step 5: Summarize deferred items (do not implement)**

Per the spec's Deferred Work table:
- macOS support
- Windows named pipe adapter
- Bidirectional messaging (Nexus → app)
- Multi-instance same slug support
- Notification action buttons / click callbacks
- Protocol adoption by any specific Cove app
- Tab persistence across Nexus restarts
- File-based JSONL fallback
