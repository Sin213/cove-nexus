const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Tray, Menu, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFileSync } = require('node:child_process');
const os = require('node:os');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');

const APP_ID = 'cove-nexus';
const GITHUB_OWNER = 'Sin213';
const GITHUB_REPO = 'cove-nexus';
const UA = 'cove-nexus-launcher';
// Repos under the cove- namespace that are not installable tools.
// Note: repos with no GitHub release are already hidden by the release gate in
// cove:discover. Add entries here only for repos that have releases but should
// still be excluded (e.g. internal tooling).
const EXCLUDED_REPOS = new Set([]);

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
  // Fail-closed: cancel every main-frame navigation away from index.html, then
  // forward only http(s) URLs to the system browser. Without the unconditional
  // preventDefault, a coerced `location.href = 'javascript:…'` or `file:///…`
  // would actually navigate the renderer.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) {
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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    childViews.clear();
  });
  win.on('close', (e) => {
    const c = readConfig();
    if (!app.isQuitting && c.minimizeToTray && tray) {
      e.preventDefault();
      win.hide();
      return;
    }
    // Window will be destroyed — detach hosted child views while contentView is still alive.
    for (const slug of childViews) {
      const v = hostedViews.get(slug);
      if (v) try { win.contentView.removeChildView(v); } catch (_) {}
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

function linuxAutostartFile() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', `${APP_ID}.desktop`);
}

function quoteDesktopExecPath(exePath) {
  return `"${String(exePath).replace(/%/g, '%%').replace(/(["\\`$])/g, '\\$1')}"`;
}

function linuxAutostartExec() {
  if (app.isPackaged) return quoteDesktopExecPath(ownExePath());
  return `${quoteDesktopExecPath(ownExePath())} ${quoteDesktopExecPath(app.getAppPath())}`;
}

