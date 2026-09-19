import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPrerequisites, demoHealth, portFree, resetDemo, waitForFile, wipeDataDir } from './demo-env.js';
import type { MonitorSnapshot } from './monitor.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'lb-reset-'));

test('reset deletes <root>/data and nothing else, from any working directory', () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    mkdirSync(join(root, 'data/alice/deep'), { recursive: true });
    writeFileSync(join(root, 'data/alice/deep/x'), 'x');
    mkdirSync(join(root, 'data-backup'));
    writeFileSync(join(root, 'data-backup/keep'), 'keep');
    writeFileSync(join(root, 'package.json'), '{}');
    for (const dir of ['/', tmpdir(), root, join(root, 'data-backup')]) {
      process.chdir(dir);
      mkdirSync(join(root, 'data/alice'), { recursive: true });
      assert.equal(wipeDataDir(root), true, `from ${dir}`);
      assert.equal(existsSync(join(root, 'data')), false);
      assert.equal(readFileSync(join(root, 'data-backup/keep'), 'utf8'), 'keep', 'a sibling with a similar name is untouched');
      assert.ok(existsSync(join(root, 'package.json')));
      assert.equal(wipeDataDir(root), false, 'nothing to delete is not an error');
    }
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('reset never follows a link out of the repository and refuses anything that is not a directory', () => {
  const root = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, 'precious'), 'do not delete');
    symlinkSync(outside, join(root, 'data'));
    assert.equal(wipeDataDir(root), true);
    assert.equal(existsSync(join(root, 'data')), false, 'the link is gone');
    assert.equal(readFileSync(join(outside, 'precious'), 'utf8'), 'do not delete', 'what it pointed at is not');
    writeFileSync(join(root, 'data'), 'a file, not a directory');
    assert.throws(() => wipeDataDir(root), /not a directory/);
    assert.equal(readFileSync(join(root, 'data'), 'utf8'), 'a file, not a directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('reset removes a link nested inside data without touching its target, and works when the repository path itself is a link', () => {
  const real = tmp();
  const outside = tmp();
  const holder = tmp();
  try {
    writeFileSync(join(outside, 'precious'), 'do not delete');
    mkdirSync(join(real, 'data/alice'), { recursive: true });
    symlinkSync(outside, join(real, 'data/alice/escape'));
    const linkedRoot = join(holder, 'repo-link');
    symlinkSync(real, linkedRoot);
    assert.equal(wipeDataDir(linkedRoot), true);
    assert.equal(existsSync(join(real, 'data')), false);
    assert.equal(readFileSync(join(outside, 'precious'), 'utf8'), 'do not delete', 'a link inside data is removed, never followed');
  } finally {
    for (const d of [real, outside, holder]) rmSync(d, { recursive: true, force: true });
  }
});

test('prerequisites: old Node, no Docker and a busy port are each reported by name', async () => {
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
  const port = (busy.address() as { port: number }).port;
  try {
    assert.equal(await portFree(port), false);
    const r = await checkPrerequisites({ ports: [port], nodeVersion: '20.11.0', dockerInfo: () => { throw new Error('no daemon'); } });
    assert.deepEqual(r.map((c) => [c.name, c.ok]), [['Node.js 22 or newer', false], ['Docker daemon', false], [`Port ${port}`, false]]);
    const good = await checkPrerequisites({ ports: [], nodeVersion: '22.1.0', dockerInfo: () => {} });
    assert.ok(good.every((c) => c.ok));
    assert.deepEqual(await checkPrerequisites({ ports: [], docker: false, nodeVersion: '26.0.0' }).then((c) => c.map((x) => x.name)), ['Node.js 22 or newer'], 'docker can be skipped');
  } finally {
    await new Promise((r) => busy.close(r));
  }
  assert.equal(await portFree(port), true, 'free again once released');
});

