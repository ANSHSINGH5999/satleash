# Nostr usage

| Item | Value |
|---|---|
| Event kind | 30078 (NIP-78 application data; addressable, so relays keep the newest per `pubkey` + `d`) |
| `d` tag | `lifeboat/scb/v1` |
| Encryption | NIP-44 v2 to the backup key's own public key, with NIP-44 padding |
| Deletion | NIP-09 (kind 5) is used **only** by the public relay test, never for real backups |
| Client library | `nostr-tools` (`SimplePool`), plus a small `ws` probe for health checks |

## Untrusted relays

A relay's answer is re-validated locally: `kind == 30078`, `pubkey == ours`, `d == lifeboat/scb/v1`, valid signature, then NIP-44 decryption and payload validation. Anything else is skipped and counted (shown as "foreign events", never fatal). `nostr-tools` also filters some of this itself, so the local checks are tested directly as well (`nostr.test.ts`).

## Which event wins

1. Collapse duplicates by event id.
2. Sort newest first (ties: lowest id).
3. Skip events dated more than 600 s ahead of now (`FUTURE_SKEW_SEC`) **unless** nothing else decrypts; then use the newest such event but flag it (`futureDated`, and verification reports "dated in the future").
4. Take the first that decrypts and decodes.

New events are dated `max(now, last + 1)`, and at startup after the newest event of ours already on the relays, so a leftover future-dated event cannot shadow new backups.

## Freshness and consistency

Per relay, verification classifies: `healthy` (holds the newest event), `stale` (holds an older one), `missing` (reachable, holds none), `down` (unreachable). A backup can be `verified` only if it matches the node's current channel set (compared by fingerprint, because LND re-encrypts the blob on every export). If the relays are behind the node, the monitor republishes on its own.

## Publishing

Each publish returns a per-relay result. Success on at least one relay is `SUCCESS` if all accepted, `DEGRADED` if only some did; all failing is `FAILED` and retried with backoff (5 s, 15 s, 60 s, then every 5 min, each with ±20 % jitter). Payloads above the NIP-44 limit fail with an explicit message (about 200 channels).

## What a relay can and cannot learn

It sees the backup public key, when you publish, roughly how large the backup is (padding buckets), and your IP unless you use Tor or a proxy (not built in). It cannot read channel data.
