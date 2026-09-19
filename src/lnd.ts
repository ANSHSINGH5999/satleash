import { request } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';

export type LndOpts = { port: number; certPath: string; macaroonPath: string; host?: string; timeoutMs?: number };
export type Perm = { entity: string; action: string };

export type BackupSnapshot = {
  multi_chan_backup?: { chan_points: unknown[]; multi_chan_backup: string };
};

export type NodeInfo = {
  identity_pubkey: string;
  alias?: string;
  synced_to_chain: boolean;
  block_height: number;
  version?: string;
  chains?: { chain: string; network: string }[];
};
export type ChannelInfo = { active: boolean; local_balance: string; remote_balance: string; remote_pubkey: string };

/** Permissions the backup daemon needs: read-only, no spending. `macaroon:read` lets it check its own privileges. */
export const MONITOR_PERMS: Perm[] = [
  { entity: 'info', action: 'read' },
  { entity: 'offchain', action: 'read' },
  { entity: 'signer', action: 'generate' },
  { entity: 'peers', action: 'read' },
  { entity: 'macaroon', action: 'read' },
];
/** Restore additionally imports the backup (offchain:write) and dials peers (peers:write). Still cannot spend on-chain. */
export const RESTORE_PERMS: Perm[] = [...MONITOR_PERMS, { entity: 'offchain', action: 'write' }, { entity: 'peers', action: 'write' }];

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');

/** Minimal LND REST client (TLS pinned to the node's own cert, macaroon re-read per call, every request has a timeout). */
export class Lnd {
  constructor(private o: LndOpts) {}

  private opts(method: string, path: string, body?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    if (existsSync(this.o.macaroonPath)) {
      headers['grpc-metadata-macaroon'] = readFileSync(this.o.macaroonPath).toString('hex');
    }
    return {
      host: this.o.host ?? '127.0.0.1',
      port: this.o.port,
      servername: 'localhost',
      path,
      method,
      headers,
      ca: readFileSync(this.o.certPath),
    };
  }

