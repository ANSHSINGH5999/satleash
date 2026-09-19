import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { DrillEvent } from './drill-parse.js';
import { DrillRunner } from './drill.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { Logger } from './log.js';
import type { Monitor } from './monitor.js';
import { ROOT } from './regtest.js';
import { RelaySet } from './relays.js';
import { startRelay } from './relay.js';
import { sleep } from './testutil.js';
import { createApp, csp, withNonce, type AppOpts } from './web.js';

const log = new Logger({ level: 'error', write: () => {} });

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
const req = (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Promise<Res>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(body);
  });

async function boot(o: Partial<AppOpts> = {}) {
  const app = createApp({ root: ROOT, host: '127.0.0.1', drill: null, monitor: null, log, dockerOk: async () => true, ...o });
  const { server, token } = app;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    token,
    app,
    post: (path: string, headers: Record<string, string> = {}) => req(port, 'POST', path, { 'x-lifeboat-token': token, ...headers }),
    postJson: (path: string, body: unknown, headers: Record<string, string> = {}) => req(port, 'POST', path, { 'x-lifeboat-token': token, 'content-type': 'application/json', ...headers }, typeof body === 'string' ? body : JSON.stringify(body)),
    close: () => app.close(),
  };
}

/** Reads the drill SSE stream until `stop` says so. */
const readSse = (port: number, stop: (e: DrillEvent) => boolean) =>
  new Promise<DrillEvent[]>((resolve, reject) => {
    const out: DrillEvent[] = [];
    const r = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          const e = JSON.parse(chunk.slice(6)) as DrillEvent;
          out.push(e);
          if (stop(e)) {
            r.destroy();
            resolve(out);
          }
        }
      });
    });
    r.on('error', (e) => (out.length ? resolve(out) : reject(e)));
  });

const fastDrill = () =>
  new DrillRunner({
    run: async (emit) => {
      emit('== fresh regtest cluster', false);
      await sleep(120);
      emit('PASS  channel funds recovered (only fees lost)', false);
      return 0;
    },
    cleanup: async () => {},
  });

const fakeMonitor = (over: Record<string, unknown> = {}) => {
  const relays = new RelaySet(['ws://127.0.0.1:7899/']);
  const sk = generateSecretKey();
  return {
    snapshot: () => ({ security: { worst: 'pass', checks: [] }, relays: relays.all() }),
    verifyNow: async () => ({ ok: true, problems: [] }),
    relays,
    backup: { publishNow: async () => ({ relaysOk: ['a'] }), secretKey: () => sk },
    ...over,
  } as unknown as Monitor;
};

test('pages are served with a nonce CSP, every inline script and style carries the nonce, and framing is denied', async () => {
  const app = await boot();
  try {
    for (const path of ['/', '/console']) {
      const r = await req(app.port, 'GET', path);
      assert.equal(r.status, 200, path);
      const policy = r.headers['content-security-policy'] as string;
      const nonce = /'nonce-([^']+)'/.exec(policy)![1];
      assert.ok(r.body.includes(`nonce="${nonce}"`));
      assert.ok(!/<script>/.test(r.body) && !/<style>/.test(r.body), 'no inline block without a nonce');
      assert.match(policy, /default-src 'none'/);
      assert.match(policy, /frame-ancestors 'none'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const a = await req(app.port, 'GET', '/');
    const b = await req(app.port, 'GET', '/');
    assert.notEqual(a.headers['content-security-policy'], b.headers['content-security-policy'], 'nonce must change per response');
    assert.ok(csp('N').includes("'nonce-N'") && withNonce('<script>x</script>', 'N') === '<script nonce="N">x</script>');
  } finally {
    await app.close();
  }
});

