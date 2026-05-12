# Foxy Mode v4 — Optional Cove App Protocol Design

**Date:** 2026-05-12
**Status:** Approved for implementation (deferred — no Cove app has adopted the protocol yet)
**Scope:** Narrow optional protocol for Cove apps to report lightweight state back to Cove Nexus when launched from Nexus.

---

## Context

- Foxy v1 added browser-style Nexus tabs.
- Foxy v2 added process tracking and running state.
- Foxy v3 added best-effort external app focus (unreliable on Wayland).
- Foxy v4 prepares the foundation for Cove apps to report status, activity, and progress back to Nexus — making apps Nexus-aware without embedding or reparenting.

The protocol is **entirely optional**. Existing Cove apps with no protocol support continue to launch and behave exactly as they do today (v2 process state: Launching / Running / Not running / Failed). Protocol-aware apps can enrich their Nexus session panel only.

---

## Platform Scope

**v4 target platform: Linux only.**

- Primary transport: Unix domain socket.
- macOS: out of scope until Cove apps target macOS.
- Windows: named pipe adapter deferred to a future version.

The protocol contract (env vars, message schema, validation rules) is designed to be platform-neutral so future platform adapters do not require schema changes.

---

## Transport: Unix Domain Socket

### Socket path

Nexus creates a per-launch socket directory and socket file before spawning the app:

1. **Preferred path:** `$XDG_RUNTIME_DIR/cove-nexus/<runId>.sock`
   - `XDG_RUNTIME_DIR` is a per-user, per-session directory managed by the login session (typically `/run/user/<uid>`). It is not world-writable.
   - Nexus creates `$XDG_RUNTIME_DIR/cove-nexus/` with mode `0700` if it does not exist, then places the socket at `<dir>/<runId>.sock`.
2. **Fallback path:** create a Nexus-owned per-launch temp directory using `fs.mkdtemp(path.join(os.tmpdir(), "cove-nexus-"))` (produces e.g. `/tmp/cove-nexus-XXXXXX`), then place the socket at `<created-temp-dir>/<runId>.sock`.
   - The `mkdtemp`-created directory is unique per launch. Nexus should `chmod` it to `0700` where possible to restrict access.
   - This avoids `/tmp` symlink and world-writable directory race conditions.

### Connection lifecycle

1. Nexus creates the socket directory and starts the server before spawning the app.
2. The socket path is passed to the app via `COVE_NEXUS_SOCKET`.
3. The app may connect at any point after spawn. Late connections (e.g., slow-starting apps) are accepted.
4. One connection per launch. If the app disconnects and reconnects, Nexus accepts the new connection and preserves existing protocol state.
5. On app exit (`processRegistry` status transitions to `exited` or `failed`), Nexus closes the socket connection, unlinks the socket file, and removes the per-launch socket directory.
6. On Nexus shutdown, all active socket servers are closed and their socket files are unlinked.
7. On Nexus startup, stale `cove-nexus/` directories under `XDG_RUNTIME_DIR` that clearly belong to this app (by naming convention) may be cleaned up opportunistically. This is best-effort; no cleanup failure should block startup.

### Message framing

Newline-delimited JSON (NDJSON). Each message is one complete JSON object terminated by `\n`. Partial lines are buffered until `\n` is received.

### Buffer safety

- **Max line buffer size: 4096 bytes** (applied before a newline is received).
- If the accumulated buffer for a connection exceeds 4096 bytes without a `\n`, Nexus immediately destroys the connection and unlinks the socket.
- This prevents a misbehaving or malicious app from growing the buffer indefinitely.
- Log the drop at most once per minute per slug to avoid log spam.

---

## Launch Environment Contract

Nexus injects the following environment variables into the spawned process via `buildLaunchEnv()` (`main.js`). These are added to the `LAUNCH_ENV_KEYS` allowlist:

