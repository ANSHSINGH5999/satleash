import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { VerifyResult } from './backup.js';
import type { Lnd } from './lnd.js';
import { Logger } from './log.js';
import { Monitor } from './monitor.js';
import { fakeLnd, fakePublisher, sleep, waitFor } from './testutil.js';

const log = new Logger({ level: 'error', write: () => {} });
const made: Monitor[] = [];
afterEach(() => made.splice(0).forEach((m) => m.stop()));

/** A Lnd stand-in with everything the monitor calls; `net` and `reachable` can be changed by the test. */
function stubLnd(net = 'regtest') {
  const f = fakeLnd();
  const s = { net, reachable: true, canSpend: false as boolean | undefined };
  const lnd = {
    ...f.lnd,
    getInfo: async () => {
      if (!s.reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
      return { identity_pubkey: 'aa'.repeat(33), alias: 'stub', synced_to_chain: true, block_height: 7, version: '0.20.0', chains: [{ chain: 'bitcoin', network: s.net }] };
    },
    listChannels: async () => [{ active: true, local_balance: '900', remote_balance: '100', remote_pubkey: 'bb'.repeat(33) }, { active: false, local_balance: '50', remote_balance: '0', remote_pubkey: 'cc'.repeat(33) }],
    pending: async () => ({ waiting_close_channels: [{}], pending_force_closing_channels: [] }),
    canSpendOnchain: async () => s.canSpend,
  } as unknown as Lnd;
  return { f, s, lnd };
}
const okVerify = (o: Partial<VerifyResult> = {}): VerifyResult => ({ ok: true, verdict: 'verified', checkedAt: Date.now(), channelsCurrent: 2, problems: [], relays: [], ...o });
const mk = (l: Lnd, over: Record<string, unknown> = {}) => {
  const pub = fakePublisher();
  const m = new Monitor({ lnd: l, relays: ['ws://x/', 'ws://y/'], log, publisher: pub.p, refreshMs: 1e9, infoEveryMs: 1e9, verifyEveryMs: 1e9, verifyFn: async () => okVerify(), ...over });
  made.push(m);
  return { m, pub };
};

test('mainnet is refused before anything is published, unless explicitly allowed', async () => {
  const main = stubLnd('mainnet');
  const a = mk(main.lnd);
  await assert.rejects(a.m.start(), /MAINNET/);
  await assert.rejects(a.m.start(), /MAINNET/, 'a refused start is refused again, not silently treated as running');
  assert.equal(a.pub.st.calls.length, 0, 'nothing may be published on a refused network');
  assert.equal(a.m.backup.nostrPubkey(), undefined, 'no key may be derived either');

  const b = mk(main.lnd, { allowMainnet: true });
  await b.m.start();
  await waitFor(() => b.pub.st.calls.length === 1, 3000, 'publish when allowed');
  assert.equal(b.m.snapshot().node.network, 'mainnet');
  assert.equal(b.m.snapshot().security.checks.find((c) => c.id === 'network')?.title, 'MAINNET');
});

test('an expected network that does not match the node is refused before anything is published', async () => {
  const { lnd } = stubLnd('regtest');
  const a = mk(lnd, { expectNetwork: 'testnet' });
  await assert.rejects(a.m.start(), /REGTEST but LIFEBOAT_NETWORK=testnet/);
  assert.equal(a.pub.st.calls.length, 0);
  assert.equal(a.m.backup.nostrPubkey(), undefined);
  const ok = mk(stubLnd('regtest').lnd, { expectNetwork: 'regtest' });
  await ok.m.start();
  await waitFor(() => ok.pub.st.calls.length === 1, 3000, 'publish on the expected network');
});

test('starting twice does not double the timers or the lnd subscription, and stop() ends every timer', async () => {
  const { f, lnd } = stubLnd();
  let infos = 0;
  const counted = { ...lnd, getInfo: (() => { infos++; return lnd.getInfo(); }) as Lnd['getInfo'] } as Lnd;
  const { m } = mk(counted, { infoEveryMs: 50 });
  await m.start();
  await m.start(); // a second start must be a no-op
  assert.equal(f.state.subscribes, 1, 'one backup-stream subscription');
  const before = infos;
  await sleep(520);
  const polled = infos - before;
  assert.ok(polled >= 6 && polled <= 12, `one poll every 50 ms is about 10 in 520 ms, got ${polled} (double timers would give about 20)`);
  m.stop();
  await sleep(50);
  const stoppedAt = { infos, exports: f.state.exports };
  await sleep(300);
  assert.deepEqual({ infos, exports: f.state.exports }, stoppedAt, 'no lnd call after stop()');
});

test('the snapshot is built from what lnd reports: network, channels, pending, macaroon verdict', async () => {
  const { lnd } = stubLnd();
  const { m } = mk(lnd);
  await m.start();
  await waitFor(() => m.snapshot().backup.publishes === 1, 3000, 'publish');
  const s = m.snapshot();
  assert.equal(s.node.network, 'regtest');
  assert.equal(s.node.connected, true);
  assert.deepEqual(s.channels, { total: 2, active: 1, pending: 1, localSats: 950, remoteSats: 100 });
  assert.equal(s.macaroon.canSpend, false);
  assert.equal(s.relays.length, 2);
  assert.equal(s.security.checks.find((c) => c.id === 'macaroon')?.status, 'pass');
});

test('concurrent verifications share one run; a later call starts a fresh one', async () => {
  const { lnd } = stubLnd();
  let runs = 0;
  const { m } = mk(lnd, { verifyFn: async () => { runs++; await sleep(80); return okVerify(); } });
  await m.start();
  await waitFor(() => runs >= 1, 3000, 'the startup verification');
  await waitFor(() => runs === 1 && !(m as unknown as { inflight?: unknown }).inflight, 3000, 'startup verification finished');
  runs = 0;
  const [a, b, c] = await Promise.all([m.verifyNow(), m.verifyNow(), m.verifyNow()]);
  assert.equal(runs, 1, 'three callers, one probe of the relays');
  assert.ok(a === b && b === c);
  await m.verifyNow();
  assert.equal(runs, 2);
});

test('a verification requested after a publish never reuses a run that began before that publish finished', async () => {
  const { lnd } = stubLnd();
  let calls = 0;
  const verifyFn = async () => {
    const n = ++calls;
    if (n === 1) await sleep(200); // the run that is in flight while the publish happens
    return okVerify({ channelsCurrent: n });
  };
  const { m } = mk(lnd, { verifyFn });
  await m.start();
  const before = calls;
  const a = m.verifyNow(); // begins now
  await sleep(20);
  assert.equal(calls, before + 1, 'the first run is in flight');
  await m.backup.publishNow(); // completes while that run is still going
  const b = m.verifyNow();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, before + 2, 'a second, fresh run was made');
  assert.notEqual(rb.channelsCurrent, ra.channelsCurrent, 'the answer after the publish is not the answer that predates it');
  assert.equal(rb.channelsCurrent, before + 2);
  // and two callers with no publish in between still share one run
  const c = m.verifyNow();
  const d = m.verifyNow();
  assert.equal(await c, await d);
  assert.equal(calls, before + 3);
});

