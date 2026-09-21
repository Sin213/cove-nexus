const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function httpsUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Requests and redirects must use HTTPS without URL credentials.');
  }
  return url;
}

function sensitiveHeader(name) {
  return /^(authorization|proxy-authorization|cookie)$/i.test(name);
}

function hasCredentials(headers) {
  return Object.entries(headers).some(([key, value]) => sensitiveHeader(key) && value);
}

function withoutCredentials(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !sensitiveHeader(key)));
}

function networkError(err) {
  const error = err instanceof Error ? err : new Error(String(err));
  error.isNetworkError = true;
  return error;
}

function requestOnce(request, url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    let response;
    const fail = (err) => {
      const error = networkError(err);
      if (response) response.destroy(error);
      reject(error);
    };
    try {
      req = request(url.toString(), { method: 'GET', headers, timeout: timeoutMs }, (res) => {
        response = res;
        // Keep an error listener attached while the consumer/redirect loop is
        // being scheduled. The stream still retains the error for its reader.
        res.on('error', () => {});
        res.once('aborted', () => res.destroy(networkError(new Error('response aborted'))));
        resolve(res);
      });
      req.on('error', fail);
      req.once('timeout', () => req.destroy(networkError(new Error('timeout'))));
      req.end();
    } catch (err) {
      req?.destroy();
      fail(err);
    }
  });
}

async function responseFor(request, value, headers, { timeoutMs, maxRedirects = 5 }) {
  let url = httpsUrl(value);
  let currentHeaders = { ...headers };
  for (let redirects = 0; ; redirects++) {
    const res = await requestOnce(request, url, currentHeaders, timeoutMs);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      // Do not keep downloading an arbitrary redirect response body.
      res.destroy();
      if (redirects >= maxRedirects) throw new Error('too many redirects');
      const next = httpsUrl(res.headers.location, url);
      if (next.origin !== url.origin) currentHeaders = withoutCredentials(currentHeaders);
      url = next;
      continue;
    }
    return { res, headers: currentHeaders };
  }
}

