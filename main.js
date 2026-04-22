const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const os = require('node:os');
const https = require('node:https');

const PROGRAMS_DIR = path.join(os.homedir(), '.cove-suite', 'programs');
const GITHUB_OWNER = 'Sin213';
const UA = 'cove-suite-launcher';

app.setName('Cove Suite');
fs.mkdirSync(PROGRAMS_DIR, { recursive: true });

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b10',
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
  mainWindow = win;
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.on('maximize', () => win.webContents.send('cove:window:stateChanged', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('cove:window:stateChanged', { maximized: false }));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  setupAutoUpdater();
});

// Silent auto-update: packaged builds only. Checks on boot and hourly.
// When an update is downloaded, the app relaunches itself immediately.
// No prompt. No toast. Configured against github.com/Sin213/cove-suite releases.
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

// ---------- paths + install record ----------

function programDir(slug) {
  return path.join(PROGRAMS_DIR, slug);
}

function installedJsonPath(slug) {
  return path.join(programDir(slug), 'installed.json');
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readInstalled(slug) {
  try { return JSON.parse(fs.readFileSync(installedJsonPath(slug), 'utf8')); }
  catch { return null; }
}

function writeInstalled(slug, info) {
  fs.mkdirSync(programDir(slug), { recursive: true });
  fs.writeFileSync(installedJsonPath(slug), JSON.stringify(info, null, 2), 'utf8');
}

// Older versions of Cove Suite cloned the tool's git repo into the programs
// dir and tried to run its Python source. Those installs have a `.git`
// directory but no `installed.json`. Treat them as stale and mark for
// reinstall so users land on the prebuilt release binary instead.
function isLegacyInstall(slug) {
  const dir = programDir(slug);
  if (!exists(dir)) return false;
  if (readInstalled(slug)) return false;
  return exists(path.join(dir, '.git'));
}

// ---------- platform asset picking ----------

// Ordered regexes — the first asset whose name matches wins.
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

// ---------- https ----------

function ghHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { ...ghHeaders(), ...headers },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpsGetJson(res.headers.location, headers).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`github ${res.statusCode}: ${body.slice(0, 200)}`));
        }
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
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${slug}/releases/latest`;
  return httpsGetJson(url);
}

async function installOrUpdate(slug, { force = false } = {}) {
  const dir = programDir(slug);
  fs.mkdirSync(dir, { recursive: true });

  const release = await fetchLatestRelease(slug);
  const tag = release?.tag_name || '';
  const asset = pickAsset(release?.assets);
  if (!asset) {
    const plat = process.platform === 'darwin' ? 'macOS' : process.platform;
    throw new Error(`No ${plat} build available in release ${tag || '(unknown)'}.`);
  }

  const current = readInstalled(slug);
  const binDir = path.join(dir, 'bin');
  const final = path.join(binDir, asset.name);
  if (!force && current && current.tag === tag && exists(final)) {
    return { ok: true, already: true, tag };
  }

  fs.mkdirSync(binDir, { recursive: true });
  const tmp = path.join(binDir, `.${asset.name}.part`);
  await downloadToFile(asset.browser_download_url, tmp);

  // Remove the previously-installed binary so /bin doesn't accumulate
  // stale copies of old versions.
  if (current?.entry) {
    const prior = path.join(dir, current.entry);
    if (exists(prior) && prior !== final) {
      await fsp.rm(prior, { force: true }).catch(() => {});
    }
  }
  await fsp.rename(tmp, final);
  if (process.platform === 'linux') {
    try { fs.chmodSync(final, 0o755); } catch {}
  }

  writeInstalled(slug, {
    slug,
    tag,
    asset: asset.name,
    entry: path.relative(dir, final),
    platform: process.platform,
    installedAt: new Date().toISOString(),
  });
  return { ok: true, tag };
}

function planFromEntry(absPath) {
  if (/\.AppImage$/i.test(absPath)) return { cmd: absPath, args: [], kind: 'appimage' };
  if (/\.exe$/i.test(absPath))      return { cmd: absPath, args: [], kind: 'exe' };
  if (/\.deb$/i.test(absPath))      return { cmd: 'xdg-open', args: [absPath], kind: 'deb' };
  return { cmd: absPath, args: [], kind: 'exec' };
}

// ---------- scan ----------

async function scanOneInstalled(slug) {
  if (isLegacyInstall(slug)) {
    return { slug, manifest: null, hasUpdate: true, legacy: true, version: '', latestTag: '' };
  }
  const info = readInstalled(slug);
  if (!info) return { slug, manifest: null, hasUpdate: false, version: '', latestTag: '' };
  let latestTag = '';
  try {
    const rel = await fetchLatestRelease(slug);
    latestTag = rel?.tag_name || '';
  } catch {}
  return {
    slug,
    manifest: null,
    hasUpdate: !!(latestTag && info.tag && latestTag !== info.tag),
    version: info.tag,
    latestTag,
  };
}

// ---------- IPC ----------

ipcMain.handle('cove:appInfo', () => ({
  version: app.getVersion(),
  name: app.getName(),
  packaged: app.isPackaged,
}));

ipcMain.handle('cove:getState', async () => {
  let installed = [];
  try {
    installed = fs.readdirSync(PROGRAMS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {}
  return { programsDir: PROGRAMS_DIR, installed };
});

ipcMain.handle('cove:scan', async (_e, opts = {}) => {
  const checkUpdates = opts.checkUpdates !== false;
  let installedSlugs = [];
  try {
    installedSlugs = fs.readdirSync(PROGRAMS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {}
  const installed = await Promise.all(installedSlugs.map(async (slug) => {
    if (!checkUpdates) {
      const info = readInstalled(slug);
      return { slug, manifest: null, hasUpdate: false, version: info?.tag || '', legacy: isLegacyInstall(slug) };
    }
    try { return await scanOneInstalled(slug); }
    catch { return { slug, manifest: null, hasUpdate: false, version: '', latestTag: '' }; }
  }));
  return { programsDir: PROGRAMS_DIR, installed };
});

ipcMain.handle('cove:install', async (_e, slug) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
  if (isLegacyInstall(slug)) {
    await fsp.rm(programDir(slug), { recursive: true, force: true }).catch(() => {});
  }
  try {
    return await installOrUpdate(slug, { force: false });
  } catch (err) {
    await fsp.rm(programDir(slug), { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:update', async (_e, slug) => {
  const dir = programDir(slug);
  if (!exists(dir)) return { ok: false, error: 'not installed' };
  try {
    if (isLegacyInstall(slug)) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return await installOrUpdate(slug, { force: false });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:launch', async (_e, slug) => {
  const dir = programDir(slug);
  if (!exists(dir)) return { ok: false, error: 'not installed' };
  if (isLegacyInstall(slug)) {
    return { ok: false, error: 'This install is from an older Cove Suite. Click Update to reinstall as a binary.' };
  }
  const info = readInstalled(slug);
  if (!info?.entry) return { ok: false, error: 'Install info missing. Try reinstalling.' };
  const entry = path.join(dir, info.entry);
  if (!exists(entry)) return { ok: false, error: `Missing entry: ${entry}` };

  const plan = planFromEntry(entry);
  try {
    const child = spawn(plan.cmd, plan.args, {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    // Give the OS a beat to surface ENOENT/EACCES synchronously before we
    // report success. Without this, the old flow always toasted "launched"
    // even when the binary never actually started.
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
  const dir = slug ? programDir(slug) : PROGRAMS_DIR;
  if (!exists(dir)) return { ok: false, error: 'missing' };
  shell.openPath(dir);
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

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
let discoveryCache = { at: 0, data: null };

ipcMain.handle('cove:discover', async (_e, opts = {}) => {
  const now = Date.now();
  if (!opts.force && discoveryCache.data && (now - discoveryCache.at) < DISCOVERY_TTL_MS) {
    return { ok: true, cached: true, repos: discoveryCache.data };
  }
  try {
    const repos = await httpsGetJson('https://api.github.com/users/Sin213/repos?per_page=100&sort=updated');
    const mapped = (repos || [])
      .filter(r => typeof r?.name === 'string' && /^cove-/i.test(r.name) && r.name !== 'cove-suite' && !r.archived && !r.disabled)
      .map(r => ({
        slug: r.name,
        name: prettyName(r.name),
        desc: r.description || '',
        lang: r.language || '—',
        updated: formatUpdated(r.pushed_at || r.updated_at),
        version: '',
        fork: !!r.fork,
      }));
    discoveryCache = { at: now, data: mapped };
    return { ok: true, cached: false, repos: mapped };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

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

ipcMain.handle('cove:uninstall', async (_e, slug) => {
  const dir = programDir(slug);
  if (!exists(dir)) return { ok: true, already: true };
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0,
    title: 'Uninstall',
    message: `Remove ${slug}?`,
    detail: `This deletes ${dir}. Any user data inside that folder will be lost.`,
  });
  if (response !== 1) return { ok: false, cancelled: true };
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true };
});