function applyLinuxAutostart(cfg) {
  const file = linuxAutostartFile();
  try {
    if (!cfg.launchOnStartup) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Cove Nexus',
      'Comment=Launch Cove Nexus on login',
      `Exec=${linuxAutostartExec()}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'), 'utf8');
  } catch (err) {
    console.error('[cove-loginitem] Linux autostart failed:', err?.message || err);
  }
}

// Login item (launch on startup). Electron handles this natively on
// Windows and macOS; Linux uses the XDG autostart .desktop convention.
function applyLoginItem(cfg) {
  if (process.platform === 'linux') {
    applyLinuxAutostart(cfg);
    return;
  }
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
  cleanupStaleProtocolSockets(); // best-effort, non-blocking
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

app.on('before-quit', () => {
  for (const [slug] of socketServers) {
    cleanupSocketServer(slug); // async, best-effort
  }
  for (const slug of [...hostedViews.keys()]) {
    destroyHostedView(slug);
  }
  for (const [slug] of smokeServers) {
    stopSmokeServer(slug);
  }
});

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
  // Validated projection of renderer-driven UX prefs. These must round-trip
  // through readConfig → setPreferences → writeConfig, otherwise saving one
  // pref would silently erase the others from config.json on the next write.
  const toolOrder = Array.isArray(raw?.toolOrder)
    ? raw.toolOrder.filter(s => typeof s === 'string' && isValidSlug(s))
    : [];
  const seenBm = new Set();
  const bookmarks = Array.isArray(raw?.bookmarks)
    ? raw.bookmarks.filter(s => typeof s === 'string' && isValidSlug(s) && !seenBm.has(s) && seenBm.add(s)).sort()
    : [];
  const theme = raw?.theme === 'light' ? 'light' : 'dark';
  return {
    programsRoot: typeof raw?.programsRoot === 'string' && raw.programsRoot
      ? raw.programsRoot
      : defaultProgramsRoot(),
    githubToken: token,
    minimizeToTray: raw?.minimizeToTray !== false,
    startMinimized: !!raw?.startMinimized,
    launchOnStartup: !!raw?.launchOnStartup,
    closeAfterLaunch: !!raw?.closeAfterLaunch,
    foxyMode: !!raw?.foxyMode,
    toolOrder,
    bookmarks,
    theme,
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

let _registryCache = null;

function readRegistry() {
  if (_registryCache !== null) return _registryCache;
  try { _registryCache = JSON.parse(fs.readFileSync(INSTALLS_FILE, 'utf8')) || {}; }
  catch { _registryCache = {}; }
  return _registryCache;
}

function writeRegistry(reg) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(INSTALLS_FILE, JSON.stringify(reg, null, 2), 'utf8');
  _registryCache = reg;
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
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

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

function buildNexusEnv(slug, runId, appName, socketPath, openMode) {
  const env = {
    COVE_NEXUS: '1',
    COVE_NEXUS_PROTOCOL_VERSION: String(SUPPORTED_PROTOCOL_VERSION),
    COVE_NEXUS_TOOL_SLUG: slug,
    COVE_NEXUS_RUN_ID: runId,
    COVE_NEXUS_APP_NAME: appName,
  };
  if (socketPath) env.COVE_NEXUS_SOCKET = socketPath;
  if (openMode === 'tab-web') env.COVE_NEXUS_OPEN_MODE = 'tab-web';
  return env;
}

const socketServers = new Map(); // slug → { server, sockPath, sockDir, xdgBased }
const notificationRateLimits = new Map(); // slug → lastNotifTimestamp (ms)

async function createSocketDir() {
  const xdgDir = process.env.XDG_RUNTIME_DIR;
  if (xdgDir) {
    try {
      const dir = path.join(xdgDir, 'cove-nexus');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      // Verify the existing-or-newly-created directory is actually private.
      // mkdir with { recursive: true } silently ignores the mode if the dir
      // already exists, so we must stat and check rather than trust the call.
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new Error('not a directory');
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        throw new Error('not owned by current user');
      }
      if ((st.mode & 0o077) !== 0) throw new Error('directory is not private');
      return { dir, xdgBased: true };
    } catch { /* fall through to private mkdtemp */ }
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cove-nexus-'));
  try { await fsp.chmod(tmp, 0o700); } catch { /* best effort */ }
  return { dir: tmp, xdgBased: false };
}

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

function listenOnSocket(server, sockPath) {
  return new Promise((resolve, reject) => {
    let retried = false;
    server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE' && !retried) {
        retried = true;
        try { await fsp.unlink(sockPath); } catch { /* ignore */ }
        server.once('error', reject);
        server.listen(sockPath, resolve);
      } else {
        reject(err);
      }
    });
    server.listen(sockPath, resolve);
  });
}

function processProtocolLine(slug, rawLine) {
  let msg;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    return;
  }

  if (!msg || typeof msg !== 'object') return;
  if (!msg.type || !msg.runId || msg.protocolVersion === undefined) return;
  if (typeof msg.ts !== 'string' && typeof msg.ts !== 'number') return;

  const entry = processRegistry.get(slug);
  if (!entry || !['launching', 'running'].includes(entry.status)) return;
  if (msg.runId !== entry.runId) return;

  if (typeof msg.protocolVersion !== 'number' || msg.protocolVersion > SUPPORTED_PROTOCOL_VERSION) return;

  const known = ['app_ready', 'status_update', 'active_document', 'progress_update', 'notification', 'app_exiting', 'tab_ready'];
  if (!known.includes(msg.type)) return;

  handleProtocolMessage(slug, msg);
}

function handleSocketConnection(slug, socket) {
  // Buffer raw bytes so size enforcement is against UTF-8 byte length, not
  // JS string code units. The spec's 4096-byte limit is a byte count.
  let buf = Buffer.alloc(0);
  const NL = 0x0a; // newline byte
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Process all complete lines first, enforcing per-line byte size.
    let nl;
    while ((nl = buf.indexOf(NL)) !== -1) {
      const rawBytes = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (rawBytes.length > MAX_PROTO_LINE) continue; // line too long in bytes → drop silently
      const line = rawBytes.toString('utf8').trim();
      if (line) processProtocolLine(slug, line);
    }
    // After complete lines are consumed, guard the remaining partial line by byte length.
    if (buf.length > MAX_PROTO_LINE) {
      console.warn(`[cove-proto] oversized partial line from ${slug}, dropping connection`);
      socket.destroy();
      buf = Buffer.alloc(0);
    }
  });
  socket.on('error', () => { /* connection errors are normal */ });
}

async function createSocketServer(slug, runId) {
  if (process.platform !== 'linux') return null;

  let dir, xdgBased;
  try {
    ({ dir, xdgBased } = await createSocketDir());
  } catch {
    return null;
  }

  const sockPath = path.join(dir, `${runId}.sock`);
  const server = net.createServer((socket) => handleSocketConnection(slug, socket));

  try {
    await listenOnSocket(server, sockPath);
  } catch (err) {
    console.warn(`[cove-proto] socket listen failed for ${slug}:`, err?.message);
    try { server.close(); } catch { /* ignore */ }
    if (!xdgBased) {
      try { await fsp.rmdir(dir); } catch { /* ignore */ }
    }
    return null;
  }

  socketServers.set(slug, { server, sockPath, sockDir: dir, xdgBased });
  return sockPath;
}

async function cleanupStaleProtocolSockets() {
  if (process.platform !== 'linux') return;
  const xdgDir = process.env.XDG_RUNTIME_DIR;
  if (!xdgDir) return;
  const dir = path.join(xdgDir, 'cove-nexus');
  // Snapshot time before scanning. Files touched at or after this moment
  // are either freshly created by a concurrent launch or actively in use —
  // skip them regardless of whether they appear in socketServers yet.
  const cleanupStart = Date.now();
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isSocket() && !e.name.endsWith('.sock')) continue;
      const sockPath = path.join(dir, e.name);
      // Never unlink a socket that is currently registered (active launch).
      if ([...socketServers.values()].some(s => s.sockPath === sockPath)) continue;
      try {
        const st = await fsp.stat(sockPath);
        // Skip files created or modified concurrently with this cleanup pass.
        if (st.mtimeMs >= cleanupStart) continue;
        await fsp.unlink(sockPath);
      } catch { /* ignore — file may have been cleaned up by owner */ }
    }
  } catch { /* ignore — dir may not exist */ }
}

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
    notification: null,
    tabUrl: null,
    tabFallback: false,
  };

  proto.connected = true;

  switch (msg.type) {
    case 'app_ready':
      proto.status = 'idle';
      break;

    case 'status_update': {
      const validStatuses = ['idle', 'busy', 'processing', 'error'];
      if (!validStatuses.includes(msg.status)) return;
      proto.status = msg.status;
      proto.statusLabel = msg.label != null ? truncate(String(msg.label), 80) : null;
      break;
    }

    case 'active_document':
      proto.activePath = msg.path != null ? truncate(String(msg.path), 260) : null;
      proto.projectLabel = msg.projectLabel != null ? truncate(String(msg.projectLabel), 60) : null;
      break;

    case 'progress_update': {
      if (msg.percent === undefined || msg.percent === null) return;
      proto.progress = clampPercent(msg.percent);
      proto.progressLabel = msg.label != null ? truncate(String(msg.label), 80) : null;
      if (proto.progress === 100) {
        setTimeout(() => {
          const e2 = processRegistry.get(slug);
          if (!e2 || !e2.protocol) return;
          if (e2.protocol.progress !== 100) return;
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
      if (!validLevels.includes(msg.level)) return;
      if (!msg.title || typeof msg.title !== 'string') return;
      const now = Date.now();
      const lastTs = notificationRateLimits.get(slug) ?? 0;
      if (now - lastTs < 5000) break;
      notificationRateLimits.set(slug, now);
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
      break;

    case 'tab_ready': {
      if (typeof msg.url !== 'string') return;
      if (!isValidTabUrl(msg.url)) return;
      if (entry.openMode !== 'tab-web') return;
      if (proto.tabUrl || proto.tabFallback) return; // ignore duplicate or post-fallback/close
      proto.tabUrl = msg.url;
      clearTabReadyTimer(slug);
      createHostedView(slug, msg.url);
      break;
    }

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

// ---------- end foxy v4 protocol ----------

// ---------- foxy v5 tab-web host ----------
// Hosted views are created when a tab-web app sends a valid tab_ready message.
// Renderer sends bounds via cove:tab-web:show; main attaches via addChildView + setBounds.

function isValidTabUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1') return false;
  const port = parseInt(parsed.port, 10);
  if (!port || port < 1024 || port > 65535) return false;
  if (parsed.username || parsed.password) return false;
  return true;
}

const hostedViews = new Map();    // slug → WebContentsView
const childViews  = new Set();    // slugs whose view is currently addChildView'd
const tabReadyTimers = new Map(); // slug → timeoutId
const smokeServers = new Map();   // slug → http.Server (dev-only, never in packaged builds)

function stopSmokeServer(slug) {
  const srv = smokeServers.get(slug);
  if (!srv) return;
  smokeServers.delete(slug);
  try { srv.close(); } catch (_) {}
}

async function startSmokeServer(runId) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Nexus tab-web smoke test</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem 3rem;background:#14141f;color:#c9d1d9;max-width:600px}
h1{color:#58a6ff;margin-bottom:1rem}code{background:#21262d;padding:.15rem .4rem;border-radius:.25rem;font-size:.85em}
</style></head><body>
<h1>Nexus tab-web smoke test</h1>
<p>WebContentsView rendered correctly inside Cove Nexus.</p>
<p>Run ID: <code>${runId}</code></p>
<p>Server: <code>127.0.0.1</code> only — dev mode only.</p>
</body></html>`);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    srv.on('error', reject);
  });
}

