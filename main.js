const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const os = require('node:os');
const https = require('node:https');

const APP_ID = 'cove-nexus';
const GITHUB_OWNER = 'Sin213';
const GITHUB_REPO = 'cove-nexus';
const UA = 'cove-nexus-launcher';

// Pin the on-disk name to a lowercase, XDG-friendly form rather than the
// display name ("Cove Nexus"), which Electron would otherwise turn into
// "~/.config/Cove Nexus/" with a space and capitals.
app.setName('Cove Nexus');
app.setPath('userData', path.join(app.getPath('appData'), APP_ID));

const USER_DATA = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const INSTALLS_FILE = path.join(USER_DATA, 'installs.json');

// Old Cove Suite stashed everything under ~/.cove-suite/. We migrate from
// there on first v1.1.0 boot but never write to it going forward.
const LEGACY_ROOT = path.join(os.homedir(), '.cove-suite');
const LEGACY_PROGRAMS = path.join(LEGACY_ROOT, 'programs');

fs.mkdirSync(USER_DATA, { recursive: true });

let mainWindow = null;
let tray = null;
// Flipped to true only from the tray "Quit" item so the close handler can
// distinguish "user really wants out" from "user clicked ×".
app.isQuitting = false;

// Single-instance lock. If the user double-clicks the .exe again while
// Nexus is already running (including hidden in the tray), the second
// process exits immediately and the first surfaces its window — no
// duplicate windows or duplicate trays. Must run before app.whenReady().
//
// We pass our version + on-disk path through additionalData so the running
// instance can detect "user just double-clicked a *newer* portable" and
// hand off to it instead of swallowing the click. Without this, a 2.0.x
// instance hidden in the tray would silently consume a 2.0.(x+1) launch
// and the user would never see the new version.
function ownExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE
      || process.env.APPIMAGE
      || process.execPath;
}
const gotSingleInstanceLock = app.requestSingleInstanceLock({
  version: app.getVersion(),
  exePath: ownExePath(),
});
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, _argv, _cwd, additionalData) => {
    const newVer = additionalData?.version;
    const newPath = additionalData?.exePath;
    if (newVer && newPath && isNewerSemver(newVer, app.getVersion())) {
      try {
        app.relaunch({ execPath: newPath, args: [] });
        app.isQuitting = true;
        app.exit(0);
        return;
      } catch (err) {
        console.error('[cove-handoff]', err?.message || err);
        // fall through to surfacing the existing window
      }
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

function defaultProgramsRoot() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, APP_ID, 'programs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_ID, 'programs');
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, APP_ID, 'programs');
}

function createWindow() {
  const cfg = readConfig();
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b10',
    show: false,
    // Sets the Windows taskbar label and the X11 window-class title; the
    // page-title-updated listener below freezes it so the empty <title>
    // in index.html can't blank it out after load.
    title: 'Cove Nexus',
    frame: false,
    icon: path.join(__dirname, 'renderer', 'assets', 'cove_icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);
  // Route any window.open / target=_blank to the system browser. Without this,
  // Electron pops a child BrowserWindow that renders GitHub broken (no session,
  // partial CSS), which is what users see when they click "more…".
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Hold the window hidden until the renderer has painted, so users don't
  // see a black flash while the page loads. If startMinimized is on we
  // never call show() — the user surfaces it from the tray.
  win.once('ready-to-show', () => {
    // Only honor startMinimized if we have a tray to surface from —
    // otherwise the user would have no way to bring the window back.
    if (cfg.startMinimized && tray) return;
    win.show();
  });
  mainWindow = win;
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.on('close', (e) => {
    const c = readConfig();
    if (!app.isQuitting && c.minimizeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('maximize', () => win.webContents.send('cove:window:stateChanged', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('cove:window:stateChanged', { maximized: false }));
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'renderer', 'assets', 'cove_icon.png');
    let img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      // 16px works on Windows and most Linux trays; macOS uses template images,
      // but macOS isn't a shipping target so we don't branch for it.
      img = img.resize({ width: 16, height: 16 });
    }
    tray = new Tray(img);
    tray.setToolTip('Cove Nexus');
    const menu = Menu.buildFromTemplate([
      { label: 'Show Cove Nexus', click: () => showMainWindow() },
      { label: 'Check for updates',
        click: () => {
          showMainWindow();
          try { mainWindow?.webContents.send('cove:tray:checkUpdates'); } catch {}
        } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showMainWindow());
  } catch (err) {
    // Tray is optional — some Linux distros ship without a SNI host.
    console.error('[cove-tray]', err?.message || err);
    tray = null;
  }
}

// Login item (launch on startup). Electron handles this natively on
// Windows and macOS; on Linux it's a noop — systemd user units or an
// autostart .desktop file would be needed, and we don't write either.
function applyLoginItem(cfg) {
  if (process.platform === 'linux') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!cfg.launchOnStartup,
      openAsHidden: !!cfg.startMinimized,
    });
  } catch (err) {
    console.error('[cove-loginitem]', err?.message || err);
  }
}

app.whenReady().then(() => {
  migrateLegacyInstalls();
  migrateRenamedSlugs();
  ensureProgramsRoot();
  adoptFromProgramsRoot();
  const cfg = readConfig();
  applyLoginItem(cfg);
  setupTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  setupAutoUpdater();
});

app.on('before-quit', () => { app.isQuitting = true; });

// Windows Portable builds can't auto-update (electron-updater has no
// portable target support), so we detect that case and fall through to
// a polite "new version available" prompt in the UI instead.
function isWindowsPortable() {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
}

// Silent auto-update: packaged builds only. Checks on boot and hourly.
// When an update is downloaded, the app relaunches itself immediately.
// No prompt. No toast. Configured against github.com/Sin213/cove-nexus releases.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (isWindowsPortable()) { setupPortableUpdateNotifier(); return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', () => {
    try { autoUpdater.quitAndInstall(true, true); } catch {}
  });
  autoUpdater.on('error', (err) => {
    // Logged only — we intentionally don't surface update failures to the UI.
    console.error('[cove-updater]', err?.message || err);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000);
}

