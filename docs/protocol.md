# Protocol

## Backup key

```
P   = first curve point with x = sha256("lifeboat/nums/v1/" || i), i = 0,1,2,...   (compressed, 0x02 prefix; discrete log unknown)
S   = lnd.DeriveSharedKey(ephemeral_pubkey = P, key_loc = { family: 1573, index: 0 })   // ECDH inside lnd, 32 bytes
sk  = sha256("lifeboat/nostr-key/v1" || S)                                            // Nostr secret key
```

If `P` had a known discrete log `k`, anyone with the node's public key could compute `S`. The key is re-derived on demand and never stored or exported.

## Event

| Field | Value |
|---|---|
| `kind` | `30078` (NIP-78, addressable: relays keep the newest per pubkey + `d`) |
| `tags` | `[["d", "lifeboat/scb/v1"]]` |
| `created_at` | `max(now, last + 1)`, and at start greater than any event of ours already on the relays |
| `content` | NIP-44 v2 encryption (with padding) of the payload to our own pubkey |

## Payload (JSON, max 65535 bytes)

```json
{ "v": 1, "scb": "<base64 multi-channel backup from lnd>", "peers": ["<pubkey>@<host>:<port>"], "cp": "<hex sha256 of sorted channel points>" }
```

`scb` is already encrypted by LND under a seed-derived key. `peers` are outbound peers that share a channel. `cp` identifies the channel set: LND re-encrypts on every export, so blobs of the same channels never compare equal.

## Reading events (untrusted relays)

Keep only events with `kind == 30078`, `pubkey == ours`, `d == lifeboat/scb/v1` and a valid signature. Collapse duplicates by id and sort newest first (ties: lowest id). Ignore events dated more than 600 s in the future unless nothing else decrypts (then use the newest and flag it). Take the first that NIP-44-decrypts. Anything else is skipped and counted, never fatal. Validate the payload (version, base64, peer syntax, fingerprint) before use.

## Restore

1. Wait for lnd `SERVER_ACTIVE`. 2. Derive the key. 3. Fetch and pick as above. 4. `RestoreChannelBackups(scb)`. 5. For several rounds: dial every peer hint (ignore "already connected"), pause. 6. Report how many channels await their peers' force-close.

## Verify (restore dry run)

Probe every relay, pick the newest valid decryptable event whose payload decodes (an unusable newer event is skipped and reported), then ask lnd to validate the `scb` (`VerifyChanBackup`): lnd decrypts it with the node's own key and lists the channels inside, and that list is compared with the node's current channels. If lnd is not available to the check, `cp` is compared with the hash of the current channel points instead. `ok` requires at least one reachable relay, a decryptable backup that lnd accepts and a match. The verdict is `verified` (ok and no problems), `degraded` (ok, with problems such as a stale or empty relay, foreign events, an unreachable relay, or a future-dated newest event) or `failed` (not ok). Per relay: `healthy`, `stale`, `missing`, `down`.
