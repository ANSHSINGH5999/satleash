import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from './errors.js';

test('known failures get a cause, an impact and an action', () => {
  for (const msg of [
    'no relay accepted the backup: wss://a (timeout)',
    'GET /v1/getinfo timed out after 30000ms',
    'connect ECONNREFUSED 127.0.0.1:8080',
    'POST /v1/x -> 500: {"message":"permission denied"}',
    'GET /v1/getinfo -> 500: server is still in the process of starting',
    'backup payload is 70000 bytes, over the NIP-44 limit of 65535',
    'self-signed certificate',
    'GET /v1/getinfo -> 401: verification failed: signature mismatch after caveat verification',
  ]) {
    const e = explain(new Error(msg));
    assert.equal(e.error, msg);
    assert.ok(e.cause && e.impact && e.action, `no explanation for: ${msg}`);
  }
});

test('unknown failures keep the message and invent nothing', () => {
  assert.deepEqual(explain(new Error('something odd')), { error: 'something odd' });
  assert.deepEqual(explain('plain string'), { error: 'plain string' });
});