// Sidebar layout state — set via cove:tab-web:sidebarState.
// Only two valid values; invalid input falls back to 'expanded' (safe).
// Main owns the translation from this enum to fixed pixel geometry.
// Renderer must not send dimensions — only this narrow enum.
let sidebarBaseState = 'expanded'; // 'expanded' | 'hidden'

// Tab-web chrome mode — set via cove:tab-web:chromeMode.
// 'standard' = Nexus launcher chrome (foxy-session block) reserved above the
// hosted view. 'embedded' = true-app mode: the hosted view owns the entire
// area below the foxy tab strip. Invalid input falls back to 'standard' (safe
// default — preserves the existing security boundary for non-embedded apps).
let chromeMode = 'standard'; // 'standard' | 'embedded'

// Chrome layout constants — must match renderer/index.html CSS exactly.
const TITLEBAR_H         = 36;  // .titlebar { flex: 0 0 36px }
const FOXY_TABS_H        = 46;  // #foxy-tabs { height: 46px } — always present when tab-web:show fires
const SIDEBAR_W_EXPANDED = 240; // .layout { grid-template-columns: 240px 1fr }
const SESSION_CONTROLS_H = 200; // reserved height for #foxy-session in standard chrome mode (security boundary)

function getTrustedTabWebRegion(cw, ch) {
  // Top: titlebar + Foxy tab strip; in 'standard' chrome mode also reserve
  // the session-controls strip. In 'embedded' chrome mode the launcher chrome
  // is hidden in the renderer and the hosted view owns the full body region.
  // SESSION_CONTROLS_H remains part of the native-view security boundary for
  // standard mode — CSS enforces flex: 0 0 200px + min-height: 0 so controls
  // scroll inside and cannot push the host pane down.
  const sessionReserve = chromeMode === 'embedded' ? 0 : SESSION_CONTROLS_H;
  const topH = TITLEBAR_H + FOXY_TABS_H + sessionReserve;
  // Left: when sidebar is hidden the host pane starts at x=0; otherwise it
  // must not overlap the sidebar. Main converts the enum to a fixed constant —
  // no renderer-supplied dimension is trusted.
  const leftX = sidebarBaseState === 'hidden' ? 0 : SIDEBAR_W_EXPANDED;
  return {
    x:      leftX,
    y:      topH,
    width:  Math.max(0, cw - leftX),
    height: Math.max(0, ch - topH),
  };
}

