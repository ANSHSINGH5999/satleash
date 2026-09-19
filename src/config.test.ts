import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNetworkAllowed, intFromEnv, isCleartextRemote, isLoopbackUrl, isLooseMode, loadLndOpts, normalizeNetwork, parseRelays, validateConfig } from './config.js';

test('parseRelays accepts ws/wss, trims, dedupes', () => {
  assert.deepEqual(parseRelays(' wss://a.example , wss://a.example,ws://127.0.0.1:7777 '), ['wss://a.example/', 'ws://127.0.0.1:7777/']);
});

test('parseRelays rejects empty, non-websocket, credentialed and malformed URLs', () => {
  assert.throws(() => parseRelays(''), /RELAYS is empty/);
  assert.throws(() => parseRelays(undefined), /RELAYS is empty/);
  assert.throws(() => parseRelays('https://a.example'), /ws:\/\/ or wss:\/\//);
  assert.throws(() => parseRelays('wss://user:pw@a.example'), /credentials/);
  assert.throws(() => parseRelays('not a url'), /invalid relay URL/);
  assert.throws(() => parseRelays(Array.from({ length: 11 }, (_, i) => `wss://r${i}.example`).join(',')), /at most 10/);
});

test('cleartext detection ignores loopback and wss', () => {
  assert.equal(isCleartextRemote('ws://relay.example/'), true);
  assert.equal(isCleartextRemote('ws://127.0.0.1:7777/'), false);
  assert.equal(isCleartextRemote('ws://localhost:7777/'), false);
  assert.equal(isCleartextRemote('wss://relay.example/'), false);
});

test('env parsing validates ranges and required paths', () => {
  assert.equal(intFromEnv({}, 'X', 5, 1, 10), 5);
  assert.equal(intFromEnv({ X: '7' }, 'X', 5, 1, 10), 7);
  assert.throws(() => intFromEnv({ X: '0' }, 'X', 5, 1, 10), /between 1 and 10/);
  assert.throws(() => intFromEnv({ X: '1.5' }, 'X', 5, 1, 10), /integer/);
  assert.throws(() => loadLndOpts({}), /LND_CERT/);
  assert.throws(() => loadLndOpts({ LND_CERT: 'c' }), /LND_MACAROON/);
  assert.deepEqual(loadLndOpts({ LND_CERT: 'c', LND_MACAROON: 'm', LND_PORT: '10080' }), { certPath: 'c', macaroonPath: 'm', host: undefined, port: 10080 });
});

test('a group- or world-readable credential file is flagged, a private one and a missing one are not', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'lifeboat-mode-')), 'm.macaroon');
  writeFileSync(f, 'x');
  chmodSync(f, 0o600);
  assert.equal(isLooseMode(f), false);
  chmodSync(f, 0o644);
  assert.equal(isLooseMode(f), process.platform !== 'win32');
  assert.equal(isLooseMode(join(tmpdir(), 'lifeboat-does-not-exist')), false);
});

test('mainnet is refused unless explicitly allowed; other networks pass', () => {
  assert.throws(() => assertNetworkAllowed('mainnet', {}), /MAINNET.*only been tested on regtest/);
  assert.throws(() => assertNetworkAllowed('mainnet', { LIFEBOAT_ALLOW_MAINNET: '0' }), /MAINNET/);
  assert.doesNotThrow(() => assertNetworkAllowed('mainnet', { LIFEBOAT_ALLOW_MAINNET: '1' }));
  for (const n of ['regtest', 'testnet', 'testnet4', 'signet', 'unknown'] as const) assert.doesNotThrow(() => assertNetworkAllowed(n, {}));
  assert.equal(normalizeNetwork('testnet4'), 'testnet4', 'lnd 0.20 reports testnet4; it must not be "unknown"');
  assert.equal(normalizeNetwork('MAINNET'), 'mainnet');
  assert.equal(normalizeNetwork(undefined), 'unknown');
  assert.equal(normalizeNetwork('something-else'), 'unknown');
});

test('LIFEBOAT_NETWORK names the network you mean; any other node is refused, mainnet included', () => {
  assert.doesNotThrow(() => assertNetworkAllowed('testnet', { LIFEBOAT_NETWORK: 'testnet' }));
  assert.doesNotThrow(() => assertNetworkAllowed('testnet', { LIFEBOAT_NETWORK: ' TESTNET ' }));
  assert.throws(() => assertNetworkAllowed('regtest', { LIFEBOAT_NETWORK: 'testnet' }), /REGTEST but LIFEBOAT_NETWORK=testnet/);
  assert.throws(() => assertNetworkAllowed('mainnet', { LIFEBOAT_NETWORK: 'testnet' }), /MAINNET but LIFEBOAT_NETWORK=testnet/);
  assert.throws(() => assertNetworkAllowed('mainnet', { LIFEBOAT_NETWORK: 'testnet', LIFEBOAT_ALLOW_MAINNET: '1' }), /LIFEBOAT_NETWORK=testnet/, 'the mainnet flag does not override a stated intent');
  assert.throws(() => assertNetworkAllowed('unknown', { LIFEBOAT_NETWORK: 'testnet' }), /UNKNOWN but/);
  const bad = validateConfig({ LIFEBOAT_NETWORK: 'moon' }, { needRelays: false, needNode: false });
  assert.ok(bad.errors.some((e) => /LIFEBOAT_NETWORK must be one of/.test(e)), bad.errors.join(' | '));
});

test('loopback detection', () => {
  assert.equal(isLoopbackUrl('ws://127.0.0.1:1/'), true);
  assert.equal(isLoopbackUrl('wss://relay.example/'), false);
});

test('startup validation reports every problem at once, with the variable name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifeboat-cfg-'));
  const cert = join(dir, 'tls.cert');
  const mac = join(dir, 'm.macaroon');
  const empty = join(dir, 'empty');
  writeFileSync(cert, 'x');
  writeFileSync(mac, 'x');
  writeFileSync(empty, '');
  chmodSync(mac, 0o600);
  const good = { LND_CERT: cert, LND_MACAROON: mac, RELAYS: 'wss://a.example,wss://b.example' };
  assert.deepEqual(validateConfig(good), { errors: [], warnings: [] });

  const bad = validateConfig({ LND_CERT: join(dir, 'missing'), LND_MACAROON: empty, LND_PORT: '99999', RELAYS: 'https://x', PORT: '0', STALE_AFTER_SEC: '5' });
  assert.equal(bad.errors.length, 6, bad.errors.join(' | '));
  for (const name of ['LND_CERT', 'LND_MACAROON', 'LND_PORT', 'ws://', 'PORT', 'STALE_AFTER_SEC']) assert.ok(bad.errors.some((e) => e.includes(name)), `no error mentions ${name}`);
  assert.deepEqual(validateConfig({}, { needRelays: false }).errors.length, 2);
  assert.match(validateConfig({ ...good, RELAYS: 'wss://only.example' }).warnings[0], /only one relay/);
  assert.match(validateConfig({ ...good, RELAYS: 'ws://remote.example,wss://b.example' }).warnings[0], /cleartext/);
  assert.equal(validateConfig({}, { needRelays: false, needNode: false }).errors.length, 0);
});
