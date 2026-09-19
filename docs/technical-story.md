# Technical story

Why the important decisions are the way they are. Each one came from a specific failure, a specific limit, or a specific threat; where a real run found the problem, that is said.

## 1. Encrypted blobs are never compared directly

LND re-encrypts the static channel backup with a fresh nonce on every export, so two exports of the same channels are different bytes. The first version compared blobs: it published duplicates and verification could **never succeed on a real node**. It only showed up against real LND, because the fake used in early tests returned the same bytes each time. Lifeboat now compares by **channel set**.

## 2. Fingerprints exist for that reason

`cp` is the SHA-256 of the sorted channel points. It decides "did anything change" (publish or not) and "does the relay copy match the node". Since 2026-09-19 verification goes one step further: LND's `VerifyChanBackup` decrypts the relay copy with the node's own key and returns the channels really inside it, and *that* list is compared with the node. The self-declared `cp` is then only a convenience, not the source of truth.

## 3. Relays are untrusted

A relay may ignore your filter, return other people's events, replay old ones, or send garbage. So author, kind, `d` tag, signature, payload shape and channel set are all re-checked locally, and anything that fails is skipped and counted, never fatal. This is tested against a scripted hostile relay (junk frames, `null` frames, malformed and huge events, wrong kind/author/tag/signature, duplicates, stale and future-dated events). Writing those tests found two real crashes: the probe threw on a `null` frame, and `isOwnValid` threw on an event whose `tags` was not an array.

## 4. Several relays

A single relay can lose or withhold the backup. Publishing goes to every enabled relay and reports per-relay results; restore accepts any one that still holds the newest usable event. The drill switches one of two relays off during the restore and still recovers. Verification reports each relay as healthy, stale, missing or down, and a verified verdict needs full redundancy (an unreachable relay makes it *degraded*).

## 5. Local validation decides what is true

The relay's answer is input, never a verdict. The rule set (newest usable event, not more than ten minutes in the future unless nothing else exists, unusable payloads skipped in favour of an older good one) lives in one function (`pickNewestDecryptable`), so restore and verification cannot disagree.

## 6. Least-privilege macaroons

The daemon does not need to spend, so it does not get to. It runs with read-only permissions plus `signer:generate` (for the key) and `macaroon:read`; the restore macaroon adds import and dial. The claim "cannot spend" is not taken from what was requested: LND is asked with the baked macaroon, and the e2e test confirms send and new-address calls are denied.

## 7. The Nostr key comes from the seed

Restore has to work when the only surviving secret is the 24 words. The key is derived by LND's signer (`DeriveSharedKey` against a point whose discrete log nobody knows), so it never leaves LND and needs no extra secret. The e2e test proves the same key comes back after a full wipe.

## 8. Peer hints and repeated redials

The first drill **failed**: LND's restore dials a peer once, and with two channels to the same peer that single attempt was torn down mid-handshake, so nobody force-closed. Peer hints are stored inside the encrypted payload and the restore redials in rounds. The roughly 15 s "redial" stage in the timings is that schedule (5 rounds of 3 s), not measured work.

## 9. No persistence

There is no database. State that matters is on the relays; everything else (history, relay health, logs) is rebuilt from LND and the relays. That removes a whole class of stale-state bugs and a place to leak secrets. The cost: relay edits in the console are session-only and there is no "last drill" history across restarts.

## 10. Verification is separate from backup

A backup that was published is not a backup that works. Publishing answers "did a relay accept it"; verification answers "can it be found, is it authentic, does LND accept it, does it cover today's channels, on how many relays". They run on different schedules (publish on change, verify every 60 s and after every publish) and can disagree; when they do (relays behind the node) the monitor republishes on its own. The drill is the third layer: it proves the restore end to end, on regtest.

## 11. Explicit state machine, jittered retries

`IDLE → BACKING_UP → ENCRYPTING → PUBLISHING → SUCCESS | DEGRADED | FAILED`, with `VERIFYING` and `RECOVERING`. Impossible transitions are refused and surface as a failed security check. Retries back off (5 s, 15 s, 60 s, 5 min) with ±20 % jitter so several instances do not retry in lockstep. A failed `start()` leaves the service stopped and retryable; a second `start()` is a no-op (a found bug: double timers and a double LND subscription).

## 12. The LND stream idle timeout

Found only by running the live playground: the request timeout killed the long-lived backup stream every ~33 s and the dashboard flapped to "Degraded". Streams now have no idle timeout, with keepalive, and the monitor republishes if the relays fall behind.

## 13. Honest scope

Static channel backups close channels on restore. Dynamic approaches (peer storage, VSS, `cldcb`) can keep them; Lifeboat does not try. It is LND-only, regtest-verified, and the public relay results are one-shot observations.
