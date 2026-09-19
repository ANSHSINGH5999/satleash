import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { BackupService, canTransition, type BackupState } from './backup.js';
import { Logger } from './log.js';
import { fakeLnd, fakePublisher, sleep, waitFor } from './testutil.js';

const log = new Logger({ level: 'error', write: () => {} });
const made: BackupService[] = [];
afterEach(() => made.splice(0).forEach((s) => s.stop())); // a failing assertion must not leave timers running
const make = (over: Record<string, unknown> = {}) => {
  const f = fakeLnd();
  const pub = fakePublisher(typeof over.fail === 'number' ? over.fail : 0);
  const svc = new BackupService({ lnd: f.lnd, relays: ['ws://x/'], log, publisher: pub.p, refreshMs: 1e9, retryMs: [10, 10], resubscribeMs: 10, ...over });
  made.push(svc);
  return { f, pub, svc };
};

test('publishes at start and on change, never republishes an unchanged backup, timestamps only increase', async () => {
  const { f, pub, svc } = make();
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first publish');
  f.emit();
  f.emit();
  await sleep(60);
  assert.equal(pub.st.calls.length, 1, 'same channels must not be republished even though lnd re-encrypts the blob on every export');
  f.state.points.push('cc:2');
  f.emit();
  await waitFor(() => pub.st.calls.length === 2, 3000, 'second publish');
  assert.ok(pub.st.calls[1].ts > pub.st.calls[0].ts);
  const s = svc.status();
  assert.equal(s.publishes, 2);
  assert.equal(s.lastPublish?.channels, 3, 'the record describes the newest publish');
  assert.equal(s.streamConnected, true);
  assert.equal(s.history.length, 2);
  svc.stop();
});

test('a failed publish is retried with backoff and the error clears once it succeeds', async () => {
  const { pub, svc } = make({ fail: 2 });
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'publish after two failures');
  const s = svc.status();
  assert.equal(s.failures, 2);
  assert.equal(s.lastError, undefined);
  assert.equal(s.retryPending, false);
  svc.stop();
});

test('changes made while the lnd stream was down are picked up after it reconnects', async () => {
  const { f, pub, svc } = make();
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first publish');
  f.state.points.push('cc:2'); // a channel opened while the stream was down: no stream event for it
  f.drop();
  assert.equal(svc.status().streamConnected, false);
  await waitFor(() => f.state.subscribes === 2 && pub.st.calls.length === 2, 3000, 'resubscribe and re-export');
  assert.equal(svc.status().streamConnected, true);
  svc.stop();
});

test('the periodic refresh republishes even when nothing changed', async () => {
  const { pub, svc } = make({ refreshMs: 40 });
  await svc.start();
  await waitFor(() => pub.st.calls.length >= 3, 3000, 'refreshes');
  assert.equal(new Set(pub.st.calls.map((c) => JSON.parse(c.payload).cp)).size, 1, 'same channel set every time');
  svc.stop();
});

test('publishNow surfaces a failure to the caller and records it', async () => {
  const { pub, svc } = make({ retryMs: [1e9] });
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first publish');
  pub.st.fail = 1;
  await assert.rejects(svc.publishNow(), /relays down/);
  const s = svc.status();
  assert.equal(s.lastError?.message, 'relays down');
  assert.equal(s.retryPending, true);
  svc.stop();
});

test('an oversized backup fails with a message that names the NIP-44 limit', async () => {
  const { f, svc } = make({ retryMs: [1e9] });
  f.state.scbOverride = 'A'.repeat(70000);
  await svc.start();
  await waitFor(() => !!svc.status().lastError, 3000, 'error recorded');
  assert.match(svc.status().lastError!.message, /NIP-44 limit/);
  svc.stop();
});