test('reset without Docker says so and still clears only <root>/data; a failing compose is reported, not thrown', () => {
  const root = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, 'keep'), 'keep');
    const lines: string[] = [];
    let downCalls = 0;
    const run = () => resetDemo({ root, dockerUp: () => { throw new Error('no daemon'); }, composeDown: () => { downCalls++; }, log: (l) => lines.push(l) });
    mkdirSync(join(root, 'data/alice'), { recursive: true });
    run();
    assert.equal(downCalls, 0, 'compose is not attempted when the daemon does not answer');
    assert.match(lines[0], /Docker is not reachable; containers were not touched/);
    assert.match(lines[1], new RegExp(`deleted ${join(root, 'data').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(existsSync(join(root, 'data')), false);
    run();
    assert.match(lines.at(-1)!, /nothing to delete/);
    const bad: string[] = [];
    mkdirSync(join(root, 'data'));
    resetDemo({ root, dockerUp: () => {}, composeDown: () => { throw new Error('boom'); }, log: (l) => bad.push(l) });
    assert.match(bad[0], /docker compose down failed/);
    assert.equal(existsSync(join(root, 'data')), false, 'data is still cleared');
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('waitForFile sees a file that appears late and gives up on one that never does', async () => {
  const dir = tmp();
  try {
    setTimeout(() => writeFileSync(join(dir, 'tls.cert'), 'x'), 150);
    assert.equal(await waitForFile(join(dir, 'tls.cert'), 3000, 20), true);
    const t = Date.now();
    assert.equal(await waitForFile(join(dir, 'never'), 200, 20), false);
    assert.ok(Date.now() - t < 1500, 'gives up at the timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- readiness: READY only when every component has really answered ---- */
const goodSnap = (): MonitorSnapshot =>
  ({
    node: { connected: true, network: 'regtest', synced: true, blockHeight: 9 },
    relays: [{ url: 'a', enabled: true }, { url: 'b', enabled: true }],
    backup: { running: true, streamConnected: true, state: 'SUCCESS', publishes: 1 },
    verify: { verdict: 'verified', lndValidated: true, relays: [{ state: 'healthy' }, { state: 'healthy' }] },
  }) as unknown as MonitorSnapshot;

const fakeFetch = (snap: MonitorSnapshot | null, o: { down?: string[]; html?: boolean } = {}) => async (url: string) => {
  const path = new URL(url).pathname;
  if (o.down?.includes(path)) throw new Error('ECONNREFUSED');
  const json = path === '/api/monitor' ? (snap ?? {}) : { ok: true };
  return { ok: path !== '/api/monitor' || !!snap, status: 200, json: async () => json, headers: { get: () => (path === '/healthz' || path === '/api/monitor' ? 'application/json' : o.html === false ? 'text/plain' : 'text/html') } };
};

test('demo health: READY needs every component, and each failure is named', async () => {
  const ok = await demoHealth('http://x', fakeFetch(goodSnap()));
  assert.equal(ok.ready, true, JSON.stringify(ok.checks));
  assert.deepEqual(ok.checks.map((c) => c.name), ['Lifeboat server', 'Browser endpoint', 'LND', 'Relays', 'Backup service', 'Verification service']);

  const cases: [string, (s: MonitorSnapshot) => void, string][] = [
    ['LND disconnected', (s) => { s.node.connected = false; }, 'LND'],
    ['LND not synced', (s) => { s.node.synced = false; }, 'LND'],
    ['not regtest', (s) => { s.node.network = 'testnet'; }, 'LND'],
    ['one healthy relay only', (s) => { s.verify!.relays = [{ state: 'healthy' }, { state: 'down' }] as never; }, 'Relays'],
    ['backup pipeline degraded', (s) => { s.backup.state = 'DEGRADED'; }, 'Backup service'],
    ['lnd stream down', (s) => { s.backup.streamConnected = false; }, 'Backup service'],
    ['nothing published', (s) => { s.backup.publishes = 0; }, 'Backup service'],
    ['verification degraded', (s) => { s.verify!.verdict = 'degraded'; }, 'Verification service'],
    ['verification not yet run', (s) => { s.verify = null; }, 'Verification service'],
  ];
  for (const [name, mutate, failing] of cases) {
    const s = goodSnap();
    mutate(s);
    const h = await demoHealth('http://x', fakeFetch(s));
    assert.equal(h.ready, false, name);
    assert.deepEqual(h.checks.filter((c) => !c.ok).map((c) => c.name), name.startsWith('verification not') ? ['Relays', 'Verification service'] : [failing], name);
  }

  const noServer = await demoHealth('http://x', fakeFetch(goodSnap(), { down: ['/healthz', '/', '/console', '/api/monitor'] }));
  assert.equal(noServer.ready, false);
  assert.equal(noServer.checks[0].ok, false);
  const noMonitor = await demoHealth('http://x', fakeFetch(null));
  assert.equal(noMonitor.ready, false);
  assert.ok(noMonitor.checks.filter((c) => !c.ok).length >= 4, 'without a monitor nothing beyond the page is READY');
  assert.equal((await demoHealth('http://x', fakeFetch(goodSnap(), { html: false }))).checks[1].ok, false, 'a non-HTML answer is not a served page');
});
