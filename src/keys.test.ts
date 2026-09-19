import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { deriveNostrKey, numsPoint } from './keys.js';

test('the NUMS point is a valid compressed curve point and stable', () => {
  const p = numsPoint();
  assert.equal(p.length, 33);
  secp256k1.Point.fromBytes(p); // throws if not on the curve
  assert.deepEqual(numsPoint(), p);
});

test('the Nostr key is deterministic in the lnd shared secret and differs when it differs', async () => {
  const a = { sharedKey: async () => new Uint8Array(32).fill(1) };
  const b = { sharedKey: async () => new Uint8Array(32).fill(2) };
  const k1 = await deriveNostrKey(a);
  assert.equal(k1.length, 32);
  assert.deepEqual(await deriveNostrKey(a), k1);
  assert.notDeepEqual(await deriveNostrKey(b), k1);
});
