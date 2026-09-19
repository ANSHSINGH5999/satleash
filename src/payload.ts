import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** What we encrypt into the Nostr event: lnd's own (already encrypted) multi-channel backup plus peer hints for reconnecting. */
export type Payload = { v: 1; scb: string; peers: string[]; /** fingerprint of the channel set the backup covers */ cp?: string };

/**
 * lnd re-encrypts the backup with a fresh nonce on every export, so two exports of the same channels never compare equal.
 * Static channel backups only depend on which channels exist, so the set of channel points is the stable identity.
 */
/** "txid:index" as lnd prints it: export gives the txid as base64 little-endian bytes, verify gives it as hex. */
export function chanPointId(p: unknown): string {
  const o = p as { funding_txid_bytes?: string; funding_txid_str?: string; output_index?: number };
  const txid = o.funding_txid_bytes ? Buffer.from(o.funding_txid_bytes, 'base64').reverse().toString('hex') : (o.funding_txid_str ?? '');
  return `${txid}:${o.output_index ?? 0}`;
}

export function channelSetHash(points: unknown[]): string {
  const ids = points
    .map((p) => {
      const o = p as { funding_txid_bytes?: string; funding_txid_str?: string; output_index?: number };
      return `${o.funding_txid_bytes ?? o.funding_txid_str ?? ''}:${o.output_index ?? 0}`;
    })
    .sort();
  return bytesToHex(sha256(utf8ToBytes(ids.join('\n'))));
}

/** NIP-44 plaintext limit. */
export const MAX_PAYLOAD_BYTES = 65535;

const PEER = /^0[23][0-9a-f]{64}@[^\s@]+:\d{1,5}$/i;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function encodePayload(p: Payload): string {
  const s = JSON.stringify(p);
  const bytes = Buffer.byteLength(s);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`backup payload is ${bytes} bytes, over the NIP-44 limit of ${MAX_PAYLOAD_BYTES} (roughly 200 channels). Chunking is not implemented.`);
  }
  return s;
}

/** Validates everything: this is data that came back from relays, even though only our key can have signed it. */
export function decodePayload(s: string): Payload {
  let j: unknown;
  try {
    j = JSON.parse(s);
  } catch {
    throw new Error('backup payload is not valid JSON');
  }
  const p = j as Partial<Payload> | null;
  if (!p || typeof p !== 'object' || p.v !== 1) throw new Error('unsupported backup payload version');
  if (typeof p.scb !== 'string' || !p.scb || p.scb.length > MAX_PAYLOAD_BYTES || !B64.test(p.scb)) throw new Error('backup payload has an invalid channel backup');
  if (!Array.isArray(p.peers) || p.peers.length > 200 || !p.peers.every((x) => typeof x === 'string' && PEER.test(x))) {
    throw new Error('backup payload has invalid peer hints');
  }
  if (p.cp !== undefined && !(typeof p.cp === 'string' && /^[0-9a-f]{64}$/.test(p.cp))) throw new Error('backup payload has an invalid channel-set fingerprint');
  return { v: 1, scb: p.scb, peers: p.peers, ...(p.cp ? { cp: p.cp } : {}) };
}