// Portable-only: poll GitHub for a newer cove-nexus release and notify the
// renderer. The user dismisses the banner per-version; we don't download
// anything (portable means "user is the installer").
function setupPortableUpdateNotifier() {
  const currentVersion = app.getVersion();
  const check = async () => {
    try {
      const rel = await httpsGetJson(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        {},
        { allowCache: false }  // always fresh; the normal cache is fine for tool releases
      );
      const latestTag = rel?.tag_name || '';
      const latestVer = latestTag.replace(/^v/, '');
      if (!latestVer || !isNewerSemver(latestVer, currentVersion)) return;
      // Find the Portable.exe asset so the banner can link straight to it.
      const portableAsset = (rel?.assets || []).find(a => /-Portable\.exe$/i.test(a?.name || ''));
      const payload = {
        version: latestVer,
        tag: latestTag,
        notes: (rel?.body || '').replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 400),
        htmlUrl: rel?.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        downloadUrl: portableAsset?.browser_download_url || '',
      };
      try { mainWindow?.webContents.send('cove:self:updateAvailable', payload); } catch {}
    } catch (err) {
      // Network hiccups are fine; we'll try again next tick.
      console.warn('[cove-portable-update]', err?.message || err);
    }
  };
  // Wait for the renderer before the first poke so the banner can actually
  // display when we find an update on cold start.
  app.once('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', check);
  });
  setInterval(check, 60 * 60 * 1000);
}

function isNewerSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- small utils ----------

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ---------- config (~/.config/cove-nexus/config.json) ----------

// Token storage: prefer Electron's safeStorage (DPAPI on Windows, Keychain on
// macOS, kwallet/gnome-keyring on Linux when available). When the platform
// can't encrypt — typically a headless Linux box without a keyring — we fall
// back to plaintext but lock the file down to 0600 so backups and other
// users on the box can't trivially harvest it.
function canEncryptTokens() {
  try { return app.isReady() && safeStorage.isEncryptionAvailable(); }
  catch { return false; }
}

function encodeToken(plain) {
  if (!plain) return { githubTokenEnc: '', githubToken: '' };
  if (canEncryptTokens()) {
    try {
      const enc = safeStorage.encryptString(plain);
      return { githubTokenEnc: Buffer.from(enc).toString('base64'), githubToken: '' };
    } catch (err) {
      console.warn('[cove-token] encryption failed, falling back to plaintext:', err?.message || err);
    }
  }
  return { githubTokenEnc: '', githubToken: plain };
}

function decodeToken(c) {
  const enc = typeof c?.githubTokenEnc === 'string' ? c.githubTokenEnc : '';
  if (enc && canEncryptTokens()) {
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
    catch (err) {
      console.warn('[cove-token] decryption failed:', err?.message || err);
      return '';
    }
  }
  return typeof c?.githubToken === 'string' ? c.githubToken : '';
}

function readConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch {
    raw = {
      programsRoot: defaultProgramsRoot(),
      minimizeToTray: true,
      startMinimized: false,
      launchOnStartup: false,
    };
    writeConfig({ ...raw, githubToken: '' });
    return { ...raw, githubToken: '' };
  }
  const token = decodeToken(raw);
  // Migrate plaintext tokens forward as soon as we can encrypt. This is a
  // one-shot rewrite — once `githubTokenEnc` is populated and `githubToken`
  // is cleared on disk, the old field stays empty across future writes.
  if (token && raw.githubToken && canEncryptTokens()) {
    try { writeConfig({ ...raw, githubToken: token, programsRoot: raw.programsRoot || defaultProgramsRoot() }); }
    catch (err) { console.warn('[cove-token] migration write failed:', err?.message || err); }
  }
  return {
    programsRoot: typeof raw?.programsRoot === 'string' && raw.programsRoot
      ? raw.programsRoot
      : defaultProgramsRoot(),
    githubToken: token,
    minimizeToTray: raw?.minimizeToTray !== false,
    startMinimized: !!raw?.startMinimized,
    launchOnStartup: !!raw?.launchOnStartup,
  };
}

function writeConfig(c) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const { githubToken, ...rest } = c || {};
  const tokenFields = encodeToken(githubToken || '');
  const out = { ...rest, ...tokenFields };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8');
  // Lock the file down on POSIX even when encrypted — the rest of the
  // config (programsRoot, prefs) doesn't need world-read either, and on
  // Linux without a keyring we fall back to plaintext, so 0600 is load-
  // bearing in that path.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  }
}

