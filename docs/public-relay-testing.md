# Public relay testing

Lifeboat treats relays as untrusted, so it must be checked against relays it does not control. This is done with a **relay test** that never touches a real backup, plus a read-only adversarial check.

## What the relay test does

`npm run cli -- relay-test <wss-url> --yes` (or the console's Relays tab, which requires a checkbox first):

1. Generates a **throwaway secret key** in memory. It is never written to disk and is unrelated to the node.
2. Builds a dummy payload shaped like a real backup (`{v, scb, peers, cp}`) but made only of random bytes, with the fingerprint recomputed from one random dummy channel point. It contains no channel data.
3. Signs one addressable event (kind 30078) in an isolated namespace, `d = lifeboat/relay-test/<random>` (never `lifeboat/scb/v1`), NIP-44 encrypted to the throwaway key.
4. Publishes it, reads it back, verifies the signature, decrypts it, runs the real payload validation on it and checks the fingerprint.
5. Publishes a NIP-09 deletion request for exactly that event and checks whether the relay still serves it (the cleanup procedure).

No lnd, seed, macaroon or real backup is involved, and the command refuses to run without `--yes`.

## Results

### Run 1, 2026-09-19 morning (first version of the test: signature and decryption only)

| Relay | Published | Read back | Signature | Decrypted | Deletion honored | Notes |
|---|---|---|---|---|---|---|
| `wss://nos.lol` | yes (1.2 s) | yes (1.0 s) | valid | yes | yes | full pass |
| `wss://relay.primal.net` | yes (1.8 s) | yes (1.3 s) | valid | yes | yes | full pass |
| `wss://relay.damus.io` | yes on the third attempt (2.0 s) | **no** | n/a | n/a | not meaningful | first two attempts `connection failed`; the third accepted the event but did not serve it |
| `wss://relay.nostr.band` | no | no | n/a | n/a | n/a | `connection timed out` (one attempt) |

### Run 2, 2026-09-19 afternoon (current test: adds payload and fingerprint validation)

| Relay | Published | Read back | Signature | Decrypted | Payload valid | Fingerprint valid | Deletion honored |
|---|---|---|---|---|---|---|---|
| `wss://nos.lol` | yes (0.87 s) | yes (0.76 s) | valid | yes | yes | yes | yes |
| `wss://relay.primal.net` | yes (2.16 s) | yes (1.16 s) | valid | yes | yes | yes | yes |
| `wss://relay.damus.io` | yes (1.90 s) | yes (1.66 s) | valid | yes | yes | yes | yes |

Reading these together: damus failed or dropped the read-back in run 1 and passed in run 2, so its behaviour is **intermittent** (connection throttling or replication lag are the likely explanations, neither confirmed; a raw WebSocket to damus connected fine while some pool connections failed in a rapid series). nostr.band was not retried after its single timeout. Every relay that was tested at least once passed on some attempt; none passed on every attempt that was made against it. One-shot tests say nothing about retention over days.

### Adversarial read (2026-09-19, read-only, no publishing)

The client was pointed at real public traffic: `REQ kinds:[30078] limit:300` against two public relays, with a fresh random identity.

| Relay | Events returned | Bytes | Treated as ours | Selected backup | Crash |
|---|---|---|---|---|---|
| `wss://relay.primal.net` | 300 (all kind 30078, other people's application data) | 7.4 MB | 0 | none | no |
| `wss://nos.lol` | 114 before the 10 s probe timeout | 0.58 MB | 0 | none | no |

Real-world unrelated events pass through the same validation as a real restore and none is accepted. What a public relay *cannot* be made to do is act hostile on demand, so hostile behaviour is tested against a scripted relay instead (`src/hostile.test.ts`): garbage frames, malformed and huge events, wrong kind, author, tag and signature, duplicates, stale and future-dated events, extra fields, unusable payloads, disconnects and reconnects.

## Everything that was published

Only dummy events from throwaway keys, in their own namespaces, each followed by a NIP-09 deletion request. Where deletion was not honored the leftover is encrypted random data. Nothing else was left on any relay. No real backup, key or node data was ever sent to a public relay.

## Rules for anyone repeating this

- Use only the relay test. Never publish a real backup to a public relay to "see if it works".
- One event per relay per run; do not loop it (relays throttle, and it is impolite).
- The test proves a relay accepts, serves and (optionally) deletes an event. It does not prove the relay will keep a backup for months. Retention needs a soak test (not done).
