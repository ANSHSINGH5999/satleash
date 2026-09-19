// Fakes shared by the unit tests. Nothing here is used by production code.
import type { Publisher } from './backup.js';
import type { BackupLnd, BackupSnapshot } from './lnd.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * A stand-in for lnd's backup surface. Like the real lnd, every export produces a different blob for the same channels
 * (fresh nonce); only the set of channel points identifies the backup. The test controls the channels and the stream.
 */
export function fakeLnd() {
  const s = {
    points: ['aa:0', 'bb:1'],
    nonce: 0,
    scbOverride: undefined as string | undefined,
    exports: 0,
    subscribes: 0,
    peers: [] as string[],
    onSnap: undefined as ((x: BackupSnapshot) => void) | undefined,
    onEnd: undefined as ((e?: Error) => void) | undefined,
  };
  const snap = (): BackupSnapshot => ({
    multi_chan_backup: {
      chan_points: s.points.map((p) => ({ funding_txid_str: p.split(':')[0], output_index: Number(p.split(':')[1]) })),
      multi_chan_backup: s.scbOverride ?? Buffer.from(`blob:${s.points.join(',')}:${s.nonce++}`).toString('base64'),
    },
  });
  const lnd: BackupLnd & { verifyBackup: (scb: string) => Promise<string[]> } = {
    exportBackup: async () => {
      s.exports++;
      return snap();
    },
    subscribeBackups: (a, b) => {
      s.subscribes++;
      s.onSnap = a;
      s.onEnd = b;
      return () => {};
    },
    // like lnd: decrypts with the node's key and lists the channels inside, or refuses
    verifyBackup: async (b64) => {
      const m = /^blob:(.*):\d+$/.exec(Buffer.from(b64, 'base64').toString());
      if (!m) throw new Error('invalid multi channel backup: chacha20poly1305: message authentication failed');
      return m[1] ? m[1].split(',') : [];
    },
    sharedKey: async () => new Uint8Array(32).fill(7),
    channelPeerHints: async () => s.peers,
  };
  return { lnd, state: s, emit: () => s.onSnap?.(snap()), drop: (e?: Error) => s.onEnd?.(e ?? new Error('stream dropped')) };
}

/** Records publishes; the first `fail` calls throw like a relay set that rejected everything. */
export function fakePublisher(fail = 0, newest?: number) {
  const st = { calls: [] as { payload: string; ts: number }[], fail };
  const p: Publisher = {
    publish: async (relays, _sk, payload, ts) => {
      if (st.fail > 0) {
        st.fail--;
        throw new Error('relays down');
      }
      st.calls.push({ payload, ts });
      return { eventId: `ev${st.calls.length}`, ok: relays, failed: [] };
    },
    close: () => {},
    ...(newest !== undefined ? { newestTimestamp: async () => newest } : {}),
  };
  return { p, st };
}
