import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine, type DrillEvent } from './drill-parse.js';

const metrics = (line: string) =>
  Object.fromEntries(parseLine(line).filter((e): e is Extract<DrillEvent, { type: 'metric' }> => e.type === 'metric').map((e) => [e.key, e.value]));
const stage = (line: string) => parseLine(line).find((e) => e.type === 'stage');

test('every stage header maps to its index, in order', () => {
  const heads = [
    '== fresh regtest cluster',
    '== fund alice and open channel #1 to bob',
    '== start Nostr backup daemon, then open channel #2 (must be picked up automatically)',
    '== DISASTER: delete alice completely (all lnd state, channel.db, macaroons, tls)',
    '== RESTORE: new lnd from the seed alone, then pull backup from Nostr',
    '== peers force-close (data-loss protection); mine until funds return',
  ];
  assert.deepEqual(heads.map((h) => (stage(h) as { index: number }).index), [0, 1, 2, 3, 4, 5]);
  assert.equal(stage('relays: ws://127.0.0.1:7777'), undefined);
});

test('metrics come out of the lines demo.ts really prints', () => {
  assert.deepEqual(metrics('alice: 298492032 sats on-chain + 1493060 sats in 2 channels'), { onchainBefore: 298492032, channelSats: 1493060, channels: 2 });
  assert.deepEqual(metrics('published: 1ch->1relay, 2ch->1relay, 2ch->1relay'), { publishes: 3, publishRelays: 1 });
  const key = '927d10a2901d50c8aeaf284aa7ad1aae840a6563c745217901750b552d2d6b91';
  assert.deepEqual(metrics(`backup identity (Nostr pubkey derived from seed): ${key}`), { nostrKey: key });
  assert.deepEqual(metrics('  block 0: on-chain 298492032 sats'), { onchainNow: 298492032 });
  assert.deepEqual(metrics('recovered 1492866 of 1493060 channel sats on-chain'), { recovered: 1492866, channelSats: 1493060 });
});

test('PASS and FAIL lines set the matching check', () => {
  assert.deepEqual(metrics('PASS  same node identity from seed'), { identityMatch: true });
  assert.deepEqual(metrics('FAIL  same node identity from seed'), { identityMatch: false });
  assert.deepEqual(metrics('PASS  same Nostr backup key re-derived from seed (no extra secret needed)'), { keyMatch: true });
  assert.deepEqual(metrics('PASS  channel funds recovered (only fees lost)'), { fundsPass: true });
  assert.deepEqual(metrics('PASS  backup verified before the disaster: lnd itself decrypted the relay copy and found 2 channel(s) in it'), { verifyPass: true });
  assert.deepEqual(metrics('FAIL  backup verified before the disaster: lnd itself decrypted the relay copy and found undefined channel(s) in it'), { verifyPass: false });
  assert.deepEqual(metrics('PASS  the restored backup has the channel-set fingerprint that was published'), { fingerprintMatch: true });
  assert.deepEqual(parseLine('FAIL  channel funds recovered (only fees lost)')[0], { type: 'line', text: 'FAIL  channel funds recovered (only fees lost)', kind: 'fail' });
});

test('the fingerprint and the drill\'s measured metrics become events; unknown or non-numeric keys are ignored', () => {
  const fp = 'ab'.repeat(32);
  assert.deepEqual(metrics(`backup fingerprint (channel set): ${fp}`), { fingerprint: fp });
  const m = metrics('metrics: {"backupBytes":1811,"publishMs":42,"discoverMs":30,"importMs":15,"recoveryMs":9000,"totalMs":38000,"relaysOk":2,"relaysFailed":0,"feesSats":194,"exportMs":12,"encryptMs":0.8,"verifyMs":40,"redialMs":3000,"relaysHealthy":2,"relaysAtRestore":1,"evil":1,"publishMs2":"x"}');
  assert.deepEqual(m, { backupBytes: 1811, publishMs: 42, discoverMs: 30, importMs: 15, recoveryMs: 9000, totalMs: 38000, relaysOk: 2, relaysFailed: 0, feesSats: 194, exportMs: 12, encryptMs: 0.8, verifyMs: 40, redialMs: 3000, relaysHealthy: 2, relaysAtRestore: 1 });
  assert.deepEqual(metrics('metrics: {"totalMs":"not a number","importMs":null}'), {});
  assert.doesNotThrow(() => parseLine('metrics: {broken'));
  assert.deepEqual(metrics('metrics: {broken'), {});
});
