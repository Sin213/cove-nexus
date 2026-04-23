const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
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
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b10',
    show: false,
    title: '',
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Hold the window hidden until the renderer has painted, so users don't
  // see a black flash while the page loads.
  win.once('ready-to-show', () => win.show());
  mainWindow = win;
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.on('maximize', () => win.webContents.send('cove:window:stateChanged', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('cove:window:stateChanged', { maximized: false }));
}

app.whenReady().then(() => {
  migrateLegacyInstalls();
  ensureProgramsRoot();
  adoptFromProgramsRoot();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  setupAutoUpdater();
});

// Silent auto-update: packaged builds only. Checks on boot and hourly.
// When an update is downloaded, the app relaunches itself immediately.
// No prompt. No toast. Configured against github.com/Sin213/cove-nexus releases.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- small utils ----------

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// ---------- config (~/.config/cove-nexus/config.json) ----------

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      programsRoot: typeof c?.programsRoot === 'string' && c.programsRoot
        ? c.programsRoot
        : defaultProgramsRoot(),
      githubToken: typeof c?.githubToken === 'string' ? c.githubToken : '',
    };
  } catch {
    const c = { programsRoot: defaultProgramsRoot(), githubToken: '' };
    writeConfig(c);
    return c;
  }
}

function writeConfig(c) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8');
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

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let finished = false;
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

async function installOrUpdate(slug, { force = false, tag: explicitTag } = {}) {
  const release = await resolveRelease(slug, { tag: explicitTag });
  const tag = release?.tag_name || '';
  const asset = pickAsset(release?.assets);
  if (!asset) {
    const plat = process.platform === 'darwin' ? 'macOS' : process.platform;
    throw new Error(`No ${plat} build available in release ${tag || '(unknown)'}.`);
  }

  const reg = readRegistry();
  const current = reg[slug];
  const root = ensureProgramsRoot();
  const finalPath = path.join(root, asset.name);

  if (!force && current?.tag === tag && current.path && exists(current.path)) {
    return { ok: true, already: true, tag };
  }

  const tmp = path.join(root, `.${asset.name}.part`);
  await downloadToFile(asset.browser_download_url, tmp);

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
  return { ok: true, tag };
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
  try {
    const rel = await fetchLatestRelease(slug);
    latestTag = rel?.tag_name || '';
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
  };
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
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
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

ipcMain.handle('cove:releases', async (_e, slug) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
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
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
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
  const reg = readRegistry();
  if (!reg[slug]) return { ok: false, error: 'not installed' };
  delete reg[slug].pinnedTag;
  writeRegistry(reg);
  return { ok: true };
});

ipcMain.handle('cove:setCustomPath', async (_e, slug) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
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
    const mapped = (repos || [])
      .filter(r => typeof r?.name === 'string' && /^cove-/i.test(r.name) && r.name !== GITHUB_REPO && !r.archived && !r.disabled)
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
