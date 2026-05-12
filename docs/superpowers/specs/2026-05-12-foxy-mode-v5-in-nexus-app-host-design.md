# Foxy Mode v5 — In-Nexus App Host Design

**Date:** 2026-05-12
**Status:** Design draft — pending approval. Implementation deferred.
**Depends on:** T-004 (v4 protocol) must be implemented before v5 tab-web mode.

---

## Background

- **Foxy v1** — browser-style Nexus tabs (external app, session panel per tool).
- **Foxy v2** — process tracking and running state.
- **Foxy v3** — best-effort external window focus (unreliable on Wayland; not a foundation for v5).
- **Foxy v4** — optional Cove app protocol: Unix domain socket, one-way NDJSON, status/progress reporting back to Nexus (designed, not yet implemented).
- **Foxy v5** — first class in-Nexus tab UI: a Cove app can serve its own web UI and have Nexus render it inside a Foxy tab.

---

## 1. App Tab Taxonomy

Four distinct tab modes, ordered from least to most integrated:

| Mode | What runs where | Protocol dependency | Foxy version |
|---|---|---|---|
| **external** | App runs outside Nexus. Tab shows session panel (status, launch button). | None | v1–v3 |
| **protocol-aware external** | App runs outside. Tab enriched with live status, progress, notifications via socket. | v4 socket required | v4 |
| **tab-web** | App runs locally and serves a web UI. Nexus renders it inside a `WebContentsView` within the Foxy tab. | v4 socket required (for `tab_ready` URL delivery) | v5 |
| **bundle** (future) | App ships a static HTML/JS/CSS bundle. Nexus loads it directly from `file://` — no HTTP server needed. | TBD | beyond v5 |

All existing apps stay `external` by default. Nothing breaks.

---

## 2. Recommended Architecture

### Why not native window embedding / reparenting

Rejected. XEmbed is X11-only and unreliable even there. Wayland has no standardised foreign-window embedding protocol. `wmctrl` and `xdotool` are X11 tools that do not work correctly under XWayland for embedded windows. The approach requires the guest app to cooperate in ways that most Electron/Qt/GTK apps do not support, and the result is visually fragile (flicker, z-order races, resize mismatches). This path is a dead end on Linux/Wayland.

### Recommended: WebContentsView + localhost HTTP (tab-web mode)

Nexus is Electron 33. **WebContentsView** (the stable successor to the deprecated `BrowserView`, available since Electron 29) lets a host window embed a sandboxed web view with its own renderer process, strict context isolation, and no Node integration.

The flow:

```
Nexus spawns app
  └─ injects COVE_NEXUS_SOCKET (v4 env vars)

App (Phase C) starts its own HTTP server on a random 127.0.0.1 port
  └─ sends tab_ready { url: "http://127.0.0.1:PORT" } via v4 socket

Nexus validates the URL, creates a WebContentsView
  └─ loads the URL in the embedded view
  └─ WebContentsView renders in the active Foxy tab area
```

### Why WebContentsView over alternatives

