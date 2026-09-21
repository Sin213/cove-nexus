const { isValidTabUrl } = require('./tabweb');

// Electron is injected so navigation, permissions, and load failures can be
// tested without starting a desktop session.
function buildHostedView({ WebContentsView, slug, url, onLoaded, onFailure, wireDownloads, loadTimeoutMs = 15000 }) {
  if (!isValidTabUrl(url)) throw new Error('Invalid embedded app URL');
  const origin = new URL(url).origin;
  const view = new WebContentsView({
    webPreferences: {
      partition: `cove-tool-${slug}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const contents = view.webContents;
  let failed = false;
  let loadTimer = null;
  const clearLoadTimer = () => { clearTimeout(loadTimer); loadTimer = null; };
  const fail = message => {
    if (failed || contents.isDestroyed()) return;
    failed = true;
    clearLoadTimer();
    onFailure(view, message);
  };
  contents.once('destroyed', clearLoadTimer);
  const sameOrigin = value => {
    try { return new URL(value).origin === origin; } catch { return false; }
  };
  const allowPermission = (requester, permission, requestingOrigin) =>
    requester === contents && !contents.isDestroyed() &&
    sameOrigin(contents.getURL()) && sameOrigin(requestingOrigin) &&
    permission === 'clipboard-sanitized-write';
  contents.session.setPermissionCheckHandler(allowPermission);
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(allowPermission(requester, permission, details?.requestingUrl || ''));
  });
  const guardNav = details => {
    if (details.isMainFrame && !sameOrigin(details.url)) details.preventDefault();
  };
  contents.on('will-navigate', guardNav);
  contents.on('will-redirect', guardNav);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) fail(`Embedded app failed to load: ${description} (${code})`);
  });
  contents.on('render-process-gone', (_event, details) => {
    fail(`Embedded app stopped: ${details.reason}`);
  });
  wireDownloads(contents.session);
  loadTimer = setTimeout(() => fail('The embedded page took too long to load. Try again when the app is ready.'), loadTimeoutMs);
  // Delay until the caller registers the view, including synchronous failures.
  Promise.resolve().then(() => contents.loadURL(url)).then(
    () => {
      clearLoadTimer();
      if (!failed && !contents.isDestroyed()) onLoaded(view);
    },
    error => fail(`Embedded app failed to load: ${error.message || error}`)
  );
  return view;
}

module.exports = { buildHostedView };
