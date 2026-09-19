import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelaySet } from './relays.js';

test('starts from validated, normalised, de-duplicated URLs', () => {
  const s = new RelaySet(['wss://a.example', 'wss://a.example/', 'ws://127.0.0.1:7777']);
  assert.deepEqual(s.active(), ['wss://a.example/', 'ws://127.0.0.1:7777/']);
  assert.throws(() => new RelaySet(['https://a.example']), /ws:\/\/ or wss:\/\//);
});

test('add validates strictly and rejects duplicates, lists, whitespace and the 11th relay', () => {
  const s = new RelaySet(['wss://a.example']);
  assert.equal(s.add('wss://b.example').session, true);
  assert.deepEqual(s.active(), ['wss://a.example/', 'wss://b.example/']);
  for (const bad of ['wss://a.example', 'https://x', 'wss://x, wss://y', 'wss://x y', 'wss://u:p@x.example', '', 'javascript:alert(1)']) {
    assert.throws(() => s.add(bad), Error, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => s.add(undefined as unknown as string), /invalid relay URL/);
  for (let i = 0; i < 8; i++) s.add(`wss://r${i}.example`);
  assert.throws(() => s.add('wss://one-too-many.example'), /at most 10/);
});

test('at least one relay always stays enabled; disabled relays leave the active list but stay visible', () => {
  const s = new RelaySet(['wss://a.example', 'wss://b.example']);
  s.setEnabled('wss://b.example', false);
  assert.deepEqual(s.active(), ['wss://a.example/']);
  assert.equal(s.all().length, 2);
  assert.throws(() => s.setEnabled('wss://a.example', false), /at least one relay must stay enabled/);
  assert.throws(() => s.remove('wss://a.example'), /at least one relay must stay enabled/);
  s.remove('wss://b.example');
  assert.equal(s.all().length, 1);
  assert.throws(() => s.remove('wss://nope.example'), /not configured/);
  assert.throws(() => s.setEnabled('not a url', true), /invalid relay URL/);
});

test('listeners hear about real changes only', () => {
  const s = new RelaySet(['wss://a.example']);
  let n = 0;
  s.onChange(() => n++);
  s.add('wss://b.example');
  s.setEnabled('wss://b.example', true); // already enabled: no change
  s.setEnabled('wss://b.example', false);
  s.remove('wss://b.example');
  assert.equal(n, 3);
});