| Option | Verdict | Reason |
|---|---|---|
| **WebContentsView** | ✅ Recommended | Separate renderer process, no Node in guest, context isolation, stable in Electron 33 |
| `<webview>` tag | ⚠️ Avoid | Requires `webviewTag: true` (expands attack surface), considered legacy |
| `<iframe>` | ⚠️ Avoid | No process isolation from Nexus renderer; same-origin issues with localhost |
| Shared JS module | ❌ Reject | App module runs in Nexus renderer context — unacceptable security model |
| Plugin bundle (file://) | 🔮 Phase D | Good long-term option for trusted Cove apps; needs bundle format spec |
| Native embedding | ❌ Reject | Wayland incompatible; see above |

---

## 3. MVP: `openMode` per app

### New field in `programs.js`

```js
{
  name: "Cove Meme Maker",
  slug: "cove-meme-maker",
  // ... existing fields ...
  openMode: "tab-web",          // "external" (default) | "tab-web"
  fallbackMode: "external",     // what to do if tab-web fails to load
  protocolSupport: true,        // supports v4 socket protocol
}
```

Rules:
- `openMode` is optional. Absent = `"external"` (all current behavior preserved).
- `fallbackMode` is optional. Absent = `"external"`.
- `protocolSupport` is optional. Absent = `false`.
- `tab-web` requires `protocolSupport: true` — the URL is delivered via the socket.

### Runtime behavior

```
openMode === "external"   → existing v1–v3 launch path (unchanged)
openMode === "tab-web"    → new v5 launch path (see UX model below)
```

No other fields are needed in the MVP.

---

## 4. v4 Protocol Extension: `tab_ready` message

The v4 protocol already defines one-way NDJSON from app → Nexus. v5 adds one new message type:

```json
{
  "type": "tab_ready",
  "ts": "<ISO 8601>",
  "url": "http://127.0.0.1:PORT"
}
```

**Rules:**
- `url` must be `http://127.0.0.1:<port>`. Any other host, scheme, or port is silently ignored.
- The URL is validated by Nexus before use (see Security section).
- `tab_ready` may arrive before or after `app_ready`. Both are accepted in any order.
- If `tab_ready` never arrives within the timeout window (default: 10 s), Nexus falls back to `fallbackMode`.
- Sending `tab_ready` does not preclude also sending `status_update`, `progress_update`, etc.

The v4 spec is amended to include `tab_ready` in its message type table. No other v4 changes are needed.

---

## 5. App Registry Metadata Design

Full set of optional fields that may appear in a `programs.js` entry going forward:

```js
{
  // v4 fields
  protocolSupport: true,           // supports v4+ Unix socket protocol

  // v5 fields
  openMode: "tab-web",             // "external" | "tab-web" | "bundle" (future)
  fallbackMode: "external",        // mode to use if preferred mode fails

  // Phase D (future — not v5)
  // bundleEntrypoint: "ui/index.html",  // relative path within app install dir
}
```

All fields are optional. Nexus reads them at launch time. Missing = defaults shown above.

### What does NOT go in programs.js

- No raw URLs (remote or constructed at edit time) — URLs are delivered at runtime via socket.
- No secrets, tokens, or signing keys.
- No node_modules paths or internal implementation details.

---

## 6. Security Model

### Allowed URL schemes in WebContentsView

| Scheme | Allowed | Condition |
|---|---|---|
| `http://127.0.0.1:<port>` | ✅ | URL received via v4 Unix socket, port matches registered runId session |
| `file://<app-install-path>/...` | 🔮 Phase D only | Bundled static assets from known install directory; path must be inside app dir |
| `https://<anything>` | ❌ | Not allowed in Nexus-hosted tabs |
| `javascript:` | ❌ | Never |
| `http://localhost:<port>` | ❌ | Use `127.0.0.1` explicitly; `localhost` may resolve differently |

### URL validation function (pseudocode)

```js
function isAllowedTabUrl(url, runId, registry) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1') return false;
  const port = parseInt(parsed.port, 10);
  if (!port || port < 1024 || port > 65535) return false;
  // Require that the URL exactly matches what was delivered via the socket for this runId.
  // Note: ! binds before === so the naive form is always wrong; use a stored-value comparison.
  const expectedUrl = registry[runId]?.protocol?.tabUrl;
  if (expectedUrl !== url) return false;
  return true;
}
```

The URL must have arrived on the registered socket for `runId`. Nexus never accepts a tab URL from any other source.

### WebContentsView options

```js
new WebContentsView({
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // No preload script in the hosted view
  },
})
```

### Navigation and popup lockdown

The hosted WebContentsView must be fully locked to its origin. All of the following must be enforced:

**Navigation:**
- Intercept all `will-navigate` and `did-start-navigation` events on the hosted `WebContents`.
- Allow navigation only to the exact `http://127.0.0.1:<port>` origin that was validated for this `runId`.
- Block all other navigation attempts, including redirects that would change the origin, the port, or the scheme.
- Redirects within the same `127.0.0.1:PORT` origin (path/query changes only) are allowed.

**New windows and popups:**
- Call `setWindowOpenHandler` on the hosted `WebContents` and return `{ action: 'deny' }` by default.
- No new `BrowserWindow`, no new `WebContentsView`, no popup windows from hosted app content.
- If the app needs to open an external URL (e.g., a documentation link), it must do so via a message to Nexus through the v4 socket; Nexus then validates and calls `shell.openExternal`. Hosted content cannot trigger this directly.

**Blocked schemes:**
The following must never load inside a hosted view: `javascript:`, `data:`, `file://`, `blob:`, any custom scheme, any `https://` remote URL, and any `http://` URL with a hostname other than `127.0.0.1`.

**Localhost alias:**
`localhost` is not accepted as an equivalent to `127.0.0.1`. The allowed hostname is `127.0.0.1` only.

### WebContentsView Lifecycle Requirements

These requirements govern every stage of a hosted view's existence. An implementation that does not satisfy all of them may produce orphaned processes, GPU memory leaks, or invisible stale views.

**Creation:**
- Do not create a WebContentsView until a `tab_ready` URL has been received and passed URL validation.
- Do not create a view speculatively at launch time.
- After creation, attach the view to the correct Nexus content area before calling `loadURL`.

**Bounds and resize:**
- Set the initial bounds of the WebContentsView to the current Foxy content area immediately after attaching.
- Update bounds on every layout change that affects the content area: window resize, Foxy tab bar height change, sidebar expand/collapse, Nexus chrome layout changes.
- The view must fill the tab content area precisely — no gap, no overflow, no stale size after layout changes.

**Active / inactive tab switching:**
- When the user switches to a different Foxy tab, hide the inactive hosted view (`view.setVisible(false)` or equivalent). Do not destroy it.
- When the user returns to a tab-web tab, show the view again and update its bounds to account for any layout changes that occurred while it was hidden.
- A hidden view must not receive focus or intercept keyboard/mouse input.

**Destroy on tab close:**
- When a tab-web tab is closed (regardless of what happens to the process — see Open Questions #5), the WebContentsView must be destroyed: call `view.webContents.close()` / `view.webContents.destroy()`, remove the view from the parent window, and delete all Nexus-side references.
- Do not leave `WebContentsView` objects attached to the window after their tab is closed.

**Cleanup on app exit or failure:**
- When the app process exits (normally or abnormally), Nexus must:
  1. Detect the exit via the existing `processRegistry` exit event.
  2. Mark the tab as in a **not-running** state.
  3. Replace the WebContentsView content area with the fallback panel (same panel shown on `tab_ready` timeout).
  4. Destroy the WebContentsView.
  5. Remove all references from any hosted-view registry.
- The user should see the fallback panel with "App exited" messaging and the usual recovery actions (Relaunch, Open folder).

**Orphan prevention:**
- Maintain a registry mapping `runId` → `WebContentsView` (or `null` if not yet created / already destroyed).
- On Nexus shutdown, iterate the registry and destroy every remaining WebContentsView before the main window closes.
- After destroying a view, set its registry entry to `null` immediately. Never call methods on a destroyed view.
- If `tab_ready` arrives for a `runId` whose tab has already been closed, discard the message and do not create a view.

### Additional rules

- No `innerHTML` from app metadata fields — always use `textContent` for display.
- No eval or dynamic script injection from app-provided data.
- The WebContentsView does not have access to the Nexus preload or IPC channels.

---

## 7. UX Model

### External app tab (openMode: "external") — unchanged

Same as Foxy v1–v3. No changes to this path.

### Tab-web app tab (openMode: "tab-web")

**Launch sequence:**

1. User clicks Launch / Open in Nexus.
2. A Foxy tab is created immediately with a **loading state**:
   - Spinner + label "Starting Cove Meme Maker…"
   - No WebContentsView yet.
3. Nexus spawns the app process (same as today), opens v4 socket server.
4. App starts its HTTP server, sends `tab_ready` via socket.
5. Nexus validates the URL → creates WebContentsView → loads URL → tab transitions to **content state**.

**Timeout / failure fallback:**

If `tab_ready` does not arrive within 10 seconds, or if the WebContentsView fails to load the URL:

- Tab switches to **fallback panel** showing:
  - App name + error message ("App didn't start a UI in time.")
  - Button: **Launch externally** — kills any partial process, relaunches with `openMode: "external"` behavior
  - Button: **Retry** — resets the 10 s timer, tries again
  - Button: **Open app folder** — opens install directory in file manager

**Tab close:**

- **External tabs (unchanged):** Closing a Nexus tab for an `external` app does not kill the running process. The process continues; the user can reopen the tab and reattach.
- **Tab-web tab close:** What happens to the hosted process when a tab-web tab is closed is an **open design decision** (see Open Questions #5). For the v5 MVP the default behavior is to destroy the WebContentsView and detach from the process — without killing it — matching the `external` precedent. Explicit process termination from tab close must be a deliberate, separately confirmed decision and must not be treated as equivalent to current external-tab behavior.

**Multiple instances:**

- The same app cannot have two simultaneous tab-web tabs. If the user tries to launch a second instance while a tab-web tab already exists, Nexus activates the existing tab (same as current dedupe behavior).

**v4 enrichment alongside tab-web:**

- `status_update`, `progress_update`, `notification` messages still work alongside `tab_ready`.
- These can update the tab title badge, a small status chip in the tab bar, etc.
- The in-tab WebContentsView shows the app's own UI; the tab bar shows Nexus-side status.

---

## 8. Migration Path

### Phase A — External only (current state)

All apps run outside Nexus. Foxy tabs show session panels. No protocol support needed.

No code changes required from Cove apps.

### Phase B — Protocol-aware external (v4, T-004)

Apps still run outside. They opt in by reading `COVE_NEXUS_SOCKET` from env and connecting to send NDJSON messages.

Cove app change: add a small async background task that:
1. Checks for `COVE_NEXUS_SOCKET` env var.
2. Connects to the Unix socket.
3. Sends `app_ready`, then `status_update` / `progress_update` / `notification` as appropriate.
4. Sends `app_exiting` before shutdown.

This is a self-contained addition — no UI changes required.

### Phase C — tab-web (v5, this spec)

App adds:
1. A local HTTP server (e.g., `flask` or `fastapi` for Python apps) on a random `127.0.0.1` port.
2. An HTML/JS/CSS UI at the root route (or a dedicated `/tab` route).
3. A `tab_ready` message sent via the v4 socket after the server starts.

Nexus gains:
1. WebContentsView host in the Foxy tab area.
2. `tab_ready` message handler.
3. URL validation logic.
4. Loading/fallback UX.

### Phase D — Bundled static UI (future)

App ships a pre-built static bundle (e.g., a `dist/` directory). Nexus loads it from `file://` — no HTTP server needed at runtime.

Requires:
- Agreed bundle format and entry point naming convention.
- Additional security review for `file://` loading.
- Defined install directory path convention.

Phase D is out of scope for v5.

---

## 9. First App Candidate: cove-meme-maker

Evaluation of the candidates (all Python except where noted):

| App | UI complexity | Filesystem risk | Native deps | Tab-native suitability |
|---|---|---|---|---|
| **cove-meme-maker** | Low (template picker + text fields + preview + export) | Low (reads bundled templates, writes exported PNG/JPEG) | None beyond Pillow/OpenCV | ✅ Best candidate |
| cove-gif-maker | Medium (timeline, palette controls) | Low-medium | FFmpeg | Good but more complex |
| cove-universal-converter | Medium (file picker, format selector) | Medium (reads/writes user files) | FFmpeg + various | Good second candidate |
| cove-image-lab | Not in registry | Unknown | Unknown | Cannot evaluate |

**Recommendation: cove-meme-maker**

Reasons:
1. **Simplest UI** — template gallery, two text fields (top/bottom), preview image, export button. This maps directly to a single-page HTML form.
2. **Lowest filesystem risk** — reads from a bundled templates directory; user chooses output path for export. No recursive filesystem operations.
3. **No heavy native dependencies** — Pillow for image compositing. No native binary or GPU driver required.
4. **Self-contained output** — generates a single image file. The tab UI can even preview the result inline before export.
5. **Useful inside Nexus** — a quick meme maker embedded in the launcher is genuinely more useful than launching a separate window.

`cove-image-lab` is not present in `programs.js`. If it exists as a separate repo, it can be evaluated once the tab-web infrastructure is proven with cove-meme-maker.

---

## 10. Implementation Phases

### Phase 1 — Implement v4 protocol (T-004, prerequisite)

Must be complete before v5 work begins. T-004 is currently open/not started.

- Socket server infrastructure in `main.js`
- Protocol message handler + `processRegistry` updates
- `broadcastProcessUpdate` enrichment
- Renderer display of protocol state in `renderToolSession()`

### Phase 2 — Extend v4 with `tab_ready` and add WebContentsView host (T-005 core)

Nexus-side only. No Cove app changes yet.

- Add `tab_ready` message type handling in `main.js` protocol handler.
- URL validation function in `main.js`.
- WebContentsView creation/destruction lifecycle tied to Foxy tab lifecycle.
- Loading state and fallback panel in `renderer/index.html` + `launcher.js`.
- `openMode` reading from `programs.js` at launch time.

### Phase 3 — First app experiment: cove-meme-maker

cove-meme-maker gains:
- Flask HTTP server on a random `127.0.0.1` port at startup.
- Simple HTML UI served at `/`.
- v4 socket connection: sends `app_ready` + `tab_ready`.
- `openMode: "tab-web"` added to its `programs.js` entry in Nexus.

This is the first end-to-end test of the full stack.

### Phase 4 — Polish and harden

- Timeout handling tuning (default 10 s may need adjustment).
- Tab bar status chip for `status_update` messages.
- Navigation restriction enforcement in WebContentsView.
- Memory/process cleanup verification on tab close.
- Consider Phase D (bundle loading) if Phase C proves stable.

---

## 11. What This Design Does NOT Do

- No native window embedding or reparenting.
- No `wmctrl`, `xdotool`, or X11/Wayland window management APIs.
- No Node.js access in the hosted app UI.
- No arbitrary remote URLs.
- No changes to the external launch path for non-tab-web apps.
- No immediate rewrite of any existing Cove app.
- No macOS support (explicitly out of scope).
- No bidirectional messaging (Nexus → app) in v5.
- No tab persistence across Nexus restarts (still deferred since v1).

---

## Open Questions

1. Should the tab title show the app name, or pull from `status_update.label`?
2. Should a re-opened tab-web tab reconnect to a still-running process, or always start a fresh one?
3. What is the correct timeout before fallback? 10 s is a guess.
4. Should Phase D (bundle loading) share the same `openMode: "bundle"` enum or a different field?
5. **Tab-web process termination:** When a tab-web tab is closed, should Nexus (a) destroy the view only and leave the process running, (b) show a confirmation prompt before killing, or (c) always kill? MVP default is (a) — destroy the view, leave the process. Must be explicitly confirmed before implementation.

---

*Implementation deferred until this design is approved.*
