import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { D_TAG } from './nostr.js';
import { publicRelayTest } from './relay-test.js';
import { startRelay } from './relay.js';

test('a full test run publishes an encrypted dummy event, reads it back, verifies it, and cleans up after itself', async () => {
  const relay = startRelay(7811);
  try {
    const r = await publicRelayTest(relay.url);
    assert.deepEqual(r.errors, []);
    assert.equal(r.published && r.retrieved && r.signatureValid && r.decrypted && r.payloadValid && r.fingerprintValid, true, 'every validation step ran and passed');
    assert.equal(r.deletionRequested, true);
    assert.equal(r.deletionHonored, true);
    assert.equal(relay.stored().length, 0, 'nothing is left on the relay');
    assert.ok(r.namespace.startsWith('lifeboat/relay-test/') && r.namespace !== D_TAG, 'isolated from the real backup namespace');
  } finally {
    await relay.close();
  }
});

test('every run uses a fresh throwaway identity and namespace, so it can never touch a real backup', async () => {
  const relay = startRelay(7812);
  try {
    const [a, b] = [await publicRelayTest(relay.url), await publicRelayTest(relay.url)];
    assert.notEqual(a.throwawayPubkey, b.throwawayPubkey);
    assert.notEqual(a.namespace, b.namespace);
    assert.notEqual(a.eventId, b.eventId);
  } finally {
    await relay.close();
  }
});

test('a relay that ignores NIP-09 is reported honestly: deletion requested, not honored', async () => {
  const relay = startRelay(7813, { honorDeletions: false });
  try {
    const r = await publicRelayTest(relay.url);
    assert.equal(r.deletionRequested, true);
    assert.equal(r.deletionHonored, false);
    assert.equal(r.published && r.retrieved, true);
    assert.equal(relay.stored().length, 1, 'the dummy event stays on such a relay; it is encrypted dummy data');
  } finally {
    await relay.close();
  }
});

test('an unreachable relay yields a result with the reason, not an exception', async () => {
  const r = await publicRelayTest('ws://127.0.0.1:1/', { timeoutMs: 1500 });
  assert.equal(r.published, false);
  assert.equal(r.retrieved, false);
  assert.ok(r.errors.some((e) => e.startsWith('publish:')));
});

test('a relay that accepts the event but never serves it is reported as a retrieval failure', async () => {
  const wss = new WebSocketServer({ port: 7814, host: '127.0.0.1' });
  wss.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m[0] === 'EVENT') ws.send(JSON.stringify(['OK', m[1].id, true, '']));
      if (m[0] === 'REQ') ws.send(JSON.stringify(['EOSE', m[1]]));
    }),
  );
  try {
    const r = await publicRelayTest('ws://127.0.0.1:7814/', { timeoutMs: 3000 });
    assert.equal(r.published, true);
    assert.equal(r.retrieved, false);
    assert.equal(r.signatureValid, false);
    assert.ok(r.errors.some((e) => e.startsWith('retrieve:')));
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((res) => wss.close(res));
  }
});
