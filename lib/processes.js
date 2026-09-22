// Retain a small diagnostic prefix while continuing to drain the child's
// output. Closing a live pipe makes later writes fail with EPIPE.
function captureStderr(stream, maxBytes = 4096) {
  let prefix = Buffer.alloc(0);
  if (stream) {
    stream.on('data', chunk => {
      if (prefix.length >= maxBytes) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      prefix = Buffer.concat([prefix, bytes.subarray(0, maxBytes - prefix.length)]);
    });
    stream.on('error', () => {});
    // Diagnostics must not keep the launcher alive after its windows close.
    stream.unref?.();
  }
  return () => prefix.toString('utf8');
}

module.exports = { captureStderr };
