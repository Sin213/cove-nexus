const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate } = require('node:timers');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createJsonClient, createDownloader } = require('../lib/network');

const API = 'https://api.github.com/repos/Sin213/cove-test/releases/latest';
const tick = () => new Promise(resolve => setImmediate(resolve));

function transport(handler) {
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = (err) => { if (err) queueMicrotask(() => req.emit('error', err)); };
    const call = {
      url, options, req,
      respond(status = 200, body = '{}', headers = {}) {
        const res = new PassThrough();
        res.statusCode = status;
        res.headers = headers;
        callback(res);
        if (body !== null) queueMicrotask(() => res.end(body));
        return res;
      },
    };
    calls.push(call);
    req.end = () => queueMicrotask(() => handler(call, calls.length));
    return req;
  };
  return { request, calls };
}

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cove-network-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('JSON requests reject unsafe redirects and stop redirect loops', async () => {
  const bad = transport(call => call.respond(302, '', { location: 'http://example.com/asset' }));
  await assert.rejects(createJsonClient(bad).getJson(API), /must use HTTPS/);
  assert.equal(bad.calls.length, 1);

  const loop = transport(call => call.respond(302, '', { location: '/loop' }));
  await assert.rejects(createJsonClient({ ...loop, maxRedirects: 2 }).getJson(API), /too many redirects/);
  assert.equal(loop.calls.length, 3);
});

test('redirects retain same-origin auth and never restore it after leaving the origin', async () => {
  const mock = transport((call, n) => {
    if (n === 1) call.respond(302, '', { location: '/same-origin' });
    else if (n === 2) call.respond(302, '', { location: 'https://objects.githubusercontent.com/asset' });
    else if (n === 3) call.respond(302, '', { location: API });
    else call.respond(200, '{"ok":true}');
  });
  const client = createJsonClient(mock);
  assert.deepEqual(await client.getJson(API, { Authorization: 'Bearer secret', COOKIE: 'session=secret' }), { ok: true });
  assert.equal(mock.calls[1].options.headers.Authorization, 'Bearer secret');
  for (const call of mock.calls.slice(2)) {
    assert.equal(Object.keys(call.options.headers).some(k => /authorization|cookie/i.test(k)), false);
  }
});

test('JSON aborts, response errors, request construction failures and timeouts reject', async () => {
  for (const type of ['aborted', 'error']) {
    const mock = transport(call => {
      const res = call.respond(200, null);
      setImmediate(() => {
        res.write('{"partial":');
        if (type === 'aborted') res.emit('aborted');
        else res.destroy(new Error('connection lost'));
      });
    });
    await assert.rejects(createJsonClient(mock).getJson(API), /aborted|connection lost/);
  }
  await assert.rejects(createJsonClient({ request() { throw new Error('sync failure'); } }).getJson(API), /sync failure/);
  const timeout = transport(call => call.req.emit('timeout'));
  await assert.rejects(createJsonClient(timeout).getJson(API), /timeout/);
});

test('JSON response sizes are bounded even without content-length', async () => {
  const mock = transport(call => call.respond(200, 'x'.repeat(40)));
  await assert.rejects(createJsonClient({ ...mock, maxResponseBytes: 20 }).getJson(API), /exceeded 20 bytes/);
});

test('duplicate JSON requests share work and unique requests respect the concurrency cap', async () => {
  const releases = [];
  let running = 0;
  let maximum = 0;
  const mock = transport(call => {
    running++;
    maximum = Math.max(maximum, running);
    releases.push(() => { running--; call.respond(200, '{"ok":true}'); });
  });
  const client = createJsonClient({ ...mock, concurrency: 3 });
  const first = client.getJson(API);
  assert.equal(client.getJson(API), first);
  const rest = Array.from({ length: 7 }, (_, i) => client.getJson(`${API}?page=${i}`));
  await tick();
  assert.equal(mock.calls.length, 3);
  while (mock.calls.length < 8 || releases.length) {
    for (const release of releases.splice(0)) release();
    await tick();
  }
  await Promise.all([first, ...rest]);
  assert.equal(maximum, 3);
  assert.equal(mock.calls.length, 8);
});