| Variable | Value | Notes |
|---|---|---|
| `COVE_NEXUS` | `1` | Indicates the app was launched by Cove Nexus. Always present. Does **not** mean the protocol socket is available. |
| `COVE_NEXUS_PROTOCOL_VERSION` | `1` | Integer. Bumped only on breaking schema changes. |
| `COVE_NEXUS_TOOL_SLUG` | e.g. `cove-video-editor` | The tool's canonical slug. |
| `COVE_NEXUS_RUN_ID` | UUID v4 | Unique per launch. Used to identify the socket and validate messages. |
| `COVE_NEXUS_APP_NAME` | e.g. `Cove Video Editor` | Display name for the app. |
| `COVE_NEXUS_SOCKET` | Full socket path | Only present when Foxy Mode is enabled and the socket was successfully created. |

**Checking for protocol availability:**

- `COVE_NEXUS=1` means "launched by Cove Nexus." It may exist without `COVE_NEXUS_SOCKET`.
- `COVE_NEXUS_SOCKET` is the signal that the protocol socket is available. Apps must check for this variable before attempting any socket I/O.
- If `COVE_NEXUS_SOCKET` is absent (Foxy Mode off, socket creation failed, or non-Linux platform), the app should skip all protocol code silently.

**Recommended app-side guard (pseudocode):**

```python
socket_path = os.environ.get("COVE_NEXUS_SOCKET")
if socket_path:
    connect_and_report(socket_path)
# else: no protocol, run normally
```

**Run ID generation:** `crypto.randomUUID()` at launch time, stored in `processRegistry` alongside slug, pid, and status.

---

## Protocol Versioning

- `COVE_NEXUS_PROTOCOL_VERSION=1` is the v4 baseline.
- The version integer is bumped only when a breaking change is made to the message schema (removed fields, changed semantics, changed validation).
- Adding new optional fields or new message types does **not** bump the version.
- Apps that want to use newer message types may check the version to gate behavior, but for v1 this is not required.
- If Nexus receives a message with `protocolVersion` higher than its known maximum, it drops the message silently. This is a forward-compatibility guard for apps newer than the installed Nexus.

---

## Message Schema

All messages travel **app → Nexus only**. The protocol is one-way in v4. Nexus never sends responses.

### Common envelope

Every message must include these fields:

```json
{
  "protocolVersion": 1,
  "runId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "<message_type>",
  "ts": "2026-05-12T10:00:00.000Z"
}
```

- `protocolVersion`: integer, must match `COVE_NEXUS_PROTOCOL_VERSION`.
- `runId`: must match `COVE_NEXUS_RUN_ID` exactly.
- `type`: message type string.
- `ts`: ISO 8601 timestamp. Informational; used for display only.

**Note:** Message examples below omit the common envelope fields for brevity. In actual use, every message must include all four common fields.

---

### `app_ready`

App has initialized and is ready for use.

```json
{ "type": "app_ready" }
```

Nexus effect: Sets `protocol.connected = true`, sets `protocol.status = "idle"`.

---

### `status_update`

App reports its current operational state.

```json
{
  "type": "status_update",
  "status": "busy",
  "label": "Indexing workspace..."
}
```

- `status`: required. One of `"idle"` | `"busy"` | `"processing"` | `"error"`.
- `label`: optional. Plain text, max 80 chars. Displayed as a sub-line in the session panel.

Nexus effect: Sets `protocol.status` and `protocol.statusLabel`. Any `status_update` also sets `protocol.connected = true`.

---

### `active_document`

App reports the current file or project context.

```json
{
  "type": "active_document",
  "path": "/home/sin/Projects/cove-nexus/main.js",
  "projectLabel": "cove-nexus"
}
```

- `path`: optional. Display-only; truncated in UI. Plain text, max 260 chars.
- `projectLabel`: optional. Plain text, max 60 chars.

Nexus effect: Sets `protocol.activePath` and `protocol.projectLabel`. Sets `protocol.connected = true`.

---

### `progress_update`

App reports a percentage-based progress (e.g., indexing, build, export).

```json
{
  "type": "progress_update",
  "label": "Exporting video...",
  "percent": 42
}
```

- `percent`: required. Integer 0–100. Values outside this range are clamped.
- `label`: optional. Plain text, max 80 chars.