function responseLength(res) {
  const length = Number(res.headers['content-length']);
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

function sizeLimitError(maxBytes) {
  const error = new Error(`response exceeded ${maxBytes} bytes`);
  error.isSizeLimitError = true;
  return error;
}

async function readBody(res, maxBytes) {
  if (responseLength(res) > maxBytes) {
    res.destroy();
    throw sizeLimitError(maxBytes);
  }
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of res) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        res.destroy();
        throw sizeLimitError(maxBytes);
      }
      chunks.push(buffer);
    }
    if (res.complete === false || (responseLength(res) && received !== responseLength(res))) {
      throw new Error('incomplete response');
    }
  } catch (err) {
    // A response-size policy rejection is not a transport failure: it must
    // never be treated as network-flaky and silently satisfied from stale
    // cache the way a real connection failure is.
    if (err.isSizeLimitError) throw err;
    throw networkError(err);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function publicCacheUrl(value) {
  try {
    const url = httpsUrl(value);
    return url.origin === 'https://api.github.com'
      && ![...url.searchParams.keys()].some(key => /token|secret|password|api[_-]?key/i.test(key));
  } catch { return false; }
}

function createJsonClient({
  request = https.request,
  cache = new Map(),
  cacheFile,
  now = Date.now,
  ttlMs = 5 * 60 * 1000,
  staleMs = 7 * 24 * 60 * 60 * 1000,
  maxEntries = 256,
  maxCacheBytes = 8 * 1024 * 1024,
  maxResponseBytes = 8 * 1024 * 1024,
  concurrency = 4,
  timeoutMs = 10000,
  maxRedirects = 5,
  getRateLimit = () => ({ until: 0 }),
  onRateLimit = () => {},
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('invalid concurrency');
  const inFlight = new Map();
  const queue = [];
  let active = 0;
  let persistence = Promise.resolve();
  let generation = 0;

  function trimCache() {
    let bytes = 0;
    let count = 0;
    for (const [url, entry] of [...cache].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry.data)) + Buffer.byteLength(url);
      if (count >= maxEntries || bytes + size > maxCacheBytes || now() - entry.at > staleMs) {
        cache.delete(url);
      } else {
        bytes += size;
        count++;
      }
    }
  }

  if (cacheFile) {
    try {
      if (fs.statSync(cacheFile).size <= maxCacheBytes) {
        const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (saved.version === 1 && Array.isArray(saved.entries)) {
          for (const entry of saved.entries.slice(-maxEntries)) {
            if (publicCacheUrl(entry.url) && Number.isFinite(entry.at)
                && entry.at <= now() && now() - entry.at <= staleMs && 'data' in entry) {
              cache.set(entry.url, { at: entry.at, data: entry.data, public: true });
            }
          }
        }
      }
    } catch { /* A missing or corrupt cache never prevents startup. */ }
    trimCache();
  }

  function persist() {
    if (!cacheFile) return;
    const entries = [];
    let bytes = 32;
    for (const [url, entry] of [...cache].reverse()) {
      if (!entry.public || !publicCacheUrl(url) || now() - entry.at > staleMs) continue;
      const saved = { url, at: entry.at, data: entry.data };
      const size = Buffer.byteLength(JSON.stringify(saved)) + 1;
      if (entries.length >= maxEntries || bytes + size > maxCacheBytes) continue;
      bytes += size;
      entries.unshift(saved);
    }
    const body = JSON.stringify({ version: 1, entries });
    persistence = persistence.then(async () => {
      const temporary = `${cacheFile}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
        await fsp.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, cacheFile);
      } catch { /* Cache persistence is best effort, including read-only disks. */ }
      finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
    });
  }

  function cached(url, key, anonymous, allowStale) {
    const entry = cache.get(url);
    if (!entry || (entry.requestKey !== key && !(entry.public && anonymous))) return undefined;
    if (now() - entry.at > (allowStale ? staleMs : ttlMs)) return undefined;
    // Keep recently used entries at the end for bounded LRU eviction.
    cache.delete(url);
    cache.set(url, entry);
    return entry;
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const { work, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; drain(); });
    }
  }

  function schedule(work) {
    return new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); drain(); });
  }

  function rateError() {
    return new Error(`github rate-limited until ${new Date(getRateLimit().until).toLocaleTimeString()}`);
  }

  function getJson(url, headers = {}, { allowCache = true, allowStale = true } = {}) {
    try { url = httpsUrl(url).toString(); }
    catch (err) { return Promise.reject(err); }
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const key = JSON.stringify([url, Object.entries(normalizedHeaders).sort(([a], [b]) => a.localeCompare(b))]);
    const anonymous = !hasCredentials(headers);
    if (allowCache) {
      const hit = cached(url, key, anonymous, false);
      if (hit) return Promise.resolve(hit.data);
    }
    const flightKey = JSON.stringify([generation, key, allowCache, allowStale]);
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const startedGeneration = generation;
    const fallback = () => allowCache && allowStale && cached(url, key, anonymous, true);
    const pending = schedule(async () => {
      // Recheck after waiting: an earlier queued request may exhaust the limit.
      if (now() < getRateLimit().until) {
        const stale = fallback();
        if (stale) return stale.data;
        throw rateError();
      }
      let responseStatus;
      try {
        const { res, headers: sentHeaders } = await responseFor(request, url, headers, { timeoutMs, maxRedirects });
        responseStatus = res.statusCode;
        const remaining = Number(res.headers['x-ratelimit-remaining']);
        const reset = Number(res.headers['x-ratelimit-reset']);
        const authed = hasCredentials(sentHeaders);
        if (startedGeneration === generation && remaining === 0 && reset > 0) {
          onRateLimit({ until: reset * 1000, authed });
        }
        const body = await readBody(res, maxResponseBytes);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = JSON.parse(body);
          if (startedGeneration === generation) {
            cache.delete(url);
            cache.set(url, { at: now(), data, requestKey: key, public: anonymous && publicCacheUrl(url) });
            trimCache();
            persist();
          }
          return data;
        }
        if (res.statusCode === 429 || (res.statusCode === 403 && /rate limit/i.test(body))) {
          if (startedGeneration === generation && !(getRateLimit().until > now())) {
            const retry = Number(res.headers['retry-after']);
            onRateLimit({ until: now() + (retry > 0 ? retry * 1000 : 60 * 60 * 1000), authed });
          }
          const stale = fallback();
          if (stale) return stale.data;
          throw rateError();
        }
        throw new Error(`github ${res.statusCode}: ${body.slice(0, 200)}`);
      } catch (err) {
        if (err.isNetworkError && responseStatus !== 401 && responseStatus !== 404) {
          const stale = fallback();
          if (stale) return stale.data;
        }
        throw err;
      }
    }).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, pending);
    return pending;
  }

  return {
    getJson,
    clear() { generation++; cache.clear(); persist(); },
    flush() { return persistence; },
  };
}

function createDownloader({ request = https.request, timeoutMs = 60000, maxRedirects = 5 } = {}) {
  return async function downloadToFile(url, dest, onProgress, { maxBytes = 0 } = {}) {
    let res;
    let handle;
    let created = false;
    try {
      ({ res } = await responseFor(request, url, {
        'User-Agent': 'cove-nexus-launcher', 'Accept': 'application/octet-stream',
      }, { timeoutMs, maxRedirects }));
      if (res.statusCode !== 200) throw new Error(`download ${res.statusCode}`);
      const total = responseLength(res);
      if (maxBytes && total > maxBytes) throw new Error(`download too large: ${total} > ${maxBytes}`);
      let received = 0;
      onProgress?.({ received, total });
      handle = await fsp.open(dest, 'wx', 0o600);
      created = true;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (maxBytes && received > maxBytes) return callback(new Error(`download exceeded ${maxBytes} bytes`));
          try { onProgress?.({ received, total }); }
          catch (err) { return callback(err); }
          callback(null, chunk);
        },
      });
      await pipeline(res, meter, handle.createWriteStream());
      if (res.complete === false || (total && received !== total)) throw new Error('incomplete download');
    } catch (err) {
      res?.destroy();
      if (handle) await handle.close().catch(() => {});
      if (created) await fsp.rm(dest, { force: true }).catch(() => {});
      throw err;
    }
  };
}

module.exports = { createJsonClient, createDownloader };