function ensureProgramsRoot() {
  const root = readConfig().programsRoot;
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  return root;
}

// ---------- registry (~/.config/cove-nexus/installs.json) ----------
// Shape: { [slug]: { tag, path, source: 'managed' | 'adopted' } }

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(INSTALLS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeRegistry(reg) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(INSTALLS_FILE, JSON.stringify(reg, null, 2), 'utf8');
}

function registerInstall(slug, info) {
  const reg = readRegistry();
  reg[slug] = { ...(reg[slug] || {}), ...info };
  writeRegistry(reg);
}

function forgetInstall(slug) {
  const reg = readRegistry();
  delete reg[slug];
  writeRegistry(reg);
}

// ---------- asset naming ----------

// electron-builder uses different casings per platform. Case-insensitive
// matching handles: cove-video-editor, Cove-Video-Editor, Cove-GIF-Maker.
function assetPatternsForSlug(slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`^${esc}-(\\d[\\d.]*)-Portable\\.exe$`, 'i'),
    new RegExp(`^${esc}-(\\d[\\d.]*)-Setup\\.exe$`, 'i'),
    new RegExp(`^${esc}-(\\d[\\d.]*)-x86_64\\.AppImage$`, 'i'),
    new RegExp(`^${esc}_(\\d[\\d.]*)_amd64\\.deb$`, 'i'),
  ];
}

function matchAsset(slug, filename) {
  for (const re of assetPatternsForSlug(slug)) {
    const m = filename.match(re);
    if (m) return { version: m[1] };
  }
  return null;
}

// Extract a cove-* slug from a release-artifact filename without knowing
// the slug in advance. Used by adoption when walking arbitrary folders.
function detectSlugFromFilename(name) {
  const m = name.match(/^(cove(?:[-_][a-z0-9]+)+)(?:[-_.])(\d[\d.]*)[-_.]/i);
  if (!m) return null;
  return m[1].toLowerCase().replace(/_/g, '-');
}

// Ordered regexes — first asset whose name matches wins. Preference is
// Portable.exe on Windows (Cove Nexus fully manages these, no installer
// wizard flash) and x86_64.AppImage on Linux.
function assetPreferencesForPlatform() {
  if (process.platform === 'win32') {
    return [/-Portable\.exe$/i, /-Setup\.exe$/i, /\.exe$/i];
  }
  if (process.platform === 'linux') {
    return [/x86_64\.AppImage$/i, /\.AppImage$/i, /amd64\.deb$/i];
  }
  return [];
}

function pickAsset(assets) {
  for (const re of assetPreferencesForPlatform()) {
    const hit = (assets || []).find(a => re.test(a?.name || ''));
    if (hit) return hit;
  }
  return null;
}

// ---------- adoption ----------

// Walk the programs root and adopt any file whose name matches a cove-*
// release artifact that isn't already in the registry. Runs on boot and
// on every scan, so files added between runs are picked up.
function adoptFromProgramsRoot() {
  const root = readConfig().programsRoot;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const reg = readRegistry();
  let changed = false;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const slug = detectSlugFromFilename(entry.name);
    if (!slug) continue;
    const match = matchAsset(slug, entry.name);
    if (!match) continue;
    if (reg[slug] && reg[slug].path && exists(reg[slug].path)) continue;
    reg[slug] = {
      tag: `v${match.version}`,
      path: path.join(root, entry.name),
      source: 'adopted',
    };
    changed = true;
  }
  if (changed) writeRegistry(reg);
}

// ---------- legacy migration from ~/.cove-suite/ ----------

