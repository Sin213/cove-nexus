// Pure decision helpers for the Foxy Mode (v5) tab-web host. Kept out of
// main.js so the lifecycle rules can be tested without an Electron runtime.

// What should happen when a tab_ready message arrives?
//   'ignore' - not a tab-web run, bad URL, or duplicate healthy view
//   'record' - remember the URL but build no view (the tab was closed while
//              the app was still starting; nobody would see the view)
//   'attach' - remember the URL and build the hosted view
function tabReadyDecision(entry, proto, url, isValidUrl) {
  if (!entry || entry.openMode !== 'tab-web') return 'ignore';
  if (typeof url !== 'string' || !isValidUrl(url)) return 'ignore';
  if (!proto) return 'attach';
  if (proto.tabUrl && !proto.tabError) return 'ignore';
  return proto.tabClosed ? 'record' : 'attach';
}

// May a paused session (tab closed, app still alive) be rebuilt from the URL
// the app already reported?
function canResumeHostedView(entry, isValidUrl) {
  if (!entry || entry.openMode !== 'tab-web') return false;
  if (!['launching', 'running'].includes(entry.status)) return false;
  if (entry.protocol?.tabError) return false;
  const url = entry.protocol?.tabUrl;
  if (typeof url !== 'string' || !isValidUrl(url)) return false;
  return true;
}

function isValidTabUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return false;
  const port = Number(parsed.port);
  return port >= 1024 && port <= 65535 && !parsed.username && !parsed.password;
}

module.exports = { tabReadyDecision, canResumeHostedView, isValidTabUrl };