function clearTabReadyTimer(slug) {
  const t = tabReadyTimers.get(slug);
  if (t) { clearTimeout(t); tabReadyTimers.delete(slug); }
}

function createHostedView(slug, url) {
  destroyHostedView(slug);
  const allowedOrigin = new URL(url).origin; // e.g. "http://127.0.0.1:12345"

  function guardNav(details) {
    if (!details.isMainFrame) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(details.url).origin === allowedOrigin; } catch { /* deny */ }
    if (!sameOrigin) details.preventDefault();
  }

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  view.webContents.on('will-navigate', guardNav);
  view.webContents.on('will-redirect', guardNav);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hostedViews.set(slug, view);
  view.webContents.loadURL(url);
}

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

// ---------- end foxy v5 tab-web scaffold ----------

function planFromPath(absPath) {
  if (/\.AppImage$/i.test(absPath)) return { cmd: absPath, args: [], kind: 'appimage' };
  if (/\.exe$/i.test(absPath))      return { cmd: absPath, args: [], kind: 'exe' };
  if (/\.deb$/i.test(absPath))      return { cmd: 'xdg-open', args: [absPath], kind: 'deb' };
  return { cmd: absPath, args: [], kind: 'exec' };
}

// Curated environment for child tools spawned by the launcher. We intentionally
// do NOT pass `process.env`, because that inherits the user's shell secrets
// (GITHUB_TOKEN, GH_TOKEN, ANTHROPIC_API_KEY, etc.) and Cove-Nexus-internal
// vars to arbitrary third-party binaries. Allowlist covers what a GUI tool
// needs to find binaries, render graphics, and pick a locale; everything else
// stays in the parent.
const LAUNCH_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'USERNAME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PUBLIC', 'COMPUTERNAME',
  'TEMP', 'TMP', 'TMPDIR',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS', 'OS',
  'LANG', 'LANGUAGE', 'TZ',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'SHELL', 'TERM',
]);
const LAUNCH_ENV_PREFIXES = ['XDG_', 'LC_', 'GTK_', 'QT_', 'GDK_', 'KDE_'];
function buildLaunchEnv() {
  // Windows env vars are case-insensitive at the OS level but Object.entries
  // returns them with whatever casing the process was launched with — most
  // commonly `Path`, `Temp`, `Tmp`, `WinDir`, `ComSpec`. Compare against the
  // uppercase allowlist on win32 so the launched tool still has a search
  // path; on other platforms env vars are case-sensitive and we keep the
  // exact-match semantics.
  const isWin = process.platform === 'win32';
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const cmp = isWin ? k.toUpperCase() : k;
    if (LAUNCH_ENV_KEYS.has(cmp) || LAUNCH_ENV_PREFIXES.some(p => cmp.startsWith(p))) {
      out[k] = v;
    }
  }
  // Electron and AppImage runtimes pollute LD_LIBRARY_PATH, LD_PRELOAD,
  // and GDK_PIXBUF vars with bundled-lib paths. Forwarding those to child
  // AppImages breaks their xdg-open / file-manager calls. Strip them
  // unconditionally on Linux — child AppImages set their own, and system
  // binaries use system libs.
  if (!isWin) {
    for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'GDK_PIXBUF_MODULE_FILE', 'GDK_PIXBUF_MODULEDIR']) {
      delete out[key];
    }
  }
  return out;
}

