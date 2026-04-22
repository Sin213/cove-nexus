const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const os = require('node:os');
const git = require('isomorphic-git');
const gitHttp = require('isomorphic-git/http/node');

const PROGRAMS_DIR = path.join(os.homedir(), '.cove-suite', 'programs');
const CONFIG_DIR = path.join(os.homedir(), '.cove-suite');
const GITHUB_OWNER = 'Sin213';

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

// ---------- helpers ----------

function programDir(slug) {
  return path.join(PROGRAMS_DIR, slug);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });
}

function firstExisting(candidates) {
  return candidates.find(exists) || null;
}

// Read a repo's .cove.json manifest, if it has one.
// Schema (all fields optional):
//   {
//     "name": "Pretty Name",
//     "icon": "pdf" | "upscale" | "download" | ...,
//     "category": "cat-media" | "cat-docs" | "cat-utils" | "cat-create",
//     "description": "One-line tagline.",
//     "version": "1.2.3",
//     "entry": "main.py"                            // interpreter inferred from extension
//        | { "cmd": "cargo", "args": ["run"] }      // explicit command
//        | { "kind": "appimage", "path": "release/Foo.AppImage" }
//   }
function readManifest(dir) {
  const p = path.join(dir, '.cove.json');
  if (!exists(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const m = JSON.parse(raw);
    return (m && typeof m === 'object') ? m : null;
  } catch {
    return null;
  }
}

// Resolve manifest.entry to an executable plan, or null if invalid.
function planFromEntry(dir, entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const abs = path.isAbsolute(entry) ? entry : path.join(dir, entry);
    if (!exists(abs)) return null;
    if (/\.py$/i.test(abs))       return { kind: 'python',   cmd: 'python3', args: [abs], cwd: dir };
    if (/\.sh$/i.test(abs))       return { kind: 'shell',    cmd: 'bash',    args: [abs], cwd: dir };
    if (/\.AppImage$/i.test(abs)) return { kind: 'appimage', cmd: abs,       args: [],    cwd: dir };
    if (/\.(js|mjs|cjs)$/i.test(abs)) return { kind: 'node', cmd: 'node',    args: [abs], cwd: dir };
    return { kind: 'exec', cmd: abs, args: [], cwd: dir };
  }
  if (typeof entry === 'object') {
    if (entry.kind === 'appimage' && typeof entry.path === 'string') {
      const abs = path.isAbsolute(entry.path) ? entry.path : path.join(dir, entry.path);
      if (!exists(abs)) return null;
      return { kind: 'appimage', cmd: abs, args: [], cwd: dir };
    }
    if (typeof entry.cmd === 'string') {
      return { kind: 'custom', cmd: entry.cmd, args: Array.isArray(entry.args) ? entry.args : [], cwd: dir };
    }
  }
  return null;
}

// Walk up to find an AppImage or a clear entry point inside dir.
function findLauncherPlan(dir, slug) {
  if (!exists(dir)) return null;

  // 0) .cove.json manifest wins if present and resolves.
  const manifest = readManifest(dir);
  if (manifest) {
    const fromManifest = planFromEntry(dir, manifest.entry);
    if (fromManifest) return fromManifest;
  }

  // 1) Prebuilt AppImage under release/ or dist/
  const releaseDirs = ['release', 'dist', 'build'].map(d => path.join(dir, d));
  for (const rd of releaseDirs) {
    if (!exists(rd)) continue;
    try {
      const entries = fs.readdirSync(rd, { withFileTypes: true });
      const appimg = entries
        .filter(e => e.isFile() && /\.AppImage$/i.test(e.name))
        .map(e => path.join(rd, e.name))[0];
      if (appimg) return { kind: 'appimage', cmd: appimg, args: [], cwd: dir };
    } catch {}
  }

  // 2) launch.sh at repo root
  const launchSh = path.join(dir, 'launch.sh');
  if (exists(launchSh)) return { kind: 'shell', cmd: 'bash', args: [launchSh], cwd: dir };

  // 3) package.json with a start script
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg?.scripts?.start) return { kind: 'npm', cmd: 'npm', args: ['start'], cwd: dir };
      if (pkg?.scripts?.dev)   return { kind: 'npm', cmd: 'npm', args: ['run', 'dev'], cwd: dir };
    } catch {}
  }

  // 4) Python entry: <slug>.py or main.py, with underscores accepted
  const pyCandidates = [
    path.join(dir, `${slug}.py`),
    path.join(dir, `${slug.replace(/-/g, '_')}.py`),
    path.join(dir, 'main.py'),
    path.join(dir, 'app.py'),
    path.join(dir, 'src', `${slug.replace(/-/g, '_')}`, '__main__.py'),
  ];
  const py = firstExisting(pyCandidates);
  if (py) return { kind: 'python', cmd: 'python3', args: [py], cwd: dir };

  return null;
}