// One-shot walk: if ~/.cove-suite/programs/<slug>/ has a real binary (either
// recorded in installed.json from fixed v1.0.0, or sitting under bin/),
// register it in the new installs.json pointing at its existing path.
// We do NOT move files — users may prefer them where they are, and a
// half-completed move is worse than a pointer.
function migrateLegacyInstalls() {
  if (!exists(LEGACY_PROGRAMS)) return;
  let slugDirs = [];
  try {
    slugDirs = fs.readdirSync(LEGACY_PROGRAMS, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch { return; }

  const reg = readRegistry();
  let changed = false;

  for (const slug of slugDirs) {
    if (reg[slug]?.path && exists(reg[slug].path)) continue;
    const slugDir = path.join(LEGACY_PROGRAMS, slug);

    try {
      const info = JSON.parse(fs.readFileSync(path.join(slugDir, 'installed.json'), 'utf8'));
      if (info?.entry) {
        const abs = path.join(slugDir, info.entry);
        if (exists(abs)) {
          reg[slug] = { tag: info.tag || '', path: abs, source: 'managed' };
          changed = true;
          continue;
        }
      }
    } catch {}

    const binDir = path.join(slugDir, 'bin');
    if (exists(binDir)) {
      try {
        for (const f of fs.readdirSync(binDir)) {
          const m = matchAsset(slug, f);
          if (m) {
            reg[slug] = { tag: `v${m.version}`, path: path.join(binDir, f), source: 'managed' };
            changed = true;
            break;
          }
        }
      } catch {}
    }
    // If neither installed.json nor a bin/ binary resolves, it's a
    // pre-fix v1.0.0 git clone; isLegacyClone() below flags it for reinstall.
  }

  if (changed) writeRegistry(reg);
}

// When a Sin213 repo is renamed (e.g. cove-upscaler → cove-image-upscaler),
// GitHub 301-redirects the API but the local installs.json keeps the old
// slug and the static program registry uses the new one — leaving the user
// with an orphan registry entry that doesn't match any card. Walk a known
// rename table and rekey on first boot. Idempotent.
const RENAMED_SLUGS = {
  'cove-upscaler': 'cove-image-upscaler',
};
function migrateRenamedSlugs() {
  const reg = readRegistry();
  let changed = false;
  for (const [oldSlug, newSlug] of Object.entries(RENAMED_SLUGS)) {
    if (!reg[oldSlug]) continue;
    // If the new slug already has an entry the user reinstalled under the
    // new name; drop the old one so we don't shadow the fresher install.
    if (!reg[newSlug]) reg[newSlug] = reg[oldSlug];
    delete reg[oldSlug];
    changed = true;
  }
  if (changed) writeRegistry(reg);
}

function isLegacyClone(slug) {
  const d = path.join(LEGACY_PROGRAMS, slug);
  if (!exists(d)) return false;
  if (!exists(path.join(d, '.git'))) return false;
  const reg = readRegistry();
  // Migration may have already registered a real binary from this slug dir.
  return !(reg[slug]?.path && exists(reg[slug].path));
}

// ---------- https ----------

function ghHeaders() {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const tok = readConfig().githubToken;
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

// In-memory cache, keyed by URL. Aggressive caching is the main defense
// against hitting the 60/hr unauthenticated rate limit while the user
// pokes at the UI.
const API_TTL_MS = 5 * 60 * 1000;
const apiCache = new Map();  // url -> { at, data }
// When we observe rate-limit headers, block outbound calls until this ms.
// Callers fall back to cached data if they have any.
let rateLimitUntil = 0;
let rateLimitAuthed = false;  // whether the limit we hit was on an authed request

function cacheGet(url) {
  const ent = apiCache.get(url);
  if (!ent) return null;
  if (Date.now() - ent.at > API_TTL_MS) { apiCache.delete(url); return null; }
  return ent.data;
}

function cacheSet(url, data) { apiCache.set(url, { at: Date.now(), data }); }

function clearApiCache() { apiCache.clear(); rateLimitUntil = 0; }

function recordRateLimit(res) {
  const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '-1', 10);
  const resetSec = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
  if (remaining === 0 && resetSec > 0) {
    rateLimitUntil = resetSec * 1000;
    rateLimitAuthed = !!readConfig().githubToken;
  }
}

function httpsGetJson(url, headers = {}, { allowCache = true } = {}) {
  if (allowCache) {
    const cached = cacheGet(url);
    if (cached) return Promise.resolve(cached);
  }
  if (Date.now() < rateLimitUntil) {
    return Promise.reject(new Error(`github rate-limited until ${new Date(rateLimitUntil).toLocaleTimeString()}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { ...ghHeaders(), ...headers },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetJson(res.headers.location, headers, { allowCache: false }).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        recordRateLimit(res);
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(body);
            cacheSet(url, parsed);
            resolve(parsed);
          } catch (e) { reject(e); }
          return;
        }
        // 403 with rate-limit exhaustion is the common case here; be
        // explicit so the UI can surface "try again at X:YY" instead of a
        // generic error.
        if (res.statusCode === 403 && /rate limit/i.test(body)) {
          if (!rateLimitUntil) {
            // Fall back to a 1-hour window if the server didn't send reset.
            rateLimitUntil = Date.now() + 60 * 60 * 1000;
            rateLimitAuthed = !!readConfig().githubToken;
          }
          const cached = cacheGet(url);
          if (cached) return resolve(cached);
          return reject(new Error(`github rate-limited until ${new Date(rateLimitUntil).toLocaleTimeString()}`));
        }
        reject(new Error(`github ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// maxBytes (optional) caps how much we'll write to disk. Caller passes the
// expected GitHub asset size plus a small tolerance; if the server hands us
// more than that we abort. Without this an attacker who could swap a redirect
// target for a bottomless stream would just fill the user's disk.
function downloadToFile(url, dest, onProgress, { maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let finished = false;
    let received = 0;
    let total = 0;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      file.close(() => fs.unlink(dest, () => reject(err)));
    };
    const follow = (u, redirects) => {
      if (redirects > 5) return fail(new Error('too many redirects'));
      const req = https.get(u, {
        headers: { 'User-Agent': UA, 'Accept': 'application/octet-stream' },
        timeout: 60000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`download ${res.statusCode} for ${u}`));
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        if (maxBytes && total && total > maxBytes) {
          res.resume();
          return fail(new Error(`download too large: ${total} > ${maxBytes}`));
        }
        if (onProgress) onProgress({ received: 0, total });
        res.on('data', (chunk) => {
          received += chunk.length;
          if (maxBytes && received > maxBytes) {
            req.destroy();
            return fail(new Error(`download exceeded ${maxBytes} bytes`));
          }
          if (onProgress) onProgress({ received, total });
        });
        res.pipe(file);
        file.on('finish', () => {
          if (finished) return;
          finished = true;
          file.close((err) => err ? reject(err) : resolve());
        });
        res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', fail);
    };
    file.on('error', fail);
    follow(url, 0);
  });
}

async function fetchLatestRelease(slug) {
  return httpsGetJson(`https://api.github.com/repos/${GITHUB_OWNER}/${slug}/releases/latest`);
}

async function fetchReleases(slug) {
  return httpsGetJson(`https://api.github.com/repos/${GITHUB_OWNER}/${slug}/releases?per_page=30`);
}

async function fetchReleaseByTag(slug, tag) {
  const t = encodeURIComponent(tag);
  return httpsGetJson(`https://api.github.com/repos/${GITHUB_OWNER}/${slug}/releases/tags/${t}`);
}

// ---------- install / update / launch ----------

// Resolve which release to install: the user's pin, an explicit tag, or latest.
async function resolveRelease(slug, { tag, usePin = true } = {}) {
  if (tag) return fetchReleaseByTag(slug, tag);
  if (usePin) {
    const pinned = readRegistry()[slug]?.pinnedTag;
    if (pinned) {
      try { return await fetchReleaseByTag(slug, pinned); }
      catch (e) { /* pinned tag removed upstream; fall through to latest */ }
    }
  }
  return fetchLatestRelease(slug);
}

function sendProgress(slug, payload) {
  try { mainWindow?.webContents.send('cove:install:progress', { slug, ...payload }); } catch {}
}

async function installOrUpdate(slug, { force = false, tag: explicitTag } = {}) {
  sendProgress(slug, { phase: 'resolving' });
  const release = await resolveRelease(slug, { tag: explicitTag });
  const tag = release?.tag_name || '';
  const asset = pickAsset(release?.assets);
  if (!asset) {
    sendProgress(slug, { phase: 'error' });
    const plat = process.platform === 'darwin' ? 'macOS' : process.platform;
    throw new Error(`No ${plat} build available in release ${tag || '(unknown)'}.`);
  }

  const reg = readRegistry();
  const current = reg[slug];
  const root = ensureProgramsRoot();
  const finalPath = path.join(root, asset.name);

  if (!force && current?.tag === tag && current.path && exists(current.path)) {
    sendProgress(slug, { phase: 'done' });
    return { ok: true, already: true, tag };
  }

  const tmp = path.join(root, `.${asset.name}.part`);
  sendProgress(slug, { phase: 'download', received: 0, total: asset.size || 0 });
  // Hard cap: the GitHub-reported asset size plus 1 MiB of slack, falling back
  // to a 1 GiB ceiling if the API didn't give us a size. Releases beyond that
  // either aren't real or aren't ours.
  const maxBytes = asset.size ? asset.size + 1024 * 1024 : 1024 * 1024 * 1024;
  try {
    await downloadToFile(asset.browser_download_url, tmp, (p) => {
      sendProgress(slug, { phase: 'download', received: p.received, total: p.total || asset.size || 0 });
    }, { maxBytes });
  } catch (err) {
    sendProgress(slug, { phase: 'error' });
    throw err;
  }

  // Optional checksum verification — looks for an asset named "<asset>.sha256"
  // alongside the binary. Absent → skip silently; mismatch → abort.
  const shaAsset = (release.assets || []).find(a => a?.name === `${asset.name}.sha256`);
  if (shaAsset) {
    sendProgress(slug, { phase: 'verify' });
    try {
      const shaTmp = path.join(root, `.${asset.name}.sha256.part`);
      // .sha256 sidecars are tiny — anything over 1 KiB is suspect.
      await downloadToFile(shaAsset.browser_download_url, shaTmp, null, { maxBytes: 1024 });
      const shaText = fs.readFileSync(shaTmp, 'utf8').trim();
      fs.unlinkSync(shaTmp);
      // Accept "<hex>" or "<hex>  filename" (sha256sum format).
      const expected = (shaText.split(/\s+/)[0] || '').toLowerCase();
      const actual = await sha256File(tmp);
      if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        sendProgress(slug, { phase: 'error' });
        throw new Error(`checksum mismatch for ${asset.name} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
      }
    } catch (err) {
      if (/checksum mismatch/i.test(err.message || '')) throw err;
      // Download or parse error on the .sha256 file itself — don't block
      // the install, just log. The binary itself succeeded.
      console.warn('[cove-sha256]', err?.message || err);
    }
  }

  sendProgress(slug, { phase: 'install' });
  // Only delete the prior file if we put it there. Adopted files belong
  // to the user; we leave them alone and just point the registry at the
  // new download.
  if (current?.source === 'managed' && current.path && current.path !== finalPath && exists(current.path)) {
    await fsp.rm(current.path, { force: true }).catch(() => {});
  }

  await fsp.rename(tmp, finalPath);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(finalPath, 0o755); } catch {}
  }

  // Preserve pinnedTag across updates — the pin is user intent, not a
  // function of the release we just downloaded.
  registerInstall(slug, {
    tag,
    path: finalPath,
    source: 'managed',
    ...(current?.pinnedTag ? { pinnedTag: current.pinnedTag } : {}),
  });
  sendProgress(slug, { phase: 'done' });
  return { ok: true, tag };
}

function sha256File(filePath) {
  const crypto = require('node:crypto');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function planFromPath(absPath) {
  if (/\.AppImage$/i.test(absPath)) return { cmd: absPath, args: [], kind: 'appimage' };
  if (/\.exe$/i.test(absPath))      return { cmd: absPath, args: [], kind: 'exe' };
  if (/\.deb$/i.test(absPath))      return { cmd: 'xdg-open', args: [absPath], kind: 'deb' };
  return { cmd: absPath, args: [], kind: 'exec' };
}

// ---------- scan ----------

async function scanOneInstalled(slug, info) {
  let latestTag = '';
  let notesBody = '';
  let notesUrl = '';
  try {
    const rel = await fetchLatestRelease(slug);
    latestTag = rel?.tag_name || '';
    notesUrl = rel?.html_url || '';
    // Keep the card-preview small — we trim to first 400 chars here, and the
    // renderer clamps visually to 2 lines. Strip HTML-comment boilerplate
    // that electron-builder-generated notes sometimes contain.
    const raw = typeof rel?.body === 'string' ? rel.body : '';
    notesBody = raw.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 400);
  } catch {}
  // Pinned installs suppress the update prompt even when a newer release
  // exists upstream. The user explicitly asked to stay on this version.
  const pinned = info.pinnedTag || '';
  const hasUpdate = pinned
    ? false
    : !!(latestTag && info.tag && latestTag !== info.tag);
  return {
    slug,
    manifest: null,
    installed: true,
    source: info.source || 'managed',
    version: info.tag || '',
    latestTag,
    hasUpdate,
    pinnedTag: pinned,
    // Always return the latest-release pointer when we have one, even with
    // an empty body — the card still benefits from the tag + "more…" link.
    releaseNotes: latestTag ? { tag: latestTag, body: notesBody, url: notesUrl } : null,
  };
}

// Whitelist for any slug that flows from the renderer into a path
// component, registry lookup, deletion target, or process spawn. Defends
// the main process against a compromised or malformed renderer crafting
// values like "../../../etc/passwd". Mirror the GitHub repo-name rules.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
function isValidSlug(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && SLUG_RE.test(s);
}

// ---------- IPC: app + config ----------

ipcMain.handle('cove:appInfo', () => ({
  version: app.getVersion(),
  name: app.getName(),
  packaged: app.isPackaged,
}));

ipcMain.handle('cove:config:get', () => {
  const cfg = readConfig();
  return {
    programsRoot: cfg.programsRoot,
    userData: USER_DATA,
    defaultRoot: defaultProgramsRoot(),
    // Don't leak the token to the renderer — only whether one is set.
    hasGithubToken: !!cfg.githubToken,
    rateLimitedUntil: rateLimitUntil,
    minimizeToTray: !!cfg.minimizeToTray,
    startMinimized: !!cfg.startMinimized,
    launchOnStartup: !!cfg.launchOnStartup,
    platform: process.platform,
  };
});

ipcMain.handle('cove:config:setPreferences', (_e, prefs = {}) => {
  const cfg = readConfig();
  if (typeof prefs.minimizeToTray === 'boolean')  cfg.minimizeToTray  = prefs.minimizeToTray;
  if (typeof prefs.startMinimized === 'boolean')  cfg.startMinimized  = prefs.startMinimized;
  if (typeof prefs.launchOnStartup === 'boolean') cfg.launchOnStartup = prefs.launchOnStartup;
  writeConfig(cfg);
  applyLoginItem(cfg);
  return {
    ok: true,
    minimizeToTray: cfg.minimizeToTray,
    startMinimized: cfg.startMinimized,
    launchOnStartup: cfg.launchOnStartup,
  };
});

ipcMain.handle('cove:config:setGithubToken', (_e, token) => {
  const cfg = readConfig();
  cfg.githubToken = typeof token === 'string' ? token.trim() : '';
  writeConfig(cfg);
  // A new token resets our view of the rate limit (authed and unauthed
  // buckets are separate) and invalidates cache so next call uses the
  // new credentials.
  clearApiCache();
  return { ok: true, hasGithubToken: !!cfg.githubToken };
});

ipcMain.handle('cove:config:setProgramsRoot', async () => {
  const cfg = readConfig();
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose programs folder',
    defaultPath: cfg.programsRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.length) return { ok: false, cancelled: true };
  const next = filePaths[0];
  try {
    fs.mkdirSync(next, { recursive: true });
    writeConfig({ ...cfg, programsRoot: next });
    adoptFromProgramsRoot();
    return { ok: true, programsRoot: next };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:config:revealConfigDir', () => {
  shell.openPath(USER_DATA);
  return { ok: true };
});

ipcMain.handle('cove:config:revealProgramsRoot', () => {
  const root = readConfig().programsRoot;
  if (!exists(root)) return { ok: false, error: 'missing' };
  shell.openPath(root);
  return { ok: true };
});

// ---------- IPC: scan / install / update / launch ----------

ipcMain.handle('cove:getState', async () => ({
  programsRoot: readConfig().programsRoot,
  installed: Object.keys(readRegistry()),
}));

ipcMain.handle('cove:scan', async (_e, opts = {}) => {
  adoptFromProgramsRoot();
  const checkUpdates = opts.checkUpdates !== false;
  const reg = readRegistry();

  // Prune registry entries whose file has vanished, so the UI flips them
  // back to "not installed" instead of showing a phantom launch button.
  let pruned = false;
  for (const [slug, info] of Object.entries(reg)) {
    if (info?.path && !exists(info.path)) {
      delete reg[slug];
      pruned = true;
    }
  }
  if (pruned) writeRegistry(reg);

  const rows = await Promise.all(Object.entries(reg).map(async ([slug, info]) => {
    if (!checkUpdates) {
      return { slug, manifest: null, installed: true, hasUpdate: false,
               version: info.tag || '', source: info.source || 'managed',
               pinnedTag: info.pinnedTag || '' };
    }
    try { return await scanOneInstalled(slug, info); }
    catch {
      return { slug, manifest: null, installed: true, hasUpdate: false,
               version: info.tag || '', source: info.source || 'managed',
               pinnedTag: info.pinnedTag || '' };
    }
  }));

  // Surface legacy git-clone installs so the UI can show them as stale.
  if (exists(LEGACY_PROGRAMS)) {
    try {
      for (const d of fs.readdirSync(LEGACY_PROGRAMS, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (!isLegacyClone(d.name)) continue;
        if (reg[d.name]) continue;
        rows.push({ slug: d.name, manifest: null, installed: true, hasUpdate: true,
                    legacy: true, version: '', latestTag: '' });
      }
    } catch {}
  }

  return { programsRoot: readConfig().programsRoot, installed: rows, rateLimitedUntil: rateLimitUntil };
});

ipcMain.handle('cove:install', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  // If a legacy git clone is blocking the slug, clear it — the new binary
  // will land in the programs root, not in ~/.cove-suite.
  const legacyDir = path.join(LEGACY_PROGRAMS, slug);
  if (isLegacyClone(slug)) {
    await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {});
  }
  try { return await installOrUpdate(slug, { force: false }); }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('cove:update', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const reg = readRegistry();
  const legacyDir = path.join(LEGACY_PROGRAMS, slug);
  if (!reg[slug] && !exists(legacyDir)) return { ok: false, error: 'not installed' };
  if (isLegacyClone(slug)) {
    await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {});
  }
  try { return await installOrUpdate(slug, { force: false }); }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('cove:launch', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  if (isLegacyClone(slug)) {
    return { ok: false, error: 'This install is from an older version. Click Update to reinstall as a binary.' };
  }
  const info = readRegistry()[slug];
  if (!info?.path) return { ok: false, error: 'Not installed.' };
  if (!exists(info.path)) return { ok: false, error: `Missing: ${info.path}` };

  const plan = planFromPath(info.path);
  try {
    const child = spawn(plan.cmd, plan.args, {
      cwd: path.dirname(info.path),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    // Let the OS surface ENOENT/EACCES synchronously before we report
    // success. Without this, a failed spawn looked identical to a launch.
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
        resolve({ ok: true, kind: plan.kind });
      }, 600);
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:revealInstall', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const info = readRegistry()[slug];
  if (info?.path && exists(info.path)) {
    shell.showItemInFolder(info.path);
    return { ok: true };
  }
  const legacyDir = path.join(LEGACY_PROGRAMS, slug);
  if (exists(legacyDir)) { shell.openPath(legacyDir); return { ok: true }; }
  const root = readConfig().programsRoot;
  if (exists(root)) { shell.openPath(root); return { ok: true }; }
  return { ok: false, error: 'missing' };
});

ipcMain.handle('cove:confirmUpdateAll', async (_e, names = []) => {
  const list = Array.isArray(names) && names.length
    ? names.map(n => `  • ${n}`).join('\n')
    : '';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Update all'],
    defaultId: 1,
    cancelId: 0,
    title: 'Update all',
    message: `Update ${names.length} ${names.length === 1 ? 'program' : 'programs'}?`,
    detail: list
      ? `This will update every program listed below. If you don't want a specific one updated, cancel and use its card instead.\n\n${list}`
      : `This will update every program that has an available update.`,
  });
  return { ok: response === 1 };
});

// Batch-fetch /releases/latest for any list of slugs — used by the renderer
// to populate the card release-notes block on *all* programs (installed or
// not). Backed by the same 5-min cache as the installed-scan path, so this
// doesn't meaningfully increase API volume.
ipcMain.handle('cove:latestReleases', async (_e, slugs = []) => {
  if (!Array.isArray(slugs)) return { ok: false, error: 'slugs must be array' };
  const releases = {};
  await Promise.all(slugs.map(async (slug) => {
    if (!isValidSlug(slug)) return;
    try {
      const rel = await fetchLatestRelease(slug);
      const tag = rel?.tag_name || '';
      if (!tag) return;
      const body = (typeof rel?.body === 'string' ? rel.body : '')
        .replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 400);
      releases[slug] = { tag, body, url: rel?.html_url || '' };
    } catch {
      // Private / missing / rate-limited — silently skip; the card just
      // won't show a release-notes block.
    }
  }));
  return { ok: true, releases, rateLimitedUntil: rateLimitUntil };
});

ipcMain.handle('cove:releases', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  try {
    const releases = await fetchReleases(slug);
    const rows = (releases || [])
      .filter(r => !r.draft)
      .map(r => ({
        tag: r.tag_name || '',
        name: r.name || r.tag_name || '',
        prerelease: !!r.prerelease,
        publishedAt: r.published_at || r.created_at || '',
        hasAsset: !!pickAsset(r.assets),
      }));
    return { ok: true, releases: rows, current: readRegistry()[slug]?.tag || '', pinned: readRegistry()[slug]?.pinnedTag || '' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:pin', async (_e, slug, tag) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  if (!tag || typeof tag !== 'string') return { ok: false, error: 'no tag' };
  // Install the pinned tag first, then record the pin. If the download
  // fails we don't want a pin pointing at a version that was never
  // installed, so order matters.
  try {
    await installOrUpdate(slug, { force: true, tag });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  registerInstall(slug, { pinnedTag: tag });
  return { ok: true, tag };
});

ipcMain.handle('cove:unpin', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const reg = readRegistry();
  if (!reg[slug]) return { ok: false, error: 'not installed' };
  delete reg[slug].pinnedTag;
  writeRegistry(reg);
  return { ok: true };
});

ipcMain.handle('cove:setCustomPath', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const filters = process.platform === 'win32'
    ? [{ name: 'Executable', extensions: ['exe'] }]
    : [{ name: 'AppImage', extensions: ['AppImage', 'appimage'] }, { name: 'All files', extensions: ['*'] }];
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: `Select binary for ${slug}`,
    properties: ['openFile'],
    filters,
  });
  if (canceled || !filePaths?.length) return { ok: false, cancelled: true };
  const chosen = filePaths[0];
  if (!exists(chosen)) return { ok: false, error: 'file does not exist' };

  // Try to parse a version out of the filename so the UI has something
  // to show; if we can't, fall back to "unknown".
  let tag = '';
  const match = matchAsset(slug, path.basename(chosen));
  if (match) tag = `v${match.version}`;
  if (process.platform !== 'win32') {
    try { fs.chmodSync(chosen, 0o755); } catch {}
  }
  registerInstall(slug, { tag, path: chosen, source: 'adopted' });
  return { ok: true, path: chosen, tag };
});

ipcMain.handle('cove:uninstall', async (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const info = readRegistry()[slug];
  const legacyDir = path.join(LEGACY_PROGRAMS, slug);
  if (!info && !exists(legacyDir)) return { ok: true, already: true };

  const adopted = info?.source === 'adopted';
  const buttons = adopted ? ['Cancel', 'Forget'] : ['Cancel', 'Remove'];
  const detail = adopted
    ? `The file at ${info.path} will be kept — Cove Nexus didn't put it there. Only the registry entry is cleared, and the tool will show as "not installed" until you re-adopt it.`
    : info?.path
      ? `This deletes ${info.path}.`
      : `This deletes ${legacyDir}.`;
  const { response } = await dialog.showMessageBox({
    type: 'warning', buttons, defaultId: 0, cancelId: 0,
    title: buttons[1],
    message: adopted ? `Forget ${slug}?` : `Remove ${slug}?`,
    detail,
  });
  if (response !== 1) return { ok: false, cancelled: true };

  if (!adopted && info?.path && exists(info.path)) {
    await fsp.rm(info.path, { force: true }).catch(() => {});
  }
  if (exists(legacyDir)) {
    await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {});
  }
  forgetInstall(slug);
  return { ok: true };
});

