import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackupStatus, RelayHealth, VerifyResult } from './backup.js';
import { assess, type SecurityInput } from './security.js';

const NOW = 1_000_000_000_000;
const status = (o: Partial<BackupStatus> = {}): BackupStatus => ({
  running: true, state: 'SUCCESS', streamConnected: true, publishes: 1, failures: 0, retryPending: false, invalidTransitions: 0, history: [],
  lastPublish: { at: NOW - 60_000, channels: 2, bytes: 500, eventId: 'e', fingerprint: 'f', durationMs: 12, relaysOk: ['a', 'b'], relaysFailed: [] }, ...o,
});
const relay = (o: Partial<RelayHealth> = {}): RelayHealth => ({ url: 'wss://a/', reachable: true, hasBackup: true, hasLatest: true, state: 'healthy', foreignEvents: 0, ...o });
const verify = (o: Partial<VerifyResult> = {}): VerifyResult => ({
  ok: true, verdict: 'verified', checkedAt: NOW, matchesCurrent: true, channelsCurrent: 2, problems: [], relays: [relay(), relay({ url: 'wss://b/' })], ...o,
});
const base = (o: Partial<SecurityInput> = {}): SecurityInput => ({
  relays: ['wss://a/', 'wss://b/'], status: status(), verify: verify(), canSpend: false, network: 'regtest', channels: 2, staleAfterSec: 3600, now: NOW, lndConnected: true, ...o,
});
const byId = (r: ReturnType<typeof assess>, id: string) => r.checks.find((c) => c.id === id)!;

test('a healthy setup passes every check', () => {
  const r = assess(base());
  assert.equal(r.worst, 'pass');
  assert.ok(r.checks.every((c) => c.status === 'pass'), JSON.stringify(r.checks.filter((c) => c.status !== 'pass')));
});

test('an over-privileged macaroon fails with a fix; a macaroon lnd would not describe is unknown; loose file modes warn', () => {
  assert.equal(byId(assess(base({ canSpend: true })), 'macaroon').status, 'fail');
  assert.match(byId(assess(base({ canSpend: true })), 'macaroon').fix!, /bake/);
  assert.equal(assess(base({ canSpend: true })).worst, 'fail');
  assert.equal(byId(assess(base({ canSpend: undefined })), 'macaroon').status, 'unknown');
  assert.equal(byId(assess(base({ macaroonFileLoose: true })), 'macaroon-file').status, 'warn');
  assert.equal(byId(assess(base({ macaroonFileLoose: false })), 'macaroon-file').status, 'pass');
  assert.equal(assess(base()).checks.some((c) => c.id === 'macaroon-file'), false, 'not reported when it was not checked');
});

test('relay redundancy: one in use warns, none reachable fails, one reachable is degraded, not probed is unknown', () => {
  assert.equal(byId(assess(base({ relays: ['wss://a/'] })), 'relays').status, 'warn');
  const down = verify({ ok: false, verdict: 'failed', relays: [relay({ reachable: false, state: 'down' }), relay({ reachable: false, state: 'down' })] });
  assert.equal(byId(assess(base({ verify: down })), 'relays').status, 'fail');
  const one = verify({ relays: [relay(), relay({ reachable: false, state: 'down' })] });
  assert.equal(byId(assess(base({ verify: one })), 'relays').status, 'degraded');
  assert.equal(byId(assess(base({ verify: undefined })), 'relays').status, 'unknown');
});

test('cleartext remote relays are flagged, loopback is not', () => {
  assert.equal(byId(assess(base({ relays: ['ws://relay.example/', 'wss://b/'] })), 'transport').status, 'warn');
  assert.equal(byId(assess(base({ relays: ['ws://127.0.0.1:7777/', 'wss://b/'] })), 'transport').status, 'pass');
});

