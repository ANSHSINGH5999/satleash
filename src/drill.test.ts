import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DrillRunner } from './drill.js';
import type { DrillEvent } from './drill-parse.js';

const types = (r: DrillRunner) => r.events().map((e) => e.type);

test('a run emits start, parsed lines and metrics, then end and idle; the claim is released only at the end', async () => {
  const r = new DrillRunner({
    run: async (emit) => {
      emit('== fresh regtest cluster', false);
      emit('recovered 90 of 100 channel sats on-chain', false);
      emit('a warning on stderr', true);
      return 0;
    },
    cleanup: async () => {},
  });
  assert.equal(r.tryClaim(), true);
  assert.equal(r.tryClaim(), false, 'second claim while busy must fail');
  await r.run();
  assert.equal(r.busy(), false);
  const t = types(r);
  assert.equal(t[0], 'start');
  assert.ok(t.includes('stage') && t.includes('metric'));
  assert.deepEqual(t.slice(-2), ['end', 'idle']);
  assert.equal((r.events().find((e) => e.type === 'end') as Extract<DrillEvent, { type: 'end' }>).ok, true);
  assert.ok(r.events().some((e) => e.type === 'line' && e.kind === 'err'));
  assert.equal(r.tryClaim(), true);
});

test('a crashing or failing drill still ends cleanly and runs cleanup', async () => {
  let cleaned = 0;
  const crash = new DrillRunner({ run: async () => { throw new Error('boom'); }, cleanup: async () => { cleaned++; } });
  crash.tryClaim();
  await crash.run();
  const end = crash.events().find((e) => e.type === 'end') as Extract<DrillEvent, { type: 'end' }>;
  assert.equal(end.ok, false);
  assert.ok(crash.events().some((e) => e.type === 'line' && /boom/.test(e.text)));
  assert.equal(cleaned, 1);
  assert.equal(crash.busy(), false);

  const fail = new DrillRunner({ run: async () => 1, cleanup: async () => { throw new Error('cleanup failed'); } });
  fail.tryClaim();
  await fail.run();
  assert.equal((fail.events().find((e) => e.type === 'end') as Extract<DrillEvent, { type: 'end' }>).ok, false);
  assert.deepEqual(types(fail).slice(-2), ['end', 'idle'], 'a failing cleanup must not wedge the runner');
});

test('output lines are capped but lifecycle events are never dropped', async () => {
  const r = new DrillRunner({ maxLines: 5, run: async (emit) => { for (let i = 0; i < 50; i++) emit(`line ${i}`, false); return 0; }, cleanup: async () => {} });
  r.tryClaim();
  await r.run();
  assert.equal(r.events().filter((e) => e.type === 'line').length, 5);
  assert.deepEqual(types(r).slice(-2), ['end', 'idle']);
});

test('subscribers see live events and can unsubscribe', async () => {
  const r = new DrillRunner({ run: async (emit) => { emit('x', false); return 0; }, cleanup: async () => {} });
  const seen: string[] = [];
  const off = r.subscribe((e) => seen.push(e.type));
  r.tryClaim();
  await r.run();
  assert.deepEqual(seen, ['start', 'line', 'end', 'idle']);
  off();
  r.tryClaim();
  await r.run();
  assert.equal(seen.length, 4);
});
