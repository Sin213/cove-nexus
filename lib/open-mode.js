function effectiveOpenMode(requested, platform, socketPath) {
  return requested === 'tab-web' && platform === 'linux' && socketPath
    ? 'tab-web' : 'external';
}

module.exports = { effectiveOpenMode };