test('new events are dated after anything of ours already on the relays, so a future-dated leftover cannot shadow them', async () => {
  const future = Math.floor(Date.now() / 1000) + 86_400; // e.g. left behind by a run with a clock that was a day ahead
  const f = fakeLnd();
  const pub = fakePublisher(0, future);
  const svc = new BackupService({ lnd: f.lnd, relays: ['ws://x/'], log, publisher: pub.p, refreshMs: 1e9 });
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first publish');
  assert.equal(pub.st.calls[0].ts, future + 1);
  svc.stop();
});

test('an unreachable relay set at startup does not prevent the service from starting', async () => {
  const f = fakeLnd();
  const pub = fakePublisher(0);
  pub.p.newestTimestamp = async () => {
    throw new Error('relays unreachable');
  };
  const svc = new BackupService({ lnd: f.lnd, relays: ['ws://x/'], log, publisher: pub.p, refreshMs: 1e9 });
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'publish despite the failed lookup');
  svc.stop();
});

const ALL: BackupState[] = ['IDLE', 'BACKING_UP', 'ENCRYPTING', 'PUBLISHING', 'VERIFYING', 'SUCCESS', 'DEGRADED', 'FAILED', 'RECOVERING'];

test('state machine: exactly the documented transitions are legal', () => {
  const legal: Record<string, string[]> = {
    IDLE: ['BACKING_UP', 'FAILED'],
    BACKING_UP: ['ENCRYPTING', 'IDLE', 'SUCCESS', 'DEGRADED', 'FAILED'],
    ENCRYPTING: ['PUBLISHING', 'FAILED'],
    PUBLISHING: ['SUCCESS', 'DEGRADED', 'FAILED'],
    VERIFYING: ['SUCCESS', 'DEGRADED', 'FAILED', 'BACKING_UP'],
    SUCCESS: ['BACKING_UP', 'VERIFYING', 'FAILED'],
    DEGRADED: ['BACKING_UP', 'VERIFYING', 'RECOVERING', 'FAILED'],
    FAILED: ['RECOVERING', 'BACKING_UP'],
    RECOVERING: ['BACKING_UP', 'FAILED'],
  };
  for (const from of ALL) for (const to of ALL) {
    assert.equal(canTransition(from, to), from === to || legal[from].includes(to), `${from} -> ${to}`);
  }
  // impossible jumps that would mean a bug
  assert.equal(canTransition('IDLE', 'SUCCESS'), false);
  assert.equal(canTransition('ENCRYPTING', 'SUCCESS'), false, 'success without publishing');
  assert.equal(canTransition('PUBLISHING', 'ENCRYPTING'), false);
  assert.equal(canTransition('SUCCESS', 'PUBLISHING'), false);
});

test('a normal publish walks IDLE > BACKING_UP > ENCRYPTING > PUBLISHING > SUCCESS and never breaks the rules', async () => {
  const seen: BackupState[] = [];
  const { pub, svc } = make({ onState: (s: BackupState) => seen.push(s) });
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'publish');
  await waitFor(() => svc.status().state === 'SUCCESS', 3000, 'SUCCESS');
  assert.deepEqual(seen, ['BACKING_UP', 'ENCRYPTING', 'PUBLISHING', 'SUCCESS']);
  assert.equal(svc.status().invalidTransitions, 0);
});

test('when some relays reject the backup the pipeline is DEGRADED, not SUCCESS', async () => {
  const f = fakeLnd();
  const pub = fakePublisher();
  pub.p.publish = async (_r, _sk, payload, ts) => {
    pub.st.calls.push({ payload, ts });
    return { eventId: 'e', ok: ['ws://a/'], failed: [{ url: 'ws://b/', error: 'rejected' }] };
  };
  const svc = new BackupService({ lnd: f.lnd, relays: ['ws://a/', 'ws://b/'], log, publisher: pub.p, refreshMs: 1e9 });
  made.push(svc);
  await svc.start();
  await waitFor(() => svc.status().state === 'DEGRADED', 3000, 'DEGRADED');
  assert.equal(svc.status().lastPublish?.relaysFailed.length, 1);
});