test('a failing verification is reported to every waiting caller and does not wedge later ones', async () => {
  const { lnd } = stubLnd();
  let fail = false;
  const { m } = mk(lnd, { verifyFn: async () => { await sleep(30); if (fail) throw new Error('probe exploded'); return okVerify(); } });
  await m.start();
  await sleep(700); // startup verification
  fail = true;
  const results = await Promise.allSettled([m.verifyNow(), m.verifyNow()]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  fail = false;
  assert.equal((await m.verifyNow()).ok, true);
});

test('the verification verdict is reflected in the backup pipeline state', async () => {
  const { lnd } = stubLnd();
  let verdict: VerifyResult['verdict'] = 'degraded';
  const { m } = mk(lnd, { verifyFn: async () => okVerify({ verdict, ok: verdict !== 'failed', problems: ['x'] }) });
  await m.start();
  await waitFor(() => m.backup.status().state === 'SUCCESS', 3000, 'first publish');
  await m.verifyNow();
  assert.equal(m.backup.status().state, 'DEGRADED');
  verdict = 'failed';
  await m.verifyNow();
  assert.equal(m.backup.status().state, 'FAILED');
});

test('losing lnd shows as disconnected and failing, and recovery is picked up automatically', async () => {
  const { lnd, s } = stubLnd();
  const { m } = mk(lnd, { infoEveryMs: 40 });
  await m.start();
  assert.equal(m.snapshot().node.connected, true);
  s.reachable = false;
  await waitFor(() => !m.snapshot().node.connected, 2000, 'disconnect noticed');
  assert.match(m.snapshot().node.error ?? '', /ECONNREFUSED/);
  assert.equal(m.snapshot().security.checks.find((c) => c.id === 'lnd')?.status, 'fail');
  s.reachable = true;
  await waitFor(() => m.snapshot().node.connected, 2000, 'reconnect noticed');
  assert.equal(m.snapshot().security.checks.find((c) => c.id === 'lnd')?.status, 'pass');
});

test('adding a relay at runtime publishes the current backup to it', async () => {
  const { lnd } = stubLnd();
  const { m, pub } = mk(lnd);
  await m.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first publish');
  m.relays.add('ws://z.example/');
  await waitFor(() => pub.st.calls.length === 2, 3000, 'publish after the change');
  assert.equal(m.snapshot().config.relays.length, 3);
});

test('self-healing: when verification finds the relays behind the node, the monitor republishes on its own (once at a time)', async () => {
  const { lnd } = stubLnd();
  let behind = true;
  const { m, pub } = mk(lnd, { verifyFn: async () => okVerify(behind ? { ok: false, verdict: 'failed', matchesCurrent: false, problems: ['behind'] } : {}) });
  await m.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'startup publish');
  await m.verifyNow();
  await waitFor(() => pub.st.calls.length === 2, 3000, 'republish after a behind verdict');
  behind = false;
  await m.verifyNow();
  await sleep(100);
  assert.equal(pub.st.calls.length, 2, 'a good verdict does not trigger another publish');
});
