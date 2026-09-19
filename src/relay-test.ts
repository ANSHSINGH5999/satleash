// Public relay test mode. Publishes ONE encrypted dummy event signed by a throwaway key, reads it back, verifies it,
// then asks the relay to delete it (NIP-09). It never touches lnd, the real backup key or any real backup data.
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { KIND, probeRelayFilter } from './nostr.js';
import { channelSetHash, decodePayload, encodePayload } from './payload.js';

export type PublicRelayTestResult = {
  url: string;
  namespace: string;
  throwawayPubkey: string;
  eventId: string;
  published: boolean;
  publishMs?: number;
  retrieved: boolean;
  retrieveMs?: number;
  signatureValid: boolean;
  decrypted: boolean;
  /** the decrypted dummy passes the same payload validation a real backup goes through */
  payloadValid: boolean;
  /** its channel-set fingerprint equals the one recomputed from the dummy channel point */
  fingerprintValid: boolean;
  deletionRequested: boolean;
  /** true: gone after the deletion request. false: still served (many relays ignore NIP-09). undefined: not checked */
  deletionHonored?: boolean;
  errors: string[];
};

export const TEST_TAG = 'lifeboat-relay-test';

export async function publicRelayTest(url: string, o: { timeoutMs?: number } = {}): Promise<PublicRelayTestResult> {
  const timeout = o.timeoutMs ?? 8000;
  const sk = generateSecretKey(); // throwaway: lives in this function and is never persisted
  const pk = getPublicKey(sk);
  const namespace = `lifeboat/relay-test/${bytesToHex(generateSecretKey()).slice(0, 12)}`; // isolated from the real backup's d tag
  // Shaped like a real backup so the real validation runs on it, but made only of random bytes: no channel data exists in it.
  const dummyPoint = { funding_txid_str: bytesToHex(generateSecretKey()), output_index: 0 };
  const expectedCp = channelSetHash([dummyPoint]);
  const dummy = encodePayload({ v: 1, scb: Buffer.from(generateSecretKey()).toString('base64'), peers: [], cp: expectedCp });
  const ev = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', namespace], ['t', TEST_TAG]], content: nip44.encrypt(dummy, nip44.getConversationKey(sk, pk)) },
    sk,
  );
  const r: PublicRelayTestResult = { url, namespace, throwawayPubkey: pk, eventId: ev.id, published: false, retrieved: false, signatureValid: false, decrypted: false, payloadValid: false, fingerprintValid: false, deletionRequested: false, errors: [] };
  const pool = new SimplePool();
  const filter = { kinds: [KIND], authors: [pk], '#d': [namespace] };
  try {
    let t = Date.now();
    try {
      await Promise.race([Promise.all(pool.publish([url], ev)), new Promise((_, rej) => setTimeout(() => rej(new Error(`publish timed out after ${timeout}ms`)), timeout))]);
      r.published = true;
      r.publishMs = Date.now() - t;
    } catch (e) {
      r.errors.push(`publish: ${String(e instanceof Error ? e.message : e)}`);
      return r;
    }

    t = Date.now();
    const got: Event[] = (await probeRelayFilter(url, filter, timeout)).events;
    const mine = got.find((e) => e.id === ev.id);
    r.retrieved = !!mine;
    r.retrieveMs = Date.now() - t;
    if (!mine) r.errors.push('retrieve: the relay did not return the event that was just published');
    else {
      r.signatureValid = verifyEvent(mine) && mine.pubkey === pk;
      try {
        const plain = nip44.decrypt(mine.content, nip44.getConversationKey(sk, pk));
        r.decrypted = plain === dummy;
        const back = decodePayload(plain);
        r.payloadValid = true;
        r.fingerprintValid = back.cp === expectedCp;
      } catch {
        // stays false: decrypted, payloadValid and fingerprintValid report exactly how far it got
      }
    }

    // cleanup: NIP-09 deletion request for exactly the event and address we created
    const del = finalizeEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [['e', ev.id], ['a', `${KIND}:${pk}:${namespace}`]], content: 'lifeboat public relay test cleanup' }, sk);
    try {
      await Promise.race([Promise.all(pool.publish([url], del)), new Promise((_, rej) => setTimeout(() => rej(new Error('deletion request timed out')), timeout))]);
      r.deletionRequested = true;
      await new Promise((res) => setTimeout(res, 300));
      r.deletionHonored = !(await probeRelayFilter(url, filter, timeout)).events.some((e) => e.id === ev.id);
    } catch (e) {
      r.errors.push(`cleanup: ${String(e instanceof Error ? e.message : e)}`);
    }
    return r;
  } finally {
    pool.close([url]);
  }
}
