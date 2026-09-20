import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, Logger, redact } from './log.js';

test('credentials are redacted by key name, nested and inside arrays', () => {
  const out = redact({ macaroon: 'abcd', nested: { mnemonic: ['a', 'b'], keep: 1 }, list: [{ token: 't', ok: true }], Password: 'x', nsecKey: 'n' }) as any;
  assert.equal(out.macaroon, '[redacted]');
  assert.equal(out.nested.mnemonic, '[redacted]');
  assert.equal(out.nested.keep, 1);
  assert.equal(out.list[0].token, '[redacted]');
  assert.equal(out.list[0].ok, true);
  assert.equal(out.Password, '[redacted]');
  assert.equal(out.nsecKey, '[redacted]');
});

test('large blobs are shortened and errors keep only name and message', () => {
  const out = redact({ scb: 'A'.repeat(5000), err: new Error('boom') }) as any;
  assert.ok(out.scb.length < 100 && out.scb.includes('5000 chars'));
  assert.deepEqual(out.err, { name: 'Error', message: 'boom' });
});

test('level filtering, bounded ring buffer and json output', () => {
  const lines: string[] = [];
  const log = new Logger({ level: 'info', json: true, ringSize: 3, write: (l) => lines.push(l) });
  log.debug('hidden');
  for (let i = 0; i < 5; i++) log.info(`m${i}`, { macaroon: 'secret', i });
  assert.equal(lines.length, 5);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.fields.macaroon, '[redacted]');
  assert.deepEqual(log.recent().map((e) => e.msg), ['m2', 'm3', 'm4']);
  assert.ok(!lines.join('').includes('secret'));
});

test('createLogger with stderr: true keeps stdout clean: every level goes to stderr', () => {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const log = createLogger({}, { stderr: true });
    log.info('connected to lnd');
    log.warn('careful');
    const plain = createLogger({});
    plain.info('goes to stdout as before');
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  assert.equal(err.filter((l) => /connected to lnd|careful/.test(l)).length, 2);
  assert.deepEqual(out.filter((l) => /connected to lnd|careful/.test(l)), []);
  assert.equal(out.filter((l) => /goes to stdout as before/.test(l)).length, 1, 'the default logger is unchanged');
});