test('different credentials never deduplicate into the same response', async () => {
  const mock = transport(call => call.respond(200, JSON.stringify({ auth: call.options.headers.Authorization })));
  const client = createJsonClient(mock);
  const [a, b] = await Promise.all([
    client.getJson(API, { Authorization: 'Bearer a' }),
    client.getJson(API, { Authorization: 'Bearer b' }),
  ]);
  assert.deepEqual([a.auth, b.auth], ['Bearer a', 'Bearer b']);
  assert.equal(mock.calls.length, 2);
});

test('queued requests recheck rate limits before using a connection', async () => {
  let rate = { until: 0 };
  const mock = transport(call => call.respond(200, '{}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }));
  const client = createJsonClient({ ...mock, concurrency: 1, now: () => 1000,
    getRateLimit: () => rate, onRateLimit: value => { rate = value; } });
  const results = await Promise.allSettled([client.getJson(API), client.getJson(`${API}?other=1`)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.match(results[1].reason.message, /rate-limited/);
  assert.equal(mock.calls.length, 1);
  assert.equal(rate.authed, false);
});

test('stale cache covers offline errors but never hides 401, 404, or forced refresh errors', async () => {
  let time = 1;
  let status = 200;
  const mock = transport(call => {
    if (status === 0) call.req.emit('error', new Error('offline'));
    else call.respond(status, status === 200 ? '{"cached":true}' : 'missing');
  });
  const client = createJsonClient({ ...mock, now: () => time, ttlMs: 5 });
  await client.getJson(API);
  time = 20;
  status = 0;
  assert.deepEqual(await client.getJson(API), { cached: true });
  await assert.rejects(client.getJson(API, {}, { allowCache: false }), /offline/);
  await assert.rejects(client.getJson(API, {}, { allowStale: false }), /offline/);
  for (status of [401, 404]) await assert.rejects(client.getJson(API), new RegExp(`github ${status}`));
});

test('an oversized response is a policy rejection, not a network failure eligible for stale-cache fallback', async () => {
  let time = 1;
  let big = false;
  const mock = transport(call => {
    if (big) call.respond(200, 'x'.repeat(40));
    else call.respond(200, '{"cached":true}');
  });
  const client = createJsonClient({ ...mock, now: () => time, ttlMs: 5, maxResponseBytes: 20 });
  await client.getJson(API);
  time = 20;
  big = true;
  await assert.rejects(client.getJson(API), /exceeded 20 bytes/);
});

test('stale cache does not mask an aborted 401 or 404 response body', async () => {
  let time = 1;
  let status = 200;
  const mock = transport(call => {
    if (status === 200) return call.respond(200, '{}');
    const res = call.respond(status, null);
    setImmediate(() => res.emit('aborted'));
  });
  const client = createJsonClient({ ...mock, now: () => time, ttlMs: 5 });
  await client.getJson(API);
  time = 20;
  for (status of [401, 404]) await assert.rejects(client.getJson(API), /aborted/);
});

test('rate-limited responses can use stale cache and forced requests still fail', async () => {
  let time = 1;
  let rate = { until: 0 };
  const mock = transport((call, n) => n === 1
    ? call.respond(200, '{"cached":true}')
    : call.respond(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }));
  const client = createJsonClient({ ...mock, now: () => time, ttlMs: 5,
    getRateLimit: () => rate, onRateLimit: value => { rate = value; } });
  await client.getJson(API);
  time = 20;
  assert.deepEqual(await client.getJson(API), { cached: true });
  assert.deepEqual(await client.getJson(API), { cached: true });
  await assert.rejects(client.getJson(API, {}, { allowCache: false }), /rate-limited/);
  assert.equal(mock.calls.length, 2);
});

test('disk cache survives restarts and excludes authenticated responses and credentials', async (t) => {
  const cacheFile = path.join(await directory(t), 'cache.json');
  const mock = transport(call => call.respond(200, call.options.headers.Authorization ? '{"private":"hidden"}' : '{"public":true}'));
  const client = createJsonClient({ ...mock, cacheFile });
  await client.getJson(API);
  await client.getJson(`${API}?private=1`, { Authorization: 'Bearer super-secret' });
  await client.flush();
  const saved = await fs.readFile(cacheFile, 'utf8');
  assert.doesNotMatch(saved, /super-secret|hidden|private=1|requestKey/);
  assert.equal(JSON.parse(saved).entries.length, 1);
  const offline = transport(call => call.req.emit('error', new Error('offline')));
  const restarted = createJsonClient({ ...offline, cacheFile });
  assert.deepEqual(await restarted.getJson(API), { public: true });
  assert.equal(offline.calls.length, 0);
  await assert.rejects(restarted.getJson(API, { Authorization: 'Bearer another-user' }), /offline/);
});

test('disk cache limits entries and age and tolerates corruption', async (t) => {
  const cacheFile = path.join(await directory(t), 'cache.json');
  const mock = transport(call => call.respond(200, '{}'));
  const client = createJsonClient({ ...mock, cacheFile, maxEntries: 2, now: () => 100 });
  for (let i = 0; i < 3; i++) await client.getJson(`${API}?page=${i}`);
  await client.flush();
  assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).entries.length, 2);
  const later = createJsonClient({ ...mock, cacheFile, now: () => 1000, staleMs: 50 });
  await later.getJson(`${API}?page=2`);
  assert.equal(mock.calls.length, 4);
  await later.flush();
  await fs.writeFile(cacheFile, '{broken');
  assert.doesNotThrow(() => createJsonClient({ ...mock, cacheFile }));
});

test('clearing the cache prevents earlier in-flight requests from repopulating it', async (t) => {
  const cacheFile = path.join(await directory(t), 'cache.json');
  let release;
  const mock = transport(call => { release = () => call.respond(200, '{}'); });
  const cache = new Map();
  const client = createJsonClient({ ...mock, cache, cacheFile });
  const pending = client.getJson(API);
  await tick();
  client.clear();
  release();
  await pending;
  await client.flush();
  assert.equal(cache.size, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, 'utf8')).entries, []);
});

