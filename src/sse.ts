import type { ServerResponse } from 'node:http';

/** Server-sent-event fan-out with a client cap, a per-client output cap (slow clients are dropped), heartbeats and clean shutdown. */
export class Broadcaster<T> {
  private clients = new Map<ServerResponse, NodeJS.Timeout>();

  constructor(private o: { max?: number; maxBufferedBytes?: number; heartbeatMs?: number } = {}) {}

  get size() {
    return this.clients.size;
  }

  get full() {
    return this.clients.size >= (this.o.max ?? 20);
  }

  /** Registers a client that has already had its headers written. Returns false when the cap is reached. */
  add(res: ServerResponse, replay: T[] = []): boolean {
    if (this.clients.size >= (this.o.max ?? 20)) return false;
    res.write(': connected\n\n'); // flushes the headers; without a first write the client waits for the first event
    for (const e of replay) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const beat = setInterval(() => this.write(res, ': keep-alive\n\n'), this.o.heartbeatMs ?? 15_000);
    beat.unref();
    this.clients.set(res, beat);
    res.on('close', () => this.drop(res));
    return true;
  }

  broadcast(e: T) {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of [...this.clients.keys()]) this.write(res, line);
  }

  private write(res: ServerResponse, chunk: string) {
    if (res.destroyed || res.writableEnded) return this.drop(res);
    // a client that stops reading would otherwise make us buffer without bound
    if (res.writableLength > (this.o.maxBufferedBytes ?? 1_000_000)) {
      this.drop(res);
      return void res.destroy();
    }
    res.write(chunk);
  }

  private drop(res: ServerResponse) {
    const t = this.clients.get(res);
    if (t) clearInterval(t);
    this.clients.delete(res);
  }

  closeAll() {
    for (const res of [...this.clients.keys()]) {
      this.drop(res);
      res.end();
    }
  }
}