test('pipeline state maps to facts: FAILED fails, RECOVERING and DEGRADED degrade, IDLE is unknown, invalid transitions fail', () => {
  assert.equal(byId(assess(base({ status: status({ state: 'FAILED', lastError: { at: NOW, message: 'relays down' } }) })), 'state').status, 'fail');
  assert.equal(byId(assess(base({ status: status({ state: 'RECOVERING', retryPending: true, nextRetryMs: 5000 }) })), 'state').status, 'degraded');
  assert.equal(byId(assess(base({ status: status({ state: 'DEGRADED' }) })), 'state').status, 'degraded');
  assert.equal(byId(assess(base({ status: status({ state: 'IDLE' }) })), 'state').status, 'unknown');
  assert.equal(byId(assess(base({ status: status({ invalidTransitions: 2 }) })), 'state').status, 'fail');
});

test('publish state: never published with channels fails, stale warns, errors degrade while a retry is pending, dropped stream degrades', () => {
  assert.equal(byId(assess(base({ status: status({ lastPublish: undefined }) })), 'published').status, 'fail');
  assert.equal(byId(assess(base({ status: status({ lastPublish: undefined }), channels: 0 })), 'published').status, 'unknown');
  const old = status({ lastPublish: { at: NOW - 5 * 3600_000, channels: 2, bytes: 1, eventId: 'e', fingerprint: 'f', durationMs: 1, relaysOk: ['a'], relaysFailed: [] } });
  assert.equal(byId(assess(base({ status: old })), 'published').status, 'warn');
  assert.equal(byId(assess(base({ status: status({ lastError: { at: NOW, message: 'x' }, retryPending: true }) })), 'errors').status, 'degraded');
  assert.equal(byId(assess(base({ status: status({ lastError: { at: NOW, message: 'x' }, retryPending: false }) })), 'errors').status, 'warn');
  assert.equal(byId(assess(base({ status: status({ streamConnected: false }) })), 'stream').status, 'degraded');
});

test('verification verdicts: verified passes, degraded degrades, behind the node warns, unreadable fails, not yet run is unknown', () => {
  assert.equal(byId(assess(base({ verify: verify({ verdict: 'degraded', problems: ['1 relay stale'] }) })), 'verified').status, 'degraded');
  assert.equal(byId(assess(base({ verify: verify({ ok: false, verdict: 'failed', matchesCurrent: false, problems: ['behind'] }) })), 'verified').status, 'warn');
  assert.equal(byId(assess(base({ verify: verify({ ok: false, verdict: 'failed', matchesCurrent: undefined, problems: ['no decryptable backup'] }) })), 'verified').status, 'fail');
  assert.equal(byId(assess(base({ verify: undefined })), 'verified').status, 'unknown');
});

test('relays returning events that are not valid backups are reported as suspicious, without claiming malice', () => {
  const r = assess(base({ verify: verify({ relays: [relay({ foreignEvents: 3 }), relay({ url: 'wss://b/' })] }) }));
  assert.equal(byId(r, 'relay-integrity').status, 'warn');
  assert.match(byId(r, 'relay-integrity').detail, /not proof of malice/);
  assert.equal(byId(assess(base()), 'relay-integrity').status, 'pass');
});

test('networks: regtest and testnet pass with a label, mainnet warns loudly, unknown is unknown; lnd down fails', () => {
  assert.equal(byId(assess(base()), 'network').title, 'REGTEST');
  assert.equal(byId(assess(base({ network: 'testnet' })), 'network').status, 'pass');
  const main = byId(assess(base({ network: 'mainnet' })), 'network');
  assert.equal(main.status, 'warn');
  assert.equal(main.title, 'MAINNET');
  assert.match(main.detail, /only been tested on regtest/);
  assert.equal(byId(assess(base({ network: undefined })), 'network').status, 'unknown');
  assert.equal(byId(assess(base({ lndConnected: false })), 'lnd').status, 'fail');
  assert.equal(byId(assess(base({ lndConnected: undefined })), 'lnd').status, 'unknown');
});

test('the worst status wins, and unknown never hides a real problem', () => {
  assert.equal(assess(base({ status: status({ lastPublish: undefined }), channels: 0 })).worst, 'unknown');
  assert.equal(assess(base({ relays: ['wss://a/'], verify: undefined })).worst, 'warn');
});