// ---------- scan ----------

function isValidTag(tag) {
  return typeof tag === 'string' && /^v\d/.test(tag);
}

async function scanOneInstalled(slug, info) {
  let latestTag = '';
  let notesBody = '';
  let notesUrl = '';
  let sawLatestRelease = false;
  let latestHasCompatibleAsset = false;
  try {
    const rel = await fetchLatestRelease(slug);
    const rawTag = rel?.tag_name || '';
    if (isValidTag(rawTag)) {
      sawLatestRelease = true;
      latestHasCompatibleAsset = !!pickAsset(rel?.assets);
      if (latestHasCompatibleAsset) {
        latestTag = rawTag;
        notesUrl = rel?.html_url || '';
      }
    }
    // Keep the card-preview small — we trim to first 400 chars here, and the
    // renderer clamps visually to 2 lines. Strip HTML-comment boilerplate
    // that electron-builder-generated notes sometimes contain.
    if (latestHasCompatibleAsset) {
      const raw = typeof rel?.body === 'string' ? rel.body : '';
      notesBody = raw.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 400);
    }
  } catch {}

  // Persist the most recent successful latestTag so a transient rate-limit
  // (empty latestTag this tick) doesn't silently hide a previously-detected
  // update. Falls back to the cached value when this scan came up empty.
  const cachedLatest = !sawLatestRelease && isValidTag(info.lastKnownLatestTag) ? info.lastKnownLatestTag : '';
  if (latestTag && latestTag !== (info.lastKnownLatestTag || '')) {
    try {
      const reg = readRegistry();
      if (reg[slug]) {
        reg[slug].lastKnownLatestTag = latestTag;
        writeRegistry(reg);
      }
    } catch {}
  }
  const effectiveLatest = latestTag || cachedLatest;

  // Pinned installs suppress the update prompt even when a newer release
  // exists upstream. The user explicitly asked to stay on this version.
  const pinned = info.pinnedTag || '';
  const localVer  = (info.tag       || '').replace(/^v/, '');
  const remoteVer = (effectiveLatest || '').replace(/^v/, '');
  const hasUpdate = !pinned && !!localVer && !!remoteVer && isNewerSemver(remoteVer, localVer);
  // True only when GitHub gave us nothing AND we have no cached value to
  // fall back on — the renderer can show a "?" pill instead of pretending
  // the installed version is the latest.
  const latestUnknown = !pinned && !!localVer && !effectiveLatest && !sawLatestRelease;

  if (process.env.DEBUG_UPDATE_CHECK) {
    console.log('[cove-update-check]', {
      slug,
      installedTag: info.tag,
      latestTag,
      sawLatestRelease,
      latestHasCompatibleAsset,
      cachedLatest,
      effectiveLatest,
      pinned,
      hasUpdate,
      latestUnknown,
    });
  }

  return {
    slug,
    manifest: null,
    installed: true,
    source: info.source || 'managed',
    version: info.tag || '',
    latestTag: effectiveLatest,
    hasUpdate,
    latestUnknown,
    pinnedTag: pinned,
    // Always return the latest-release pointer when we have one, even with
    // an empty body — the card still benefits from the tag + "more…" link.
    releaseNotes: effectiveLatest ? { tag: effectiveLatest, body: notesBody, url: notesUrl } : null,
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
    closeAfterLaunch: !!cfg.closeAfterLaunch,
    foxyMode: !!cfg.foxyMode,
    toolOrder: Array.isArray(cfg.toolOrder) ? cfg.toolOrder : [],
    bookmarks: Array.isArray(cfg.bookmarks) ? cfg.bookmarks : [],
    theme: cfg.theme === 'light' ? 'light' : 'dark',
    platform: process.platform,
  };
});

