import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelSetHash, decodePayload, encodePayload, MAX_PAYLOAD_BYTES } from './payload.js';

const PEER = `02${'ab'.repeat(32)}@10.0.0.1:9735`;

test('round trip', () => {
  const p = { v: 1 as const, scb: 'QUJDRA==', peers: [PEER] };
  assert.deepEqual(decodePayload(encodePayload(p)), p);
});

test('encode refuses payloads over the NIP-44 limit with an explanation', () => {
  assert.throws(() => encodePayload({ v: 1, scb: 'A'.repeat(MAX_PAYLOAD_BYTES), peers: [] }), /NIP-44 limit.*roughly 200 channels/);
});

test('decode rejects garbage, wrong versions, bad base64 and bad peer hints', () => {
  assert.throws(() => decodePayload('not json'), /not valid JSON/);
  assert.throws(() => decodePayload('null'), /version/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 2, scb: 'QUJD', peers: [] })), /version/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 1, scb: '', peers: [] })), /channel backup/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 1, scb: '***', peers: [] })), /channel backup/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 1, scb: 'QUJD', peers: ['nope'] })), /peer hints/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 1, scb: 'QUJD', peers: [`${PEER} `] })), /peer hints/);
  assert.throws(() => decodePayload(JSON.stringify({ v: 1, scb: 'QUJD', peers: 'x' })), /peer hints/);
});

test('the channel-set fingerprint ignores order, changes with the set, and accepts both lnd field spellings', () => {
  const a = { funding_txid_bytes: 'AAA=', output_index: 0 };
  const b = { funding_txid_bytes: 'BBB=', output_index: 1 };
  assert.equal(channelSetHash([a, b]), channelSetHash([b, a]));
  assert.notEqual(channelSetHash([a]), channelSetHash([a, b]));
  assert.notEqual(channelSetHash([a]), channelSetHash([{ ...a, output_index: 1 }]));
  assert.equal(channelSetHash([{ funding_txid_str: 'AAA=', output_index: 0 }]), channelSetHash([a]));
  assert.match(channelSetHash([]), /^[0-9a-f]{64}$/);
});

test('the fingerprint is validated when present and optional when absent', () => {
  const ok = { v: 1, scb: 'QUJD', peers: [] as string[] };
  assert.equal(decodePayload(JSON.stringify(ok)).cp, undefined);
  assert.equal(decodePayload(JSON.stringify({ ...ok, cp: 'a'.repeat(64) })).cp, 'a'.repeat(64));
  assert.throws(() => decodePayload(JSON.stringify({ ...ok, cp: 'zz' })), /fingerprint/);
});

test('chanPointId turns export-style points (base64 little-endian txid) into the "txid:index" lnd prints, and leaves string-style points alone', async () => {
  const { chanPointId } = await import('./payload.js');
  const txid = 'c8c1ee0cfac72f02cd8bdd9e89cc3aed093ce9393c868ae9d1146f0ebdd19c3b';
  const bytes = Buffer.from(txid, 'hex').reverse().toString('base64'); // what lnd's export returns
  assert.equal(chanPointId({ funding_txid_bytes: bytes, output_index: 1 }), `${txid}:1`);
  assert.equal(chanPointId({ funding_txid_str: txid }), `${txid}:0`);
  assert.equal(chanPointId({}), ':0');
});
