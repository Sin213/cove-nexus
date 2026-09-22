function hasActiveHostedSession(entries) {
  return [...entries].some(entry => entry.openMode === 'tab-web' &&
    ['launching', 'running'].includes(entry.status));
}

function createSelfUpdateController({ install, notify, hasActiveSession, autoInstall = true }) {
  let pending = null;
  let installing = false;
  function installReady() {
    if (!pending) return { ok: false, error: 'No downloaded update is ready.' };
    if (installing) return { ok: false, error: 'The update is already installing.' };
    installing = true;
    try {
      install();
      return { ok: true };
    } catch (error) {
      installing = false;
      pending = { ...pending, error: String(error.message || error) };
      notify(pending);
      return { ok: false, error: pending.error };
    }
  }
  return {
    getState: () => pending ? { ...pending } : null,
    downloaded(version) {
      pending = { state: 'downloaded', version };
      notify(pending);
      if (autoInstall && !hasActiveSession()) installReady();
    },
    installReady,
  };
}

module.exports = { createSelfUpdateController, hasActiveHostedSession };