ipcMain.handle('cove:config:setPreferences', (_e, prefs = {}) => {
  const cfg = readConfig();
  if (typeof prefs.minimizeToTray === 'boolean')  cfg.minimizeToTray  = prefs.minimizeToTray;
  if (typeof prefs.startMinimized === 'boolean')  cfg.startMinimized  = prefs.startMinimized;
  if (typeof prefs.launchOnStartup === 'boolean') cfg.launchOnStartup = prefs.launchOnStartup;
  if (typeof prefs.closeAfterLaunch === 'boolean') cfg.closeAfterLaunch = prefs.closeAfterLaunch;
  if (typeof prefs.foxyMode === 'boolean') cfg.foxyMode = prefs.foxyMode;
  // Renderer-driven UX prefs. Validate shape so a malformed renderer
  // can't write garbage that breaks subsequent reads.
  if (Array.isArray(prefs.toolOrder)) {
    cfg.toolOrder = prefs.toolOrder.filter(s => typeof s === 'string' && isValidSlug(s));
  }
  if (Array.isArray(prefs.bookmarks)) {
    const seen = new Set();
    cfg.bookmarks = prefs.bookmarks
      .filter(s => typeof s === 'string' && isValidSlug(s) && !seen.has(s) && seen.add(s))
      .sort();
  }
  if (prefs.theme === 'light' || prefs.theme === 'dark') {
    cfg.theme = prefs.theme;
  }
  writeConfig(cfg);
  applyLoginItem(cfg);
  return {
    ok: true,
    minimizeToTray: cfg.minimizeToTray,
    startMinimized: cfg.startMinimized,
    launchOnStartup: cfg.launchOnStartup,
    closeAfterLaunch: cfg.closeAfterLaunch,
    toolOrder: Array.isArray(cfg.toolOrder) ? cfg.toolOrder : [],
    bookmarks: Array.isArray(cfg.bookmarks) ? cfg.bookmarks : [],
    theme: cfg.theme === 'light' ? 'light' : 'dark',
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
    protocol: e.protocol ?? null,
    openMode: e.openMode ?? 'external',
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

ipcMain.handle('cove:process:focus', (_e, slug) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const entry = processRegistry.get(slug);
  if (!entry || entry.status !== 'running') return { ok: false, error: 'not running' };
  const { pid } = entry;
  if (!pid) return { ok: false, error: 'no pid' };

  if (process.platform === 'linux') {
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
    if (sessionType === 'wayland') {
      return { ok: true, focused: false, unsupported: true, reason: 'wayland' };
    }
    try {
      const lp = execFileSync('wmctrl', ['-lp'], { encoding: 'utf8', timeout: 2000 });
      const windowId = lp.split('\n')
        .map(l => l.split(/\s+/))
        .find(p => parseInt(p[2], 10) === pid)?.[0];
      if (!windowId || !/^0x[0-9a-f]+$/i.test(windowId)) {
        return { ok: true, focused: false, unsupported: true, reason: 'window-not-found' };
      }
      execFileSync('wmctrl', ['-ia', windowId], { timeout: 2000 });
      return { ok: true, focused: true };
    } catch {
      return { ok: true, focused: false, unsupported: true, reason: 'wmctrl-unavailable' };
    }
  }

  return { ok: true, focused: false, unsupported: true, reason: 'unsupported-platform' };
});

ipcMain.handle('cove:launch', async (_e, slug, rawOpenMode) => {
  if (!isValidSlug(slug)) return { ok: false, error: 'invalid slug' };
  const openMode = rawOpenMode === 'tab-web' ? 'tab-web' : 'external';
  if (isLegacyClone(slug)) {
    return { ok: false, error: 'This install is from an older version. Click Update to reinstall as a binary.' };
  }

  // dev-only smoke harness — app.isPackaged gate ensures this is never reachable in production
  if (!app.isPackaged && slug === 'tab-web-smoke') {
    const existing = processRegistry.get('tab-web-smoke');
    if (existing && (existing.status === 'launching' || existing.status === 'running')) {
      return { ok: true, alreadyRunning: true, kind: 'smoke' };
    }
    const runId = crypto.randomUUID();
    const now = Date.now();
    processRegistry.set('tab-web-smoke', {
      slug: 'tab-web-smoke', child: null, pid: null,
      status: 'launching', openMode: 'tab-web', runId,
      startedAt: now, exitedAt: null, exitCode: null, signal: null,
      lastError: null, processUpdatedAt: now,
      protocol: {
        connected: false, status: null, statusLabel: null,
        activePath: null, projectLabel: null, progress: null, progressLabel: null,
        lifecycle: null, notification: null, tabUrl: null, tabFallback: false,
      },
    });
    broadcastProcessUpdate('tab-web-smoke', null);
    let srv, port;
    try {
      ({ srv, port } = await startSmokeServer(runId));
    } catch (err) {
      processRegistry.delete('tab-web-smoke');
      broadcastProcessUpdate('tab-web-smoke', 'launching');
      return { ok: false, error: `smoke: server start failed: ${err.message}` };
    }
    smokeServers.set('tab-web-smoke', srv);
    const smokeEntry = processRegistry.get('tab-web-smoke');
    processRegistry.set('tab-web-smoke', { ...smokeEntry, status: 'running', processUpdatedAt: Date.now() });
    broadcastProcessUpdate('tab-web-smoke', 'launching');
    const tabTimer = setTimeout(() => {
      tabReadyTimers.delete('tab-web-smoke');
      const e2 = processRegistry.get('tab-web-smoke');
      if (!e2 || e2.runId !== runId || e2.protocol?.tabUrl) return;
      const proto2 = e2.protocol ? { ...e2.protocol } : {};
      proto2.tabFallback = true;
      processRegistry.set('tab-web-smoke', { ...e2, protocol: proto2, processUpdatedAt: Date.now() });
      broadcastProcessUpdate('tab-web-smoke', e2.status);
      stopSmokeServer('tab-web-smoke');
    }, 10000);
    tabReadyTimers.set('tab-web-smoke', tabTimer);
    processProtocolLine('tab-web-smoke', JSON.stringify({
      type: 'app_ready', runId, protocolVersion: 1, ts: Date.now(),
    }));
    processProtocolLine('tab-web-smoke', JSON.stringify({
      type: 'tab_ready', runId, protocolVersion: 1, ts: Date.now(),
      url: `http://127.0.0.1:${port}/`,
    }));
    return { ok: true, alreadyRunning: false, kind: 'smoke' };
  }

  // Nonce guard: prevent duplicate spawns. Fires before any async work so
  // rapid double-clicks are resolved by the registry, not by the busy flag alone.
  const existing = processRegistry.get(slug);
  if (existing && (existing.status === 'launching' || existing.status === 'running')) {
    return { ok: true, alreadyRunning: true, kind: 'app' };
  }

  const info = readRegistry()[slug];
  if (!info?.path) return { ok: false, error: 'Not installed.' };
  if (!exists(info.path)) return { ok: false, error: `Missing: ${info.path}` };

  // Mark launching immediately — before spawn — so any concurrent IPC call
  // hits the nonce guard above.
  const runId = crypto.randomUUID();
  const now = Date.now();
  processRegistry.set(slug, {
    slug, child: null, pid: null, status: 'launching',
    startedAt: now, exitedAt: null, exitCode: null,
    signal: null, lastError: null, processUpdatedAt: now,
    runId, protocol: null, openMode,
  });
  broadcastProcessUpdate(slug, null);

  // Create socket server before spawn (Linux only; null on other platforms or failure)
  const appName = slugToDisplayName(slug);
  const sockPath = await createSocketServer(slug, runId);
  const nexusEnv = buildNexusEnv(slug, runId, appName, sockPath, openMode);

  const plan = planFromPath(info.path);
  try {
    const child = spawn(plan.cmd, plan.args, {
      cwd: path.dirname(info.path),
      detached: true,
      stdio: 'ignore',
      env: { ...buildLaunchEnv(), ...nexusEnv },
    });

    // Store child ref and capture pid immediately so fast-exiting processes
    // still preserve lastKnownPid in the exited registry entry.
    processRegistry.get(slug).child = child;
    processRegistry.get(slug).pid = child.pid ?? null;

    // Exit listener — covers both normal close and crash.
    // Does not overwrite 'failed' status set by the error handler.
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
      destroyHostedView(slug);
      clearTabReadyTimer(slug);
    });

    // For tab-web apps: if tab_ready never arrives within 10 s, fall back to external mode.
    if (openMode === 'tab-web') {
      const tabTimer = setTimeout(() => {
        tabReadyTimers.delete(slug);
        const e = processRegistry.get(slug);
        if (!e || e.runId !== runId || e.protocol?.tabUrl) return;
        const proto = e.protocol ? { ...e.protocol } : {};
        proto.tabFallback = true;
        processRegistry.set(slug, { ...e, protocol: proto, processUpdatedAt: Date.now() });
        broadcastProcessUpdate(slug, e.status);
      }, 10000);
      tabReadyTimers.set(slug, tabTimer);
    }

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
        cleanupSocketServer(slug); // async, best-effort
        destroyHostedView(slug);
        clearTabReadyTimer(slug);
        resolve({ ok: false, error: String(err?.message || err) });
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        const prev = processRegistry.get(slug);
        const prevStatus = prev?.status ?? null;
        // Only transition if still launching (process may have exited in <600ms).
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
    cleanupSocketServer(slug); // async, best-effort
    destroyHostedView(slug);
    clearTabReadyTimer(slug);
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:tab-web:show', (_e, slug, bounds) => {
  if (!isValidSlug(slug)) return;
  const view = hostedViews.get(slug);
  if (!view || view.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Reject before any arithmetic: all four fields must be finite numbers with
  // positive dimensions. Rejects NaN, Infinity, undefined, null, strings,
  // objects, and arrays without relying on clamp to mask bad values.
  if (!bounds ||
      !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
      bounds.width <= 0 || bounds.height <= 0) {
    // Fail closed: detach any previously attached view before returning.
    if (childViews.has(slug)) {
      try { mainWindow.contentView.removeChildView(view); } catch (_) {}
      childViews.delete(slug);
    }
    return;
  }

  // Compute the main-owned trusted region — the only area where a hosted view
  // may appear. Excludes titlebar, sidebar, and Foxy tab strip.
  const [cw, ch] = mainWindow.getContentSize();
  const trusted = getTrustedTabWebRegion(cw, ch);

  // Treat renderer-supplied bounds as untrusted measurement hints.
  // Intersect with the trusted region; renderer may only shrink or align
  // within it, never expand outside it.
  const rx = Math.round(bounds.x);
  const ry = Math.round(bounds.y);
  const x      = Math.max(rx, trusted.x);
  const y      = Math.max(ry, trusted.y);
  const width  = Math.min(rx + Math.round(bounds.width),  trusted.x + trusted.width)  - x;
  const height = Math.min(ry + Math.round(bounds.height), trusted.y + trusted.height) - y;

  // Enforce a minimum 32×32 usable area. A degenerate rectangle or a window
  // too small to host the view should detach rather than remain invisible.
  if (width < 32 || height < 32) {
    if (childViews.has(slug)) {
      try { mainWindow.contentView.removeChildView(view); } catch (_) {}
      childViews.delete(slug);
    }
    return;
  }

  if (!childViews.has(slug)) {
    mainWindow.contentView.addChildView(view);
    childViews.add(slug);
  }
  view.setBounds({ x, y, width, height });
});

ipcMain.handle('cove:tab-web:hide', (_e, slug) => {
  if (!isValidSlug(slug)) return;
  const view = hostedViews.get(slug);
  if (!view || !childViews.has(slug)) return;
  try { mainWindow?.contentView?.removeChildView(view); } catch (_) {}
  childViews.delete(slug);
});

ipcMain.handle('cove:tab-web:sidebarState', (_e, s) => {
  // Accept only the two known layout states; invalid input falls back to 'expanded'.
  // Renderer sends the enum only — no dimensions. Main translates to fixed geometry.
  sidebarBaseState = s === 'hidden' ? 'hidden' : 'expanded';
});

ipcMain.handle('cove:tab-web:chromeMode', (_e, m) => {
  // Accept only the two known chrome modes; invalid input falls back to
  // 'standard' (preserves the SESSION_CONTROLS_H reservation — the safe
  // default that keeps Nexus host chrome visible).
  chromeMode = m === 'embedded' ? 'embedded' : 'standard';
});

ipcMain.handle('cove:tab-web:close', (_e, slug) => {
  if (!isValidSlug(slug)) return;
  clearTabReadyTimer(slug);
  // Mark the session closed so any late tab_ready (including socket-race before first message)
  // is rejected. Initialise protocol from existing state or a safe empty base.
  const e = processRegistry.get(slug);
  if (e?.openMode === 'tab-web') {
    const base = e.protocol ?? {
      connected: false, status: null, statusLabel: null, activePath: null,
      projectLabel: null, progress: null, progressLabel: null,
      lifecycle: null, notification: null,
    };
    const proto = { ...base, tabUrl: null, tabFallback: true };
    processRegistry.set(slug, { ...e, protocol: proto, processUpdatedAt: Date.now() });
    broadcastProcessUpdate(slug, e.status);
  }
  destroyHostedView(slug); // removes view + skips tabUrl broadcast (already null above)
  // dev-only: stop smoke server and mark exited so re-launch is possible
  if (!app.isPackaged && slug === 'tab-web-smoke') {
    stopSmokeServer(slug);
    const smokeE = processRegistry.get(slug);
    if (smokeE) {
      processRegistry.set(slug, {
        ...smokeE, status: 'exited', exitCode: 0,
        exitedAt: Date.now(), processUpdatedAt: Date.now(),
      });
      broadcastProcessUpdate(slug, smokeE.status);
    }
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
      if (!isValidTag(tag)) return;
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
    // Repos with no published GitHub release are also excluded — this gates
    // out scripts, experiments, and WIP repos automatically.
    const candidates = (repos || [])
      .filter(r => typeof r?.name === 'string'
        && /^cove-/i.test(r.name)
        && !/bot/i.test(r.name)
        && r.name !== GITHUB_REPO
        && !EXCLUDED_REPOS.has(r.name)
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
    const releaseChecks = await Promise.all(
      candidates.map(r => fetchLatestRelease(r.slug).then(rel => rel?.tag_name ? r : null).catch(() => null))
    );
    const mapped = releaseChecks.filter(Boolean);
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
