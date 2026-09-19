import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { D_TAG, fetchLatestBackup, KIND, pickNewestDecryptable, probeRelay, publishBackup } from './nostr.js';
import { startRelay } from './relay.js';

test('newest backup wins, is encrypted on the relay, and is only found by its owner', async () => {
  const relay = startRelay(7791);
  const pool = new SimplePool();
  const sk = generateSecretKey();
  try {
    assert.equal(await fetchLatestBackup(pool, [relay.url], sk), null);
    await publishBackup(pool, [relay.url], sk, 'BLOB-1', 1000);
    const second = await publishBackup(pool, [relay.url], sk, 'BLOB-2', 1001);
    await publishBackup(pool, [relay.url], sk, 'BLOB-OLD', 999);

    const got = await fetchLatestBackup(pool, [relay.url], sk);
    assert.equal(got?.blob, 'BLOB-2');
    assert.equal(got?.createdAt, 1001);
    assert.equal(got?.id, second.eventId);
    assert.ok(typeof second.encryptMs === 'number' && second.encryptMs >= 0 && second.encryptMs < 1000, 'publish reports how long encryption took');
    assert.equal(relay.stored().length, 1);
    assert.ok(!relay.stored()[0].content.includes('BLOB'), 'content must not be plaintext');
    assert.equal(await fetchLatestBackup(pool, [relay.url], generateSecretKey()), null);
  } finally {
    pool.close([relay.url]);
    await relay.close();
  }
});

test('a hostile relay cannot break restore: foreign events and undecryptable events are skipped, the valid older backup wins', async () => {
  const hostile = startRelay(7792, { ignoreFilters: true }); // answers every REQ with everything, whatever the filter says
  const honest = startRelay(7793);
  const pool = new SimplePool();
  const sk = generateSecretKey();
  const other = generateSecretKey();
  const relays = [hostile.url, honest.url];
  try {
    await publishBackup(pool, [honest.url], sk, 'GOOD', 1000);
    // newer, our own key, valid signature, but not decryptable NIP-44 (a corrupted upload)
    const garbage = finalizeEvent({ kind: KIND, created_at: 2000, tags: [['d', D_TAG]], content: 'not-nip44' }, sk);
    // newer still, someone else's key, same kind and d tag
    const foreign = finalizeEvent({ kind: KIND, created_at: 3000, tags: [['d', D_TAG]], content: 'x' }, other);
    await Promise.all(pool.publish([hostile.url], garbage));
    await Promise.all(pool.publish([hostile.url], foreign));

    const got = await fetchLatestBackup(pool, relays, sk);
    assert.equal(got?.blob, 'GOOD');
    assert.ok(got!.skipped >= 1, 'at least the corrupted upload was skipped (the pool itself may already drop the foreign event)');
  } finally {
    pool.close(relays);
    await hostile.close();
    await honest.close();
  }
});

test('publishing reports per-relay outcomes and only throws when nobody accepted', async () => {
  const relay = startRelay(7794);
  const pool = new SimplePool();
  const sk = generateSecretKey();
  const dead = 'ws://127.0.0.1:1/';
  try {
    const r = await publishBackup(pool, [relay.url, dead], sk, 'X', 1000);
    assert.deepEqual(r.ok, [relay.url]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].url, dead);
    await assert.rejects(publishBackup(pool, [dead], sk, 'X', 1001), /no relay accepted/);
    await assert.rejects(publishBackup(pool, [relay.url], sk, 'A'.repeat(70000), 1002), /NIP-44 limit/);
  } finally {
    pool.close([relay.url, dead]);
    await relay.close();
  }
});

test('probeRelay tells reachable from dead and returns what the relay holds', async () => {
  const relay = startRelay(7795);
  const pool = new SimplePool();
  const sk = generateSecretKey();
  try {
    await publishBackup(pool, [relay.url], sk, 'X', 1000);
    const up = await probeRelay(relay.url, getPublicKey(sk));
    assert.equal(up.reachable, true);
    assert.equal(up.events.length, 1);
    assert.ok(up.latencyMs! >= 0);
    const none = await probeRelay(relay.url, getPublicKey(generateSecretKey()));
    assert.equal(none.reachable, true);
    assert.equal(none.events.length, 0);
    const down = await probeRelay('ws://127.0.0.1:1/', getPublicKey(sk), 1500);
    assert.equal(down.reachable, false);
    assert.ok(down.error);
  } finally {
    pool.close([relay.url]);
    await relay.close();
  }
});