async function scanOneInstalled(slug) {
  const dir = programDir(slug);
  const manifest = readManifest(dir);
  const url = `https://github.com/${GITHUB_OWNER}/${slug}`;
  let localSha = '';
  let remoteSha = '';
  try { localSha = await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch {}
  try {
    const info = await git.getRemoteInfo({ http: gitHttp, url });
    const head = info.HEAD || 'refs/heads/main';
    const branch = head.replace('refs/heads/', '');
    remoteSha = info.refs?.heads?.[branch] || '';
  } catch {}
  const hasUpdate = !!(localSha && remoteSha && localSha !== remoteSha);
  return { slug, manifest, hasUpdate, localSha, remoteSha };
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
  return {
    programsDir: PROGRAMS_DIR,
    installed,
  };
});

// Rich scan: for every installed slug, read manifest and compare local HEAD to remote.
// opts: { checkUpdates?: boolean (default true) }
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
      return { slug, manifest: readManifest(programDir(slug)), hasUpdate: false };
    }
    try { return await scanOneInstalled(slug); }
    catch { return { slug, manifest: readManifest(programDir(slug)), hasUpdate: false }; }
  }));

  return { programsDir: PROGRAMS_DIR, installed };
});

ipcMain.handle('cove:install', async (_e, slug) => {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { ok: false, error: 'invalid slug' };
  const dest = programDir(slug);
  if (exists(dest)) return { ok: true, already: true };
  const url = `https://github.com/${GITHUB_OWNER}/${slug}`;
  try {
    await git.clone({
      fs, http: gitHttp, dir: dest, url,
      singleBranch: true, depth: 1,
    });
    return { ok: true };
  } catch (err) {
    // Roll back partial clone so Install can be retried cleanly.
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:update', async (_e, slug) => {
  const dir = programDir(slug);
  if (!exists(dir)) return { ok: false, error: 'not installed' };
  const url = `https://github.com/${GITHUB_OWNER}/${slug}`;
  try {
    // Determine the default branch from the remote (works even on shallow clones).
    const info = await git.getRemoteInfo({ http: gitHttp, url });
    const remoteHeadRef = info.HEAD || 'refs/heads/main';
    const branch = remoteHeadRef.replace('refs/heads/', '');
    // Fetch and hard-reset to the remote head. The program dir is a
    // read-only clone from the user's perspective, so overwriting local
    // changes is intentional (matches what `git pull --ff-only` + re-clone does).
    await git.fetch({
      fs, http: gitHttp, dir, url,
      ref: branch, singleBranch: true, depth: 1, tags: false,
    });
    const remoteSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteSha, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('cove:launch', async (_e, slug) => {
  const dir = programDir(slug);
  if (!exists(dir)) return { ok: false, error: 'not installed' };
  const plan = findLauncherPlan(dir, slug);
  if (!plan) {
    return {
      ok: false,
      error: `No launcher found in ${dir}. Add a launch.sh, build an AppImage into release/, expose an npm "start" script, or include ${slug}.py at the repo root.`,
    };
  }
  try {
    const child = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return { ok: true, kind: plan.kind };
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

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'cove-suite-launcher',
        'Accept': 'application/vnd.github+json',
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`github ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

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