Nexus effect: Sets `protocol.progress` and `protocol.progressLabel`. When `percent` reaches 100, Nexus clears the progress bar after 2 seconds. Sets `protocol.connected = true`.

---

### `notification`

App requests a toast notification in Nexus.

```json
{
  "type": "notification",
  "title": "Export complete",
  "body": "video-project-final.mp4 exported in 8.3s",
  "level": "info"
}
```

- `level`: required. One of `"info"` | `"success"` | `"warning"` | `"error"`.
- `title`: required. Plain text, max 60 chars.
- `body`: optional. Plain text, max 160 chars.

Nexus rate-limits toast notifications to **one per 5 seconds per app**. No HTML rendered. Sets `protocol.connected = true`.

---

### `app_exiting`

App signals it is shutting down gracefully, before the OS-level exit event fires.

```json
{
  "type": "app_exiting",
  "reason": "user_quit"
}
```

- `reason`: optional. Informational string, max 60 chars, plain text.

Nexus effect: Sets `protocol.lifecycle = "closing"`. The canonical `processRegistry` status (`running`) is **not** changed; it remains `running` until the OS exit event fires normally. The renderer can display "Closing..." from `protocol.lifecycle`, keeping the process lifecycle enum clean.

---

## Validation Rules

Applied in order on every received message. Failures are dropped silently unless noted.

1. **Buffer size** — Accumulated bytes since last `\n` exceed 4096 bytes → destroy connection, log once per minute per slug.
2. **JSON parse** — Malformed JSON → drop, log to console (rate-limited).
3. **Envelope check** — Missing `type`, `runId`, `protocolVersion`, or `ts` → drop.
4. **runId match** — `runId` must match a `processRegistry` entry in `launching` or `running` state → drop if no match.
5. **Protocol version** — `protocolVersion > 1` (unknown future version) → drop, log once per slug per session.
6. **Type check** — Unknown `type` → drop silently (forward compatibility — future message types are ignored by older Nexus).
7. **Field validation** — String length limits and enum values as defined in the schema → clamp integers within range; truncate strings at defined limits; drop the message only if a *required* field is invalid.
8. **Sanitization** — All string values must be treated as plain text before any UI use. No `innerHTML`. No `eval`. No HTML parsing.

Nexus never sends error responses back to the app. The protocol is fire-and-forget from the app's perspective.

---

## Protocol State in processRegistry

Protocol data is stored on the existing `processRegistry` entry alongside slug, pid, and status, under a `protocol` sub-object:

```js
{
  slug: "cove-video-editor",
  pid: 12345,
  status: "running",          // canonical v2 lifecycle: launching/running/exited/failed
  // ... existing fields ...
  protocol: {
    connected: true,          // true once any valid message is received
    status: "busy",           // idle | busy | processing | error
    statusLabel: "Indexing…",
    activePath: "/home/sin/Projects/...",
    projectLabel: "cove-nexus",
    progress: 42,
    progressLabel: "Exporting…",
    lifecycle: null,          // "closing" when app_exiting received; null otherwise
  }
}
```

`protocol` is `null` until the first valid message is received on the socket connection.

Protocol state is broadcast to the renderer via the existing `broadcastProcessUpdate()` channel. The `state` payload in `cove:process:update` gains the optional `protocol` field. No new IPC channels are needed.

---

## Renderer UI Mapping

The tool session panel (rendered by `renderToolSession()` in `launcher.js`) is augmented when `protocol` is non-null:

| Condition | UI element | Display |
|---|---|---|
| `protocol` is null | (v2 behavior unchanged) | `Launching` / `Running` / `Not running` / `Failed` |
| `protocol.connected` is true | Status badge | Replaces v2 running indicator |
| `protocol.status === "idle"` | Status badge | `Idle` (gray dot) |
| `protocol.status === "busy"` | Status badge | `Busy` (amber dot) |
| `protocol.status === "processing"` | Status badge | `Processing` (amber dot; animation optional/subtle) |
| `protocol.status === "error"` | Status badge | `Error` (red dot) |
| `protocol.statusLabel` present | Sub-line | Plain text below badge |
| `protocol.activePath` or `protocol.projectLabel` | Sub-line | Truncated path or project name |
| `protocol.progress` set | Progress bar | Slim bar + label + percentage |
| `protocol.lifecycle === "closing"` | Status badge | `Closing…` |