  call<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const ms = this.o.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const r = request(this.opts(method, path, data), (res) => {
        const chunks: Buffer[] = [];
        let complete = false;
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        // a server that dies mid-body emits neither 'end' nor a request error; without this the promise would never settle
        res.on('close', () => {
          if (!complete) reject(new Error(`${method} ${path}: connection closed before the response completed`));
        });
        res.on('end', () => {
          complete = true;
          const text = Buffer.concat(chunks).toString();
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`${method} ${path} -> ${res.statusCode}: ${text}`));
          try {
            resolve((text ? JSON.parse(text) : {}) as T);
          } catch {
            reject(new Error(`${method} ${path}: lnd returned invalid JSON`));
          }
        });
      });
      r.setTimeout(ms, () => r.destroy(new Error(`${method} ${path} timed out after ${ms}ms`)));
      r.on('error', reject);
      if (data !== undefined) r.write(data);
      r.end();
    });
  }

  /** Server-streaming GET. Returns a function that closes the stream. */
  stream<T>(path: string, onMsg: (m: T) => void, onEnd: (e?: Error) => void): () => void {
    let ended = false;
    const end = (e?: Error) => {
      if (!ended) {
        ended = true;
        onEnd(e);
      }
    };
    const r = request(this.opts('GET', path), (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => end(new Error(`GET ${path} -> ${res.statusCode}: ${t}`)));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) end(new Error(JSON.stringify(j.error)));
            else onMsg(j.result as T);
          } catch {
            end(new Error(`GET ${path}: malformed stream message`));
          }
        }
      });
      res.on('end', () => end());
      res.on('error', (e) => end(e));
    });
    // A backup stream is silent until a channel changes, so an idle timeout would kill a healthy stream. Dead peers are
    // caught by TCP keepalive instead, and the monitor republishes if verification ever finds the backup behind the node.
    r.on('socket', (sock) => {
      sock.setTimeout(0);
      sock.setKeepAlive(true, 30_000);
    });
    r.on('error', (e) => end(e));
    r.end();
    return () => {
      ended = true;
      r.destroy();
    };
  }

  /** getinfo answers before every subserver is up; restore needs SERVER_ACTIVE. */
  async waitActive(tries = 120) {
    for (let i = 0; i < tries; i++) {
      const s = await this.call<{ state: string }>('GET', '/v1/state').catch(() => null);
      if (s?.state === 'SERVER_ACTIVE') return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('lnd did not reach SERVER_ACTIVE');
  }

  getInfo() {
    return this.call<NodeInfo>('GET', '/v1/getinfo');
  }

  async listChannels(): Promise<ChannelInfo[]> {
    return (await this.call<{ channels?: ChannelInfo[] }>('GET', '/v1/channels')).channels ?? [];
  }

  pending() {
    return this.call<{ waiting_close_channels?: unknown[]; pending_force_closing_channels?: unknown[] }>('GET', '/v1/channels/pending');
  }

  /** ECDH between our seed-derived key at (family, index) and `peer`. Private key never leaves lnd. */
  async sharedKey(peer: Uint8Array, family: number, index: number): Promise<Uint8Array> {
    const r = await this.call<{ shared_key: string }>('POST', '/v2/signer/sharedkey', {
      ephemeral_pubkey: b64(peer),
      key_desc: { key_loc: { key_family: family, key_index: index } },
    });
    return Buffer.from(r.shared_key, 'base64');
  }

  /** `pubkey@host:port` for peers we dialed out to and share a channel with (inbound addresses are ephemeral). */
  async channelPeerHints(): Promise<string[]> {
    const [peers, chans] = await Promise.all([
      this.call<{ peers?: { pub_key: string; address: string; inbound: boolean }[] }>('GET', '/v1/peers'),
      this.listChannels(),
    ]);
    const withChannel = new Set(chans.map((c) => c.remote_pubkey));
    return (peers.peers ?? []).filter((p) => !p.inbound && withChannel.has(p.pub_key)).map((p) => `${p.pub_key}@${p.address}`);
  }

  async connectPeer(hint: string) {
    const at = hint.indexOf('@');
    await this.call('POST', '/v1/peers', { addr: { pubkey: hint.slice(0, at), host: hint.slice(at + 1) } }).catch((e: Error) => {
      if (!/already connected/i.test(e.message)) throw e;
    });
  }

  /** Bakes a new macaroon with exactly `perms`. Needs a macaroon that may bake (admin). Returns hex. */
  async bakeMacaroon(perms: Perm[]): Promise<string> {
    const r = await this.call<{ macaroon: string }>('POST', '/v1/macaroon', { permissions: perms, root_key_id: '0', allow_external_permissions: false });
    return r.macaroon;
  }

  /**
   * Can the macaroon this client uses move on-chain funds? true/false when lnd answers,
   * undefined when this macaroon isn't allowed to ask (no macaroon:read).
   */
  async canSpendOnchain(): Promise<boolean | undefined> {
    const mac = readFileSync(this.o.macaroonPath);
    try {
      await this.call('POST', '/v1/macaroon/checkpermissions', { macaroon: b64(mac), permissions: [{ entity: 'onchain', action: 'write' }] });
      return true;
    } catch (e) {
      // Observed on lnd 0.20: the checked macaroon lacking the permission is `400 {"code":3,"message":"permission denied"}`,
      // while a caller that may not ask at all (no macaroon:read) gets `500 {"code":2,...}`.
      return /-> 400: .*"code":\s*3.*permission denied/.test((e as Error).message) ? false : undefined;
    }
  }

  exportBackup() {
    return this.call<BackupSnapshot>('GET', '/v1/channels/backup');
  }

  subscribeBackups(onSnap: (s: BackupSnapshot) => void, onEnd: (e?: Error) => void) {
    return this.stream<BackupSnapshot>('/v1/channels/backup/subscribe', onSnap, onEnd);
  }

  /**
   * Asks lnd itself to decrypt and validate a multi-channel backup with this node's seed-derived key. Resolves with the
   * channel points the backup really contains ("txid:index"); rejects if lnd cannot decrypt it (corrupted, or another seed).
   */
  async verifyBackup(multiB64: string): Promise<string[]> {
    const r = await this.call<{ chan_points?: string[] }>('POST', '/v1/channels/backup/verify', { multi_chan_backup: { multi_chan_backup: multiB64 } });
    return r.chan_points ?? [];
  }

  restoreBackup(multiB64: string) {
    return this.call('POST', '/v1/channels/backup/restore', { multi_chan_backup: multiB64 });
  }
}

/** The subset of Lnd the backup service needs; tests provide a fake. */
export type BackupLnd = Pick<Lnd, 'exportBackup' | 'subscribeBackups' | 'sharedKey' | 'channelPeerHints'>;
