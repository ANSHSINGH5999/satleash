import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey } from 'nostr-tools/pure';
import { BackupService, nostrPublisher, verifyBackup } from './backup.js';
import { Logger } from './log.js';
import { D_TAG, KIND, publishBackup } from './nostr.js';
import { encodePayload } from './payload.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { startRelay } from './relay.js';
import { fakeLnd, waitFor } from './testutil.js';

const log = new Logger({ level: 'error', write: () => {} });

test('verify passes when every relay holds the backup that matches the node', async () => {
  const a = startRelay(7801);
  const b = startRelay(7802);
  const f = fakeLnd();
  const svc = new BackupService({ lnd: f.lnd, relays: [a.url, b.url], log, publisher: nostrPublisher(), refreshMs: 1e9 });
  try {
    await svc.start();
    await waitFor(() => svc.status().publishes >= 1, 5000, 'publish');
    const v = await verifyBackup({ lnd: f.lnd, sk: svc.secretKey(), relays: [a.url, b.url] });
    assert.equal(v.ok, true, v.problems.join('; '));
    assert.equal(v.matchesCurrent, true, 'lnd re-encrypts on every export; matching must be by channel set');
    assert.equal(v.channelsCurrent, 2);
    assert.deepEqual(v.relays.map((r) => [r.reachable, r.hasLatest]), [[true, true], [true, true]]);
    assert.deepEqual(v.problems, []);
  } finally {
    svc.stop();
    await a.close();
    await b.close();
  }
});

test('verify flags a backup that is behind the node and a relay that is down, without failing on the healthy relay', async () => {
  const a = startRelay(7803);
  const f = fakeLnd();
  const svc = new BackupService({ lnd: f.lnd, relays: [a.url], log, publisher: nostrPublisher(), refreshMs: 1e9 });
  try {
    await svc.start();
    await waitFor(() => svc.status().publishes >= 1, 5000, 'publish');
    f.state.points.push('cc:2'); // the node opened a channel; nothing published yet
    const v = await verifyBackup({ lnd: f.lnd, sk: svc.secretKey(), relays: [a.url, 'ws://127.0.0.1:1/'], timeoutMs: 1500 });
    assert.equal(v.ok, false);
    assert.equal(v.matchesCurrent, false);
    assert.ok(v.problems.some((p) => /behind/.test(p)));
    assert.equal(v.relays[1].reachable, false);
    assert.equal(v.relays[0].reachable, true);
  } finally {
    svc.stop();
    await a.close();
  }
});

test('a backup for another seed is never accepted, and hostile events do not confuse verification', async () => {
  const hostile = startRelay(7804, { ignoreFilters: true });
  const pool = new SimplePool();
  const f = fakeLnd();
  try {
    await publishBackup(pool, [hostile.url], generateSecretKey(), 'someone-elses', 5000);
    const v = await verifyBackup({ lnd: f.lnd, sk: generateSecretKey(), relays: [hostile.url] });
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /no decryptable backup/.test(p)));
    assert.equal(v.relays[0].hasBackup, false);
  } finally {
    pool.close([hostile.url]);
    await hostile.close();
  }
});