test('requests with a foreign Host or Origin are refused (DNS rebinding and cross-site posts)', async () => {
  const app = await boot({ drill: fastDrill() });
  try {
    assert.equal((await req(app.port, 'GET', '/api/config', { host: 'evil.example' })).status, 403);
    assert.equal((await req(app.port, 'GET', '/api/config', { host: `evil.example:${app.port}` })).status, 403);
    assert.equal((await req(app.port, 'GET', '/api/config', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await app.post('/api/run', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await req(app.port, 'GET', '/api/config')).status, 200);
    assert.equal((await req(app.port, 'GET', '/api/config', { host: `localhost:${app.port}` })).status, 200);
  } finally {
    await app.close();
  }
});

test('state-changing endpoints need the token: missing, wrong and truncated tokens are all refused', async () => {
  const app = await boot({ drill: fastDrill(), monitor: fakeMonitor() });
  try {
    for (const path of ['/api/run', '/api/monitor/verify', '/api/monitor/publish']) {
      assert.equal((await req(app.port, 'POST', path)).status, 403, `${path} without token`);
      assert.equal((await req(app.port, 'POST', path, { 'x-lifeboat-token': 'nope' })).status, 403, `${path} wrong token`);
      assert.equal((await req(app.port, 'POST', path, { 'x-lifeboat-token': app.token.slice(0, -1) })).status, 403, `${path} truncated token`);
    }
    assert.equal((await req(app.port, 'GET', '/api/config')).status, 200);
  } finally {
    await app.close();
  }
});

test('two simultaneous run requests start exactly one drill; the run replays to a late SSE client', async () => {
  const app = await boot({ drill: fastDrill() });
  try {
    const rs = await Promise.all([app.post('/api/run'), app.post('/api/run')]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [202, 409]);
    const evs = await readSse(app.port, (e) => e.type === 'idle');
    assert.equal(evs.filter((e) => e.type === 'start').length, 1);
    assert.ok(evs.some((e) => e.type === 'stage'));
    assert.ok(evs.some((e) => e.type === 'end' && e.ok));
    const replay = await readSse(app.port, (e) => e.type === 'idle');
    assert.deepEqual(replay.map((e) => e.type), evs.map((e) => e.type));
    assert.equal((await app.post('/api/run')).status, 202, 'a new run is possible after idle');
  } finally {
    await sleep(250);
    await app.close();
  }
});

test('when docker is down the run is refused with a clear message and the claim is released', async () => {
  let docker = false;
  const app = await boot({ drill: fastDrill(), dockerOk: async () => docker });
  try {
    const r = await app.post('/api/run');
    assert.equal(r.status, 503);
    assert.match(r.body, /Docker isn't running/);
    docker = true;
    assert.equal((await app.post('/api/run')).status, 202);
  } finally {
    await sleep(250);
    await app.close();
  }
});

test('with the drill disabled, run and stream are unavailable and config says so', async () => {
  const app = await boot({ drill: null });
  try {
    assert.equal((await app.post('/api/run')).status, 409);
    assert.equal((await req(app.port, 'GET', '/api/stream')).status, 404);
    assert.deepEqual(JSON.parse((await req(app.port, 'GET', '/api/config')).body), { token: app.token, drill: false, monitor: false });
  } finally {
    await app.close();
  }
});

test('monitor endpoints: absent monitor is a 404, present monitor serves a snapshot, failures become 502 with the reason', async () => {
  const none = await boot();
  try {
    assert.equal((await req(none.port, 'GET', '/api/monitor')).status, 404);
    assert.equal((await none.post('/api/monitor/verify')).status, 404);
  } finally {
    await none.close();
  }
  const app = await boot({ monitor: fakeMonitor({ verifyNow: async () => { throw new Error('relays unreachable'); } }) });
  try {
    const snap = await req(app.port, 'GET', '/api/monitor');
    assert.equal(snap.status, 200);
    assert.equal(JSON.parse(snap.body).security.worst, 'pass');
    const v = await app.post('/api/monitor/verify');
    assert.equal(v.status, 502);
    assert.equal(JSON.parse(v.body).error, 'relays unreachable');
    assert.equal((await app.post('/api/monitor/publish')).status, 200);
  } finally {
    await app.close();
  }
});

test('the SSE client count is capped', async () => {
  const app = await boot({ drill: fastDrill(), maxSseClients: 1 });
  const first = http.get({ host: '127.0.0.1', port: app.port, path: '/api/stream' });
  try {
    await new Promise((r) => first.on('response', r));
    assert.equal((await req(app.port, 'GET', '/api/stream')).status, 503);
  } finally {
    first.destroy();
    await app.close();
  }
});

test('unknown paths, traversal attempts and source files are not served', async () => {
  const app = await boot();
  try {
    for (const path of ['/api/nope', '/../package.json', '/src/web.ts', '/web/index.html', '/%2e%2e/package.json', '/index.html/../../package.json']) {
      const r = await req(app.port, 'GET', path);
      assert.ok(r.status === 404 || r.status === 200 && r.body.includes('Lose the node'), `${path} -> ${r.status}`);
      assert.ok(!r.body.includes('"dependencies"') && !r.body.includes('createServer'), `${path} leaked a file`);
    }
  } finally {
    await app.close();
  }
});

test('/healthz answers without a monitor and reports the monitor verdict when there is one', async () => {
  const a = await boot();
  const b = await boot({ monitor: fakeMonitor() });
  try {
    assert.deepEqual(JSON.parse((await req(a.port, 'GET', '/healthz')).body), { ok: true, monitor: null });
    assert.deepEqual(JSON.parse((await req(b.port, 'GET', '/healthz')).body), { ok: true, monitor: 'pass' });
  } finally {
    await a.close();
    await b.close();
  }
});

test('every response carries a request id, and errors are explained (cause, impact, action) and tagged with it', async () => {
  const app = await boot({ monitor: fakeMonitor({ verifyNow: async () => { throw new Error('no relay accepted the backup: wss://a (timeout)'); } }) });
  try {
    const ok = await req(app.port, 'GET', '/healthz');
    assert.match(String(ok.headers['x-request-id']), /^[0-9a-f]{8}$/);
    const bad = await app.post('/api/monitor/verify');
    const j = JSON.parse(bad.body);
    assert.equal(bad.status, 502);
    assert.ok(j.error && j.cause && j.impact && j.action, 'explained');
    assert.equal(j.requestId, bad.headers['x-request-id']);
    assert.notEqual(ok.headers['x-request-id'], bad.headers['x-request-id']);
  } finally {
    await app.close();
  }
});

test('relay API: needs the token and a well-formed JSON object; oversize, wrong type and unknown actions get clean 4xx answers', async () => {
  const app = await boot({ monitor: fakeMonitor() });
  try {
    assert.equal((await req(app.port, 'POST', '/api/relays', { 'content-type': 'application/json' }, '{}')).status, 403);
    assert.equal((await app.post('/api/relays')).status, 415, 'no content type');
    assert.equal((await app.postJson('/api/relays', 'not json')).status, 400);
    assert.equal((await app.postJson('/api/relays', '[1,2]')).status, 400, 'an array is not an object');
    assert.equal((await app.postJson('/api/relays', { action: 'add' })).status, 400, 'missing url');
    assert.equal((await app.postJson('/api/relays', { action: 'add', url: 42 })).status, 400, 'url of the wrong type');
    assert.equal((await app.postJson('/api/relays', { action: 'add', url: 'x'.repeat(400) })).status, 400);
    assert.equal((await app.postJson('/api/relays', { action: 'explode', url: 'wss://a.example' })).status, 400);
    const big = await app.postJson('/api/relays', JSON.stringify({ action: 'add', url: 'wss://a.example', pad: 'x'.repeat(40_000) }));
    assert.equal(big.status, 413);
    const j = JSON.parse((await app.postJson('/api/relays', { action: 'add', url: 'https://not-a-websocket.example' })).body);
    assert.match(j.error, /ws:\/\/ or wss:\/\//);
  } finally {
    await app.close();
  }
});

test('relay API: add, duplicate, confirm-before-public, disable, enable, remove, and the last relay cannot be removed or disabled', async () => {
  const app = await boot({ monitor: fakeMonitor() });
  try {
    const add = (url: string, extra: object = {}) => app.postJson('/api/relays', { action: 'add', url, ...extra });
    const first = await add('ws://127.0.0.1:7898');
    assert.equal(first.status, 200, 'a loopback relay needs no confirmation');
    assert.equal(JSON.parse(first.body).relays.length, 2);

    const needs = await add('wss://public.example');
    assert.equal(needs.status, 400);
    const nj = JSON.parse(needs.body);
    assert.equal(nj.needsConfirm, true);
    assert.match(nj.warning, /public infrastructure/);
    const confirmed = await add('wss://public.example', { confirm: true });
    assert.equal(JSON.parse(confirmed.body).relays.find((r: { url: string }) => r.url === 'wss://public.example/').session, true);

    assert.equal((await add('wss://public.example', { confirm: true })).status, 400, 'duplicate');
    const dis = await app.postJson('/api/relays', { action: 'disable', url: 'wss://public.example' });
    assert.equal(JSON.parse(dis.body).relays.find((r: { url: string }) => r.url === 'wss://public.example/').enabled, false);
    assert.equal((await app.postJson('/api/relays', { action: 'enable', url: 'wss://public.example' })).status, 200);
    assert.equal((await app.postJson('/api/relays', { action: 'remove', url: 'wss://public.example' })).status, 200);
    assert.equal((await app.postJson('/api/relays', { action: 'remove', url: 'wss://nope.example' })).status, 400);
    await app.postJson('/api/relays', { action: 'remove', url: 'ws://127.0.0.1:7898' });
    const last = await app.postJson('/api/relays', { action: 'remove', url: 'ws://127.0.0.1:7899' });
    assert.equal(last.status, 400);
    assert.match(JSON.parse(last.body).error, /at least one relay must stay enabled/);
  } finally {
    await app.close();
  }
});

test('relay API: the test action probes a relay for reachability and whether it holds a backup, without publishing anything', async () => {
  const relay = startRelay(7815);
  const app = await boot({ monitor: fakeMonitor() });
  try {
    const up = JSON.parse((await app.postJson('/api/relays', { action: 'test', url: relay.url })).body);
    assert.equal(up.reachable, true);
    assert.equal(up.holdsBackup, false);
    assert.equal(relay.stored().length, 0, 'a test must not write to the relay');
    const down = JSON.parse((await app.postJson('/api/relays', { action: 'test', url: 'ws://127.0.0.1:1' })).body);
    assert.equal(down.reachable, false);
  } finally {
    await app.close();
    await relay.close();
  }
});

test('public relay test API: refuses without confirmation, without a token and with a bad URL; runs one test at a time', async () => {
  let calls = 0;
  const relayTest = async (url: string) => {
    calls++;
    await sleep(150);
    return { url, namespace: 'n', throwawayPubkey: 'p', eventId: 'e', published: true, retrieved: true, signatureValid: true, decrypted: true, payloadValid: true, fingerprintValid: true, deletionRequested: true, deletionHonored: true, errors: [] };
  };
  const app = await boot({ relayTest });
  try {
    assert.equal((await req(app.port, 'POST', '/api/relays/test-public', { 'content-type': 'application/json' }, '{"url":"wss://a.example","confirm":true}')).status, 403);
    const needs = await app.postJson('/api/relays/test-public', { url: 'wss://a.example' });
    assert.equal(needs.status, 400);
    assert.match(JSON.parse(needs.body).warning, /DUMMY event.*throwaway key/);
    assert.equal(calls, 0, 'nothing runs without confirmation');
    assert.equal((await app.postJson('/api/relays/test-public', { url: 'http://a.example', confirm: true })).status, 400);
    assert.equal(calls, 0);
    const both = await Promise.all([app.postJson('/api/relays/test-public', { url: 'wss://a.example', confirm: true }), app.postJson('/api/relays/test-public', { url: 'wss://a.example', confirm: true })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('/api/monitor reports what the console guards actually did', async () => {
  const app = await boot({ monitor: fakeMonitor() });
  try {
    await req(app.port, 'GET', '/api/config', { host: 'evil.example' });
    await req(app.port, 'POST', '/api/relays');
    const snap = JSON.parse((await req(app.port, 'GET', '/api/monitor')).body);
    assert.equal(snap.console.blockedRequests, 2);
    assert.match(snap.security.checks.find((c: { id: string }) => c.id === 'console').detail, /2 request\(s\) refused/);
    assert.equal(app.app.blockedRequests(), 2);
  } finally {
    await app.close();
  }
});

test('shutdown ends open event streams instead of leaving clients hanging', async () => {
  const app = await boot({ drill: fastDrill() });
  const ended = new Promise<void>((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: app.port, path: '/api/stream' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
      res.on('close', () => resolve());
    });
    r.on('error', () => resolve());
  });
  await sleep(100);
  await app.close();
  await Promise.race([ended, sleep(2000).then(() => assert.fail('the stream was not closed on shutdown'))]);
});