test('total failure goes FAILED > RECOVERING, and a later success returns to SUCCESS through BACKING_UP', async () => {
  const seen: BackupState[] = [];
  const { pub, svc } = make({ fail: 1, onState: (s: BackupState) => seen.push(s) });
  await svc.start();
  await waitFor(() => svc.status().state === 'SUCCESS', 3000, 'recovered');
  assert.deepEqual(seen, ['BACKING_UP', 'ENCRYPTING', 'PUBLISHING', 'FAILED', 'RECOVERING', 'BACKING_UP', 'ENCRYPTING', 'PUBLISHING', 'SUCCESS']);
  assert.equal(pub.st.calls.length, 1);
  assert.equal(svc.status().invalidTransitions, 0);
});

test('an unchanged snapshot returns to the resting state instead of publishing; verification moves SUCCESS <-> VERIFYING', async () => {
  const { f, pub, svc } = make();
  await svc.start();
  await waitFor(() => svc.status().state === 'SUCCESS', 3000, 'SUCCESS');
  f.emit();
  await sleep(50);
  assert.equal(pub.st.calls.length, 1);
  assert.equal(svc.status().state, 'SUCCESS');
  assert.equal(svc.beginVerify(), true);
  assert.equal(svc.status().state, 'VERIFYING');
  assert.equal(svc.beginVerify(), false, 'a second begin while verifying is refused');
  svc.endVerify('degraded');
  assert.equal(svc.status().state, 'DEGRADED');
  svc.endVerify('verified'); // not verifying any more: ignored
  assert.equal(svc.status().state, 'DEGRADED');
  assert.equal(svc.status().invalidTransitions, 0);
});

test('the retry delay carries +/-20% jitter so instances do not retry in lockstep', async () => {
  const delays: number[] = [];
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    const { svc } = make({ fail: 1, retryMs: [1000], random });
    await svc.start();
    await waitFor(() => svc.status().retryPending, 3000, 'retry scheduled');
    delays.push(svc.status().nextRetryMs!);
    svc.stop();
  }
  assert.equal(delays[0], 800);
  assert.equal(delays[1], 1000);
  assert.ok(delays[2] >= 1199 && delays[2] <= 1200, String(delays[2]));
});

test('publish records carry the channel-set fingerprint and how long publishing took; changed channels give a new fingerprint', async () => {
  const { f, pub, svc } = make();
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first');
  f.state.points.push('cc:2');
  f.emit();
  await waitFor(() => pub.st.calls.length === 2, 3000, 'second');
  const [a, b] = svc.status().history;
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(a.durationMs >= 0);
  assert.equal(JSON.parse(pub.st.calls[1].payload).cp, b.fingerprint);
});

test('with every relay disabled the service refuses to publish and says why, instead of pretending', async () => {
  const f = fakeLnd();
  const pub = fakePublisher();
  const svc = new BackupService({ lnd: f.lnd, relays: ['ws://a/'], log, publisher: pub.p, refreshMs: 1e9, retryMs: [1e9] });
  made.push(svc);
  await svc.start();
  await waitFor(() => pub.st.calls.length === 1, 3000, 'first');
  // RelaySet refuses to disable the last relay, so simulate the guard: an empty active list must fail loudly
  (svc.relays as unknown as { list: unknown[] }).list = [];
  await assert.rejects(svc.publishNow(), /no relay is enabled/);
});

test('a start that failed can be retried, and a second start while running is a no-op', async () => {
  const { f, svc } = make();
  let calls = 0;
  const key = f.lnd.sharedKey;
  f.lnd.sharedKey = async (...a: Parameters<typeof key>) => {
    if (calls++ === 0) throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
    return key(...a);
  };
  await assert.rejects(svc.start(), /ECONNREFUSED/);
  assert.equal(svc.status().running, false, 'a failed start leaves the service stopped');
  await svc.start(); // the retry must work
  await svc.start(); // and a start while running does nothing
  assert.equal(f.state.subscribes, 1);
  assert.equal(svc.status().running, true);
});
