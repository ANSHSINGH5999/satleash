// Relays are hostile or broken infrastructure. Whatever they send, the client decides what is true, locally.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyBackup } from './backup.js';
import { D_TAG, fetchLatestBackup, isOwnValid, KIND, probeRelay, publishBackup } from './nostr.js';
import { decodePayload, encodePayload } from './payload.js';
import { startRelay } from './relay.js';
import { fakeLnd } from './testutil.js';

const usable = (blob: string) => void decodePayload(blob);
const now = () => Math.floor(Date.now() / 1000);
const good = (scb = 'QUJDRA==') => encodePayload({ v: 1, scb, peers: [], cp: 'ab'.repeat(32) });
const selfKey = (sk: Uint8Array) => nip44.getConversationKey(sk, getPublicKey(sk));
const sign = (sk: Uint8Array, plaintext: string, createdAt: number, over: { kind?: number; d?: string } = {}) =>
  finalizeEvent({ kind: over.kind ?? KIND, created_at: createdAt, tags: [['d', over.d ?? D_TAG]], content: nip44.encrypt(plaintext, selfKey(sk)) }, sk);

/** A relay that answers every REQ with exactly the frames the test scripts, then EOSE unless told not to. */
function scripted(port: number, frames: (sub: string) => unknown[], o: { eose?: boolean; dropAfter?: boolean } = {}) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1', maxPayload: 64 * 1024 * 1024 });
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      let m: unknown[];
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m[0] !== 'REQ') return;
      const sub = String(m[1]);
      for (const f of frames(sub)) ws.send(typeof f === 'string' ? f : JSON.stringify(f));
      if (o.eose !== false) ws.send(JSON.stringify(['EOSE', sub]));
      if (o.dropAfter) ws.terminate();
    });
  });
  return { url: `ws://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
}

test('a relay that speaks garbage cannot crash or stall the client', async () => {
  const sk = generateSecretKey();
  const honest = startRelay(7851);
  const junk = scripted(7852, (sub) => [
    'not json at all',
    '{}',
    'null',
    '42',
    [],
    ['EVENT'],
    ['EVENT', sub],
    ['EVENT', sub, null],
    ['EVENT', sub, 'a string'],
    ['EVENT', sub, { id: 1 }],
    ['EVENT', sub, { id: 'x'.repeat(64), pubkey: getPublicKey(sk), kind: KIND, created_at: 'now', tags: 'no', content: 5, sig: {} }],
    ['NOTICE', { deep: [[[[[[]]]]]] }],
    ['AUTH', 'challenge'],
    ['SOMETHING-NEW', 1, 2, 3],
  ]);
  const pool = new SimplePool();
  try {
    await publishBackup(pool, [honest.url], sk, good('QUJD'), 1000);
    const t = Date.now();
    const got = await fetchLatestBackup(pool, [junk.url, honest.url], sk, 4000, usable);
    assert.equal(decodePayload(got!.blob).scb, 'QUJD', 'the honest relay still provides the backup');
    assert.equal(await fetchLatestBackup(pool, [junk.url], generateSecretKey(), 4000, usable), null, 'garbage alone yields nothing, not an exception');
    assert.ok(Date.now() - t < 6000, 'garbage does not stall the client');
    const probe = await probeRelay(junk.url, getPublicKey(sk), 3000);
    assert.equal(probe.reachable, true);
    assert.deepEqual(probe.events.filter((e) => isOwnValid(e, getPublicKey(sk))), [], 'no junk event passes local validation');
    // the whole verification, not just the probe, survives a relay like this and still uses the honest one
    const v = await verifyBackup({ lnd: fakeLnd().lnd, sk, relays: [junk.url, honest.url] });
    assert.deepEqual(v.relays.map((r) => r.state), ['missing', 'healthy']);
  } finally {
    pool.close([junk.url, honest.url]);
    await honest.close();
    await junk.close();
  }
});

test('a relay that refuses the query (auth-required) is reported as unusable with its reason', async () => {
  const gate = scripted(7863, (sub) => [['CLOSED', sub, 'auth-required: this relay wants you to log in']], { eose: false });
  try {
    const p = await probeRelay(gate.url, getPublicKey(generateSecretKey()), 3000);
    assert.equal(p.reachable, false);
    assert.match(p.error ?? '', /auth-required/);
  } finally {
    await gate.close();
  }
});

test('events of every wrong kind never become the backup: wrong kind, author, tag, signature, duplicates, stale, future, huge, extra fields', async () => {
  const sk = generateSecretKey();
  const other = generateSecretKey();
  const t = now();
  const valid = sign(sk, good('VkFMSUQ='), t - 100); // the real, current backup
  const stale = sign(sk, good('U1RBTEU='), t - 5000);
  const future = sign(sk, good('RlVUVVJF'), t + 3 * 86400);
  const wrongKind = sign(sk, good('S0lORA=='), t, { kind: 1 });
  const wrongTag = sign(sk, good('VEFH'), t, { d: 'someone-elses-app' });
  const foreign = sign(other, good('QVVUSE9S'), t);
  const forged: Event = { ...sign(sk, good('U0lH'), t - 1), content: sign(sk, good('U0lH'), t - 1).content.slice(0, -2) + 'AA' }; // tampered after signing
  const huge = sign(sk, 'x'.repeat(60000), t - 2);
  const hugeRaw: Event = { ...valid, id: 'f'.repeat(64), content: 'A'.repeat(3_000_000) }; // 3 MB, bad id and signature
  const extra = { ...sign(sk, good('RVhUUkE='), t - 50), surprise: { nested: true }, tags: [['d', D_TAG], ['unexpected', 'tag']] };
  const relay = scripted(7853, (sub) => [valid, valid, stale, future, wrongKind, wrongTag, foreign, forged, huge, hugeRaw, extra].map((e) => ['EVENT', sub, e]));
  const pool = new SimplePool();
  try {
    const got = await fetchLatestBackup(pool, [relay.url], sk, 5000, usable);
    // `extra` has different tags than what was signed, so its id no longer matches: it must be dropped too
    assert.equal(decodePayload(got!.blob).scb, 'VkFMSUQ=', 'only the valid, current, own backup is used');
    assert.equal(got!.createdAt, valid.created_at);
    assert.equal(got!.futureDated, false);
  } finally {
    pool.close([relay.url]);
    await relay.close();
  }
});

test('the newest own event decrypts but its payload is unusable: the older valid backup is used, and verify says so', async () => {
  const sk = generateSecretKey();
  const a = startRelay(7854);
  const b = startRelay(7855);
  const pool = new SimplePool();
  try {
    await publishBackup(pool, [b.url], sk, good('T0xERVI='), 1000);
    for (const [i, bad] of ['{"v":2,"scb":"QUJD","peers":[]}', '[]', '"a string"', '{"v":1,"scb":"not base64!!","peers":[]}', 'not json'].entries()) {
      await publishBackup(pool, [a.url], sk, bad, 2000 + i); // a relay only keeps the newest; this is the newest of the run
      const got = await fetchLatestBackup(pool, [a.url, b.url], sk, 5000, usable);
      assert.equal(decodePayload(got!.blob).scb, 'T0xERVI=', `payload ${bad.slice(0, 20)} must not shadow the older valid backup`);
      assert.equal(got!.skipped, 1);
    }
    const f = fakeLnd();
    const v = await verifyBackup({ lnd: f.lnd, sk, relays: [a.url, b.url] });
    assert.equal(v.createdAt, 1000, 'verification also picks the older, usable backup');
    assert.ok(v.problems.some((p) => /newer backup event.*unreadable/i.test(p)), `problems: ${v.problems.join(' | ')}`);
    assert.equal(v.ok, false);
  } finally {
    pool.close([a.url, b.url]);
    await a.close();
    await b.close();
  }
});

test('multiple relays down: the backup is still found, and verification is degraded rather than verified', async () => {
  const sk = generateSecretKey();
  const alive = startRelay(7856);
  const pool = new SimplePool();
  const dead = ['ws://127.0.0.1:7857/', 'ws://127.0.0.1:7858/'];
  try {
    const f = fakeLnd();
    const snap = await f.lnd.exportBackup();
    const { channelSetHash } = await import('./payload.js');
    await publishBackup(pool, [alive.url], sk, encodePayload({ v: 1, scb: snap.multi_chan_backup!.multi_chan_backup, peers: [], cp: channelSetHash(snap.multi_chan_backup!.chan_points) }), now());
    const t0 = Date.now();
    const got = await fetchLatestBackup(pool, [...dead, alive.url], sk, 5000, usable);
    assert.ok(got, 'one surviving relay is enough');
    const v = await verifyBackup({ lnd: f.lnd, sk, relays: [...dead, alive.url] });
    assert.equal(v.ok, true);
    assert.equal(v.verdict, 'degraded', 'reduced redundancy is not a clean verification');
    assert.ok(v.problems.some((p) => /2 relay\(s\) unreachable/.test(p)), v.problems.join(' | '));
    assert.deepEqual(v.relays.map((r) => r.state), ['down', 'down', 'healthy']);
    assert.ok(Date.now() - t0 < 8000);
  } finally {
    pool.close([...dead, alive.url]);
    await alive.close();
  }
});

test('all relays down: restore lookup and verification fail promptly and clearly, without throwing', async () => {
  const sk = generateSecretKey();
  const dead = ['ws://127.0.0.1:7859/', 'ws://127.0.0.1:7860/'];
  const pool = new SimplePool();
  try {
    const t0 = Date.now();
    assert.equal(await fetchLatestBackup(pool, dead, sk, 5000, usable), null);
    const v = await verifyBackup({ lnd: fakeLnd().lnd, sk, relays: dead });
    assert.equal(v.ok, false);
    assert.equal(v.verdict, 'failed');
    assert.ok(v.problems.includes('no relay is reachable'));
    assert.ok(Date.now() - t0 < 8000, 'no hang');
  } finally {
    pool.close(dead);
  }
});

test('a relay that drops the connection mid-answer does not hang the client, and a relay that comes back is used', async () => {
  const sk = generateSecretKey();
  const flaky = scripted(7861, (sub) => [['EVENT', sub, sign(sk, good('RkxBS1k='), now() - 10)]], { eose: false, dropAfter: true });
  const pool = new SimplePool();
  try {
    const t0 = Date.now();
    await fetchLatestBackup(pool, [flaky.url], sk, 4000, usable); // may or may not keep the event; it must return
    assert.ok(Date.now() - t0 < 6000, 'a dropped connection ends the query');
  } finally {
    pool.close([flaky.url]);
    await flaky.close();
  }
  // reconnect: the same address is dead, then alive
  const url = 'ws://127.0.0.1:7862/';
  assert.equal(await fetchLatestBackup(pool, [url], sk, 3000, usable), null);
  const back = startRelay(7862);
  try {
    await publishBackup(pool, [url], sk, good('QkFDSw=='), now());
    const got = await fetchLatestBackup(pool, [url], sk, 5000, usable);
    assert.equal(decodePayload(got!.blob).scb, 'QkFDSw==', 'after the relay returns, the same client library finds the backup');
  } finally {
    pool.close([url]);
    await back.close();
  }
});
