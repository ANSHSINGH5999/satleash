import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger, redact } from './log.js';

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
