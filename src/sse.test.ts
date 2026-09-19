import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Broadcaster } from './sse.js';

/** Just enough of a ServerResponse for the broadcaster. */
class FakeRes extends EventEmitter {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  write(c: string) {
    this.chunks.push(c);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  events() {
    return this.chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  }
}
const fake = () => new FakeRes() as unknown as ServerResponse & FakeRes;

test('a new client gets its headers flushed at once, then the replay, then live events', () => {
  const b = new Broadcaster<{ n: number }>();
  const r = fake();
  assert.equal(b.add(r, [{ n: 1 }, { n: 2 }]), true);
  assert.equal(r.chunks[0], ': connected\n\n', 'first write must flush the response headers');
  b.broadcast({ n: 3 });
  assert.deepEqual(r.events(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('the client cap is enforced and freed when a client disconnects', () => {
  const b = new Broadcaster({ max: 2 });
  const [a, c, d] = [fake(), fake(), fake()];
  assert.ok(b.add(a) && b.add(c));
  assert.equal(b.add(d), false);
  a.emit('close');
  assert.equal(b.size, 1);
  assert.equal(b.add(d), true);
});

test('a slow client whose output backs up is dropped instead of buffered without bound; fast clients are unaffected', () => {
  const b = new Broadcaster<number>({ maxBufferedBytes: 1000 });
  const slow = fake();
  const fast = fake();
  b.add(slow);
  b.add(fast);
  slow.writableLength = 5000;
  b.broadcast(1);
  assert.equal(slow.destroyed, true);
  assert.equal(b.size, 1);
  b.broadcast(2);
  assert.deepEqual(fast.events(), [1, 2]);
});

test('high event volume reaches every client in order', () => {
  const b = new Broadcaster<number>();
  const clients = [fake(), fake(), fake()];
  clients.forEach((c) => b.add(c));
  for (let i = 0; i < 5000; i++) b.broadcast(i);
  for (const c of clients) {
    const got = c.events();
    assert.equal(got.length, 5000);
    assert.equal(got[0], 0);
    assert.equal(got[4999], 4999);
  }
});

test('dead connections are pruned on the next write, reconnecting clients start from the replay, and shutdown ends everyone', () => {
  const b = new Broadcaster<number>();
  const dead = fake();
  b.add(dead);
  dead.destroyed = true;
  b.broadcast(1);
  assert.equal(b.size, 0);
  const again = fake();
  b.add(again, [1]);
  assert.deepEqual(again.events(), [1]);
  const other = fake();
  b.add(other);
  b.closeAll();
  assert.equal(again.writableEnded && other.writableEnded, true);
  assert.equal(b.size, 0);
});