Any valid protocol message sets `protocol.connected = true` and begins enriching the UI. `app_ready` is a useful signal but not required before enrichment starts.

Motion note: animated indicators (e.g., `processing` dot pulse) should be subtle or absent by default. No heavy animation in the session panel.

---

## Backward Compatibility

- Apps with no protocol support show the existing v2 state (Launching / Running / Not running / Failed) unchanged.
- `protocol` field is absent from `broadcastProcessUpdate` payloads for non-protocol apps. Renderer treats absent/null `protocol` as v2-only mode.
- No changes to the launch flow for non-protocol apps.
- No changes to `processRegistry` status values (`launching`, `running`, `exited`, `failed`).

---

## Deferred Work

| Item | Disposition |
|---|---|
| macOS support | Out of scope — no Cove apps target macOS |
| Windows named pipe adapter | Future — deferred until needed |
| File-based JSONL fallback | Dropped — extra surface area before any app adopts the protocol |
| Bidirectional messaging (Nexus → app) | v5+ — not needed until apps need commands from Nexus |
| Multi-instance same app (two windows of same slug) | Not addressed — one slug = one process in v4 |
| Notification action buttons / click callbacks | v5+ — requires a trust model for callbacks |
| Protocol adoption by any specific Cove app | Separate work, tracked separately |
| Tab persistence across Nexus restarts | Deferred since v1, still deferred |
| Native embedding / window reparenting | Explicitly out of scope |

---

## Implementation Plan (for a later patch)

This section outlines the implementation order when the design is approved for coding. **Implementation is deferred pending protocol adoption by at least one Cove app.**

1. **`main.js` — Run ID + socket setup**
   - Add `runId: crypto.randomUUID()` to `processRegistry` entry at launch time.
   - Add `COVE_NEXUS_*` vars to `LAUNCH_ENV_KEYS` in `buildLaunchEnv()`.
   - Before spawn: resolve socket directory (`XDG_RUNTIME_DIR/cove-nexus/` or `mkdtemp` fallback), create with mode `0700`, start `net.createServer()` on `<dir>/<runId>.sock`.
   - On process exit/failure: close server, unlink socket, remove directory.
   - On Nexus shutdown: iterate open socket servers, close and unlink all.
   - On startup: opportunistically clean stale `cove-nexus/` dirs under `XDG_RUNTIME_DIR`.

2. **`main.js` — Protocol message handler**
   - Per-connection: maintain a line buffer; enforce 4096-byte limit; destroy connection on overflow.
   - On `\n`: JSON parse → envelope validation → `runId` match → dispatch to `handleProtocolMessage(slug, msg)`.
   - `handleProtocolMessage`: update `processRegistry[slug].protocol` sub-object per message type; call `broadcastProcessUpdate()`.

3. **`preload.js` — No changes needed**
   - Protocol state rides the existing `cove:process:update` broadcast.

4. **`renderer/assets/launcher.js` — Session panel enrichment**
   - In `renderToolSession()`: check `state.processes[slug].protocol`.
   - If null: render existing v2 status unchanged.
   - If non-null: render status badge, sub-line (statusLabel / activePath / projectLabel), progress bar, Closing state from `protocol.lifecycle`.
   - Trigger toast via existing notification system when `notification` message received.

5. **Validation unit tests** (if test infrastructure exists; otherwise, extract the NDJSON validator and envelope check as pure functions for manual/REPL-level sanity checks)
   - JSON parse failure → drop.
   - Oversized buffer → destroy connection.
   - Unknown runId → drop.
   - Future protocolVersion → drop.
   - String truncation at defined limits.
   - Enum clamping for `status` and `level`.
