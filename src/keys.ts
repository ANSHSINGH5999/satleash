import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Lnd } from './lnd.js';

/** Custom lnd key family for this app; index 0 is the backup identity. */
export const KEY_FAMILY = 1573;

/**
 * A curve point nobody knows the discrete log of (hash-to-x, try-and-increment).
 * If we used a point with a known log k, anyone holding our lnd pubkey could compute
 * d*P = k*(d*G) and derive the Nostr key.
 */
export function numsPoint(): Uint8Array {
  for (let i = 0; ; i++) {
    const x = sha256(utf8ToBytes(`lifeboat/nums/v1/${i}`));
    try {
      return secp256k1.Point.fromBytes(concatBytes(Uint8Array.of(2), x)).toBytes(true);
    } catch {
      // x not on curve, try next counter
    }
  }
}

/** Deterministic Nostr secret key derived from the wallet seed via lnd's signer RPC. */
export async function deriveNostrKey(lnd: Pick<Lnd, 'sharedKey'>): Promise<Uint8Array> {
  const shared = await lnd.sharedKey(numsPoint(), KEY_FAMILY, 0);
  return sha256(concatBytes(utf8ToBytes('lifeboat/nostr-key/v1'), shared));
}