test('downloads follow relative HTTPS redirects and report completed bytes', async (t) => {
  const dest = path.join(await directory(t), 'asset');
  const mock = transport((call, n) => n === 1
    ? call.respond(302, '', { location: '/asset' })
    : call.respond(200, 'binary', { 'content-length': '6' }));
  const progress = [];
  await createDownloader(mock)(API, dest, value => progress.push(value), { maxBytes: 6 });
  assert.equal(await fs.readFile(dest, 'utf8'), 'binary');
  assert.deepEqual(progress.at(-1), { received: 6, total: 6 });
  assert.equal(mock.calls[1].url, 'https://api.github.com/asset');
});

test('failed downloads remove partial files for aborts, stream errors, size limits and truncated bodies', async (t) => {
  const dir = await directory(t);
  for (const type of ['aborted', 'error', 'size', 'truncated']) {
    const dest = path.join(dir, type);
    const mock = transport(call => {
      if (type === 'size') return call.respond(200, 'too many bytes');
      if (type === 'truncated') return call.respond(200, 'short', { 'content-length': '20' });
      const res = call.respond(200, null);
      setImmediate(() => {
        res.write('part');
        if (type === 'aborted') res.emit('aborted');
        else res.destroy(new Error('connection lost'));
      });
    });
    await assert.rejects(createDownloader(mock)(API, dest, null, { maxBytes: type === 'size' ? 4 : 100 }));
    await assert.rejects(fs.stat(dest), { code: 'ENOENT' });
  }
});

test('download failures before opening the destination never remove existing files', async (t) => {
  const dest = path.join(await directory(t), 'existing');
  await fs.writeFile(dest, 'keep');
  const success = transport(call => call.respond(200, 'replace'));
  await assert.rejects(createDownloader(success)(API, dest), { code: 'EEXIST' });
  const redirect = transport(call => call.respond(302, '', { location: 'http://example.com/asset' }));
  await assert.rejects(createDownloader(redirect)(API, dest), /must use HTTPS/);
  assert.equal(await fs.readFile(dest, 'utf8'), 'keep');
});