ipcMain.handle('cove:window:close', () => { BrowserWindow.getFocusedWindow()?.close(); });
ipcMain.handle('cove:window:minimize', () => { BrowserWindow.getFocusedWindow()?.minimize(); });
ipcMain.handle('cove:window:maximizeToggle', () => {
  const w = BrowserWindow.getFocusedWindow();
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.handle('cove:window:isMaximized', () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false);

// ---------- GitHub discovery ----------

ipcMain.handle('cove:discover', async (_e, opts = {}) => {
  const url = `https://api.github.com/users/${GITHUB_OWNER}/repos?per_page=100&sort=updated`;
  if (opts.force) apiCache.delete(url);
  try {
    const repos = await httpsGetJson(url);
    // Bot repos (e.g. cove-*-bot) aren't user-installable tools, so we hide
    // them from discovery. Anything with "bot" in the name is excluded.
    const mapped = (repos || [])
      .filter(r => typeof r?.name === 'string'
        && /^cove-/i.test(r.name)
        && !/bot/i.test(r.name)
        && r.name !== GITHUB_REPO
        && !r.archived && !r.disabled)
      .map(r => ({
        slug: r.name,
        name: prettyName(r.name),
        desc: r.description || '',
        lang: r.language || '—',
        updated: formatUpdated(r.pushed_at || r.updated_at),
        version: '',
        fork: !!r.fork,
      }));
    return { ok: true, repos: mapped, rateLimitedUntil: rateLimitUntil };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), rateLimitedUntil: rateLimitUntil };
  }
});

// Explicit cache-clear + rate-limit state probe. Refresh button calls this
// before rescan so manual refresh actually hits GitHub.
ipcMain.handle('cove:refresh', () => {
  clearApiCache();
  return { ok: true };
});

ipcMain.handle('cove:rateLimit', () => ({
  until: rateLimitUntil,
  authed: rateLimitAuthed,
  tokenSet: !!readConfig().githubToken,
}));

function prettyName(slug) {
  return slug.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function formatUpdated(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
  } catch { return '—'; }
}