test('our own validation drops foreign, wrongly tagged, tampered and undecryptable events without relying on the pool', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const other = generateSecretKey();
  // events arrive as JSON: round-trip so nostr-tools' in-memory 'already verified' marker does not survive
  const wire = <T>(e: T): T => JSON.parse(JSON.stringify(e));
  const mk = (key: Uint8Array, at: number, content: string, tags = [['d', D_TAG]], kind = KIND) => wire(finalizeEvent({ kind, created_at: at, tags, content }, key));
  const enc = (t: string) => nip44.encrypt(t, nip44.getConversationKey(sk, pk));

  const good = mk(sk, 1000, enc('GOOD'));
  const foreign = mk(other, 5000, 'x');
  const wrongTag = mk(sk, 4000, enc('WRONG-TAG'), [['d', 'something-else']]);
  const wrongKind = mk(sk, 4500, enc('WRONG-KIND'), [['d', D_TAG]], 1);
  const undecryptable = mk(sk, 3000, 'not-nip44');
  const tampered = { ...mk(sk, 6000, enc('TAMPERED')), content: enc('SWAPPED') }; // signature no longer matches

  const got = pickNewestDecryptable([tampered, foreign, wrongKind, wrongTag, undecryptable, good], sk);
  assert.equal(got?.blob, 'GOOD');
  assert.equal(got?.skipped, 5);
  assert.equal(pickNewestDecryptable([foreign, tampered], sk), null);
});

test('selection rules: a future-dated event never shadows a current backup; duplicates collapse; only future-dated candidates are used as a flagged fallback', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const wire = <T>(e: T): T => JSON.parse(JSON.stringify(e));
  const enc = (t: string) => nip44.encrypt(t, nip44.getConversationKey(sk, pk));
  const mk = (at: number, text: string) => wire(finalizeEvent({ kind: KIND, created_at: at, tags: [['d', D_TAG]], content: enc(text) }, sk));
  const NOW = 1_000_000;
  const current = mk(NOW - 100, 'CURRENT');
  const older = mk(NOW - 5000, 'OLDER');
  const farFuture = mk(NOW + 86_400, 'FUTURE');
  const nearFuture = mk(NOW + 300, 'NEAR-FUTURE'); // within the 10 minute clock-skew tolerance

  const a = pickNewestDecryptable([older, farFuture, current, current], sk, NOW);
  assert.equal(a?.blob, 'CURRENT');
  assert.equal(a?.futureDated, false);
  assert.equal(a?.skipped, 0, 'a duplicate of the same event is not a skipped candidate');

  assert.equal(pickNewestDecryptable([current, nearFuture], sk, NOW)?.blob, 'NEAR-FUTURE', 'small clock skew is tolerated');

  const only = pickNewestDecryptable([farFuture], sk, NOW);
  assert.equal(only?.blob, 'FUTURE');
  assert.equal(only?.futureDated, true, 'used only because nothing else exists, and flagged');
  assert.equal(pickNewestDecryptable([], sk, NOW), null);
});

test('stale events lose to newer ones and ties break on the lowest id, as NIP-01 says', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const wire = <T>(e: T): T => JSON.parse(JSON.stringify(e));
  const mk = (at: number, text: string) => wire(finalizeEvent({ kind: KIND, created_at: at, tags: [['d', D_TAG]], content: nip44.encrypt(text, nip44.getConversationKey(sk, pk)) }, sk));
  const NOW = 2_000_000;
  const x = mk(NOW - 10, 'X');
  const y = mk(NOW - 10, 'Y');
  const stale = mk(NOW - 99999, 'STALE');
  const want = x.id < y.id ? 'X' : 'Y';
  assert.equal(pickNewestDecryptable([stale, y, x], sk, NOW)?.blob, want);
});