test('verdicts and relay states: healthy relays verify, a relay with an older copy is stale, an empty one missing, a dead one down, foreign events are counted', async () => {
  const a = startRelay(7805);
  const b = startRelay(7806);
  const c = startRelay(7807, { ignoreFilters: true });
  const f = fakeLnd();
  const pool = new SimplePool();
  const svc = new BackupService({ lnd: f.lnd, relays: [a.url], log, publisher: nostrPublisher(), refreshMs: 1e9 });
  try {
    await svc.start();
    await waitFor(() => svc.status().publishes >= 1, 5000, 'publish to relay a');
    const sk = svc.secretKey();
    const pk = getPublicKey(sk);
    // relay c also holds an event from somebody else, and an OLDER copy of our own backup
    await publishBackup(pool, [c.url], generateSecretKey(), 'not-ours', Math.floor(Date.now() / 1000) + 1);
    const older = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000) - 3600, tags: [['d', D_TAG]], content: 'old-and-unreadable-here' }, sk);
    await Promise.all(pool.publish([c.url], older));

    const v = await verifyBackup({ lnd: f.lnd, sk, relays: [a.url, b.url, c.url, 'ws://127.0.0.1:1/'], timeoutMs: 1500 });
    const by = Object.fromEntries(v.relays.map((r) => [r.url, r]));
    assert.equal(by[a.url].state, 'healthy');
    assert.equal(by[b.url].state, 'missing');
    assert.equal(by[c.url].state, 'stale');
    assert.equal(by['ws://127.0.0.1:1/'].state, 'down');
    assert.equal(by[c.url].foreignEvents, 1, 'the other author\'s event on relay c is counted, not trusted');
    assert.equal(v.ok, true);
    assert.equal(v.verdict, 'degraded', 'proven, but with caveats');
    assert.match(v.fingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.ok(v.problems.some((p) => /hold no backup/.test(p)) && v.problems.some((p) => /older backup/.test(p)) && v.problems.some((p) => /not valid backups/.test(p)));

    const clean = await verifyBackup({ lnd: f.lnd, sk, relays: [a.url] });
    assert.equal(clean.verdict, 'verified');
    assert.deepEqual(clean.problems, []);
    void pk;
  } finally {
    svc.stop();
    pool.close([c.url]);
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

test('a future-dated backup is flagged in the verdict and does not hide the current one', async () => {
  const a = startRelay(7808);
  const b = startRelay(7809);
  const f = fakeLnd();
  const pool = new SimplePool();
  const svc = new BackupService({ lnd: f.lnd, relays: [a.url], log, publisher: nostrPublisher(), refreshMs: 1e9 });
  try {
    await svc.start();
    await waitFor(() => svc.status().publishes >= 1, 5000, 'publish');
    const sk = svc.secretKey();
    // a valid, decryptable but far-future event on relay b (e.g. left by a writer with a wrong clock)
    await publishBackup(pool, [b.url], sk, JSON.stringify({ v: 1, scb: 'QUJD', peers: [] }), Math.floor(Date.now() / 1000) + 86_400);
    const v = await verifyBackup({ lnd: f.lnd, sk, relays: [a.url, b.url] });
    assert.equal(v.ok, true, 'the current backup on relay a is still the one that counts');
    assert.equal(v.futureDated, false);
    assert.equal(v.relays.find((r) => r.url === b.url)!.state, 'stale');
  } finally {
    svc.stop();
    pool.close([b.url]);
    await a.close();
    await b.close();
  }
});

test('verification asks lnd itself: it decrypts the relay copy, lists its channels, and that list decides whether it matches the node', async () => {
  const a = startRelay(7871);
  const f = fakeLnd();
  const svc = new BackupService({ lnd: f.lnd, relays: [a.url], log, publisher: nostrPublisher(), refreshMs: 1e9 });
  try {
    await svc.start();
    await waitFor(() => svc.status().publishes >= 1, 5000, 'publish');
    const v = await verifyBackup({ lnd: f.lnd, sk: svc.secretKey(), relays: [a.url] });
    assert.equal(v.lndValidated, true);
    assert.equal(v.channelsInBackup, 2);
    assert.equal(v.matchesCurrent, true);
    f.state.points.push('cc:2'); // the node opens a channel the relay copy does not know about
    const behind = await verifyBackup({ lnd: f.lnd, sk: svc.secretKey(), relays: [a.url] });
    assert.equal(behind.lndValidated, true, 'the old copy is still a valid backup');
    assert.equal(behind.matchesCurrent, false);
    assert.equal(behind.ok, false);
    assert.ok(behind.problems.some((p) => /behind the node/.test(p)));
  } finally {
    svc.stop();
    await a.close();
  }
});

test('a relay copy that lnd cannot decrypt (corrupted, or made by another seed) is rejected by lnd and reported with its reason', async () => {
  const a = startRelay(7872);
  const f = fakeLnd();
  const sk = generateSecretKey();
  const pool = new SimplePool();
  try {
    const foreignBlob = Buffer.from('some other node\'s encrypted backup').toString('base64');
    await publishBackup(pool, [a.url], sk, encodePayload({ v: 1, scb: foreignBlob, peers: [], cp: 'ab'.repeat(32) }), Math.floor(Date.now() / 1000));
    const v = await verifyBackup({ lnd: f.lnd, sk, relays: [a.url] });
    assert.equal(v.lndValidated, false);
    assert.equal(v.ok, false);
    assert.equal(v.verdict, 'failed');
    assert.ok(v.problems.some((p) => /lnd rejected the backup.*message authentication failed/.test(p)), v.problems.join(' | '));
  } finally {
    pool.close([a.url]);
    await a.close();
  }
});
