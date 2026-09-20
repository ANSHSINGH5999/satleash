# Product positioning

## One line

Seed-only Lightning channel recovery over Nostr (the seed is the only secret; a known relay URL locates the backup): back up your LND channel state to relays, check it against your node, and rehearse the restore.

## Problem

An LND node's channel state lives on one machine. Static channel backups exist, but they are a file that has to be copied somewhere current, and guides commonly have the operator do that with a script or by hand. If the disk dies and the copy is stale or missing, the money in channels depends on peers that nobody can ask.

## Solution

A small daemon publishes every backup change to several Nostr relays as one encrypted event. The key that signs and encrypts it is derived from the wallet seed inside LND, so a node recreated from the same 24 words finds its backup again. A verification checks the relay copy against the node (LND itself decrypts it) and a regtest drill wipes a node and restores it for real.

## Why now

The sources found describe peer storage for Core Lightning and Eclair and paid or vendor backup services elsewhere; none of them was found to cover a stock LND node operator who wants no account and no vendor. Nostr relays are cheap, plentiful and already used for application data (NIP-78). (Inference from searches, not a market claim.)

## Technical innovation

1. Nostr key derived from the seed through LND's signer (`DeriveSharedKey` against an unknown-log point): no extra secret.
2. Change detection and matching by channel-set fingerprint, because LND re-encrypts the blob on every export.
3. Peer hints inside the encrypted payload plus repeated redials, because LND's own restore dials once and can lose the race with several channels to one peer (found in a real drill).
4. Per-relay verification (healthy, stale, missing, down) with `VerifyChanBackup` on the relay copy.
5. Relay data is never trusted: author, kind, tag, signature, payload and channel set are re-checked locally.

## Security model

Backup payloads are encrypted (NIP-44 with padding) before they reach a relay; relay events are independently validated before restore or verification. The daemon runs with a read-only macaroon that LND confirms cannot spend. The console is loopback-only with token, Host and Origin checks and a nonce CSP. Details and residual risks: `security.md`, `threat-model.md`. Relays still see when a key publishes, roughly how large the backup is, and your IP.

## Key differentiator

Recovery depends only on the seed and on any one relay that still holds the newest event; and the operator can check that before the disaster.

## Target user

Self-hosted LND operators (home nodes, RaspiBolt / MiniBolt / Umbrel / Start9 style setups) who today rely on a copied `channel.backup`.

## Demo story (2 to 3 minutes)

Two channels, a backup published to two relays, verification (LND accepts the copy), the node is wiped, one relay is switched off, the node is recreated from the seed, the restore runs, funds return on-chain, with measured timings and fees.

## Limitations

Channels close on restore; peers must be online; about 200 channels per backup; LND only; regtest-verified; public relay retention unmeasured; testnet and mainnet not run.
