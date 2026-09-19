import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Lnd } from './lnd.js';

const dir = mkdtempSync(join(tmpdir(), 'lifeboat-lnd-test-'));
const macPath = join(dir, 'test.macaroon');
const MAC = Buffer.from('0201aabbccdd', 'hex');

function makeCert(name: string) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.cert`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

let handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void = () => {};
let server: https.Server;
let port = 0;
const pinned = makeCert('pinned');
const other = makeCert('other');
const client = (o: { timeoutMs?: number; certPath?: string } = {}) => new Lnd({ port, certPath: o.certPath ?? pinned.certPath, macaroonPath: macPath, timeoutMs: o.timeoutMs });

before(async () => {
  writeFileSync(macPath, MAC);
  server = https.createServer({ key: pinned.key, cert: pinned.cert }, (req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('requests carry the macaroon as hex and JSON comes back parsed', async () => {
  let seen = '';
  handler = (req, res) => {
    seen = String(req.headers['grpc-metadata-macaroon']);
    res.end(JSON.stringify({ identity_pubkey: 'pk', synced_to_chain: true, block_height: 7 }));
  };
  const info = await client().getInfo();
  assert.equal(seen, MAC.toString('hex'));
  assert.equal(info.block_height, 7);
});

test('an error status becomes an Error with the status and lnd\'s message', async () => {
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end('{"message":"server is still in the process of starting"}');
  };
  await assert.rejects(client().getInfo(), /GET \/v1\/getinfo -> 500: .*still in the process of starting/);
});

test('an unresponsive lnd times out instead of hanging the daemon', async () => {
  handler = () => {}; // never answers
  const t0 = Date.now();
  await assert.rejects(client({ timeoutMs: 200 }).getInfo(), /timed out after 200ms/);
  assert.ok(Date.now() - t0 < 2000);
});

test('an invalid JSON body is reported, not thrown as a raw parse error', async () => {
  handler = (_req, res) => res.end('<html>not json</html>');
  await assert.rejects(client().getInfo(), /invalid JSON/);
});

test('the TLS certificate is pinned: a server presenting a different cert is refused', async () => {
  const impostor = https.createServer({ key: other.key, cert: other.cert }, (_req, res) => res.end('{}'));
  await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
  const c = new Lnd({ port: (impostor.address() as AddressInfo).port, certPath: pinned.certPath, macaroonPath: macPath, timeoutMs: 2000 });
  try {
    await assert.rejects(c.getInfo(), /self.signed|unable to verify|certificate/i);
  } finally {
    impostor.closeAllConnections();
    impostor.close();
  }
});

test('streams deliver messages, report a malformed line once, and end exactly once', async () => {
  handler = (_req, res) => {
    res.write('{"result":{"n":1}}\n{"result":{"n":2}}\n');
    res.end('this is not json\n');
  };
  const msgs: unknown[] = [];
  const ends: (Error | undefined)[] = [];
  await new Promise<void>((resolve) => client().stream('/v1/x', (m) => msgs.push(m), (e) => { ends.push(e); setTimeout(resolve, 50); }));
  assert.deepEqual(msgs, [{ n: 1 }, { n: 2 }]);
  assert.equal(ends.length, 1);
  assert.match(ends[0]!.message, /malformed stream message/);
});

test('a stream that lnd rejects reports the status', async () => {
  handler = (_req, res) => {
    res.statusCode = 403;
    res.end('permission denied');
  };
  const err = await new Promise<Error | undefined>((resolve) => client().stream('/v1/x', () => {}, resolve));
  assert.match(err!.message, /403: permission denied/);
});

test('canSpendOnchain maps lnd\'s real answers: allowed, macaroon lacks the permission, caller may not ask, unreachable', async () => {
  handler = (_req, res) => res.end('{}');
  assert.equal(await client().canSpendOnchain(), true);
  handler = (_req, res) => {
    res.statusCode = 400;
    res.end('{"code":3,"message":"permission denied","details":[]}'); // observed on lnd 0.20 for a read-only macaroon
  };
  assert.equal(await client().canSpendOnchain(), false);
  handler = (_req, res) => {
    res.statusCode = 500;
    res.end('{"code":2,"message":"permission denied","details":[]}'); // observed when the caller lacks macaroon:read
  };
  assert.equal(await client().canSpendOnchain(), undefined);
  assert.equal(await new Lnd({ port: 1, certPath: pinned.certPath, macaroonPath: macPath, timeoutMs: 500 }).canSpendOnchain(), undefined);
});

test('a connection reset mid-request is an error, not a hang', async () => {
  handler = (req) => req.socket.destroy();
  await assert.rejects(client({ timeoutMs: 2000 }).getInfo(), /socket hang up|ECONNRESET|aborted/i);
});

test('a response cut off half way is an error, not a partial success', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-length': '200' });
    res.write('{"identity_pubkey":');
    setTimeout(() => res.destroy(), 20);
  };
  await assert.rejects(client({ timeoutMs: 2000 }).getInfo(), /aborted|ECONNRESET|socket hang up|invalid JSON/i);
});

test('a slow but timely answer succeeds; the same answer past the limit times out', async () => {
  handler = (_req, res) => setTimeout(() => res.end('{"block_height":9}'), 250);
  assert.equal((await client({ timeoutMs: 2000 }).getInfo()).block_height, 9);
  await assert.rejects(client({ timeoutMs: 100 }).getInfo(), /timed out after 100ms/);
});

test('a rejected macaroon surfaces lnd\'s message with the status, and an unreachable node says so', async () => {
  handler = (_req, res) => {
    res.statusCode = 401;
    res.end('{"code":2,"message":"verification failed: signature mismatch after caveat verification"}');
  };
  await assert.rejects(client().getInfo(), /-> 401: .*signature mismatch/);
  await assert.rejects(new Lnd({ port: 1, certPath: pinned.certPath, macaroonPath: macPath, timeoutMs: 1000 }).getInfo(), /ECONNREFUSED/);
});

test('waitActive keeps polling until lnd reports SERVER_ACTIVE and gives up with a clear error otherwise', async () => {
  let n = 0;
  handler = (_req, res) => res.end(JSON.stringify({ state: ++n < 3 ? 'RPC_ACTIVE' : 'SERVER_ACTIVE' }));
  await client().waitActive(10);
  assert.equal(n, 3);
  handler = (_req, res) => res.end('{"state":"WAITING_TO_START"}');
  await assert.rejects(client().waitActive(2), /did not reach SERVER_ACTIVE/);
});

test('a healthy but idle stream is not killed by the request timeout; messages arriving later are delivered', async () => {
  handler = (_req, res) => {
    res.write(''); // headers out, then silence for longer than the client's timeout
    setTimeout(() => res.write('{"result":{"n":1}}\n'), 400);
    setTimeout(() => res.end(), 700);
  };
  const msgs: unknown[] = [];
  const ends: (Error | undefined)[] = [];
  await new Promise<void>((resolve) => client({ timeoutMs: 100 }).stream('/v1/x', (m) => msgs.push(m), (e) => { ends.push(e); resolve(); }));
  assert.deepEqual(msgs, [{ n: 1 }]);
  assert.equal(ends.length, 1);
  assert.equal(ends[0], undefined, 'it ended because the server closed it, not because we gave up');
});
