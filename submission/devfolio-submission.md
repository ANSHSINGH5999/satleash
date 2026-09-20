# Devfolio submission copy (draft, NOT submitted)

Numbers marked (measured) come from runs recorded in `FINAL_PROJECT_STATUS.md`. Re-check them against the final take before pasting.

## Project name

Lifeboat

## Tagline

Seed-only recovery for LND channel funds, over Nostr.

## Short description

Lifeboat backs up a Lightning node's channel state to Nostr relays as encrypted events, checks that backup against the live node, and restores it from the 24-word seed, with no other secret or file. Demonstrated on regtest with real LND nodes.

## Problem

An LND node's channel state lives on one machine. The static channel backup that protects it is a file someone has to keep copying, and it often sits on the machine that just died. If the copy is stale or missing, the money in channels depends on peers.

## Solution

A small daemon publishes every backup change to several Nostr relays as one encrypted, addressable event. The signing and encryption key is derived from the wallet seed inside LND, so a node recreated from the same 24 words finds its backup again. A verification step checks the relay copy against the live node, and a regtest drill wipes a node and restores it for real.

## Key features

- Automatic publication on every channel change, with a state machine, jittered retries and self-healing republish
- Seed-only recovery: no account, no vendor, no second secret
- Verification per relay (healthy, stale, missing, down) in which LND itself decrypts the relay copy and lists its channels
- Untrusted-relay handling: every event re-validated locally, tested against a hostile scripted relay
- Least-privilege macaroons confirmed by LND; mainnet refused by default
- Console with recovery-readiness evidence, security checks and relay management; loopback-only
- A one-click regtest recovery drill on the landing page, with measured timings

## How it works

1. The daemon subscribes to LND's channel-backup stream and, on each change, builds `{v, scb, peers, cp}` (the LND backup, peer hints, a fingerprint of the channel set).
2. It encrypts that with NIP-44 to a Nostr key derived from the seed through LND's signer, and publishes it as kind 30078 (`d = lifeboat/scb/v1`) to every enabled relay.
3. Verification fetches from every relay, keeps only valid events by our key, asks LND to decrypt the newest usable copy, and compares the channels inside with the node's.
4. After a disaster, a new LND from the same seed re-derives the key, fetches, validates, restores, and redials the peers until they force-close. Funds return on-chain.

## Technical innovation

- Nostr identity derived from the seed through the LND signer (`DeriveSharedKey` against an unknown-discrete-log point)
- Change detection and matching by channel-set fingerprint, because LND re-encrypts the blob on every export (found by running against real LND)
- Peer hints inside the encrypted payload plus repeated redials, because LND's own restore dials once (found in the first real drill)
- Per-relay verification with LND's own `VerifyChanBackup` as the authority on what the relay copy contains
- A restore drill on real LND nodes with one of two relays switched off, timed step by step

## Security

Backup payloads are encrypted before relay publication and relay events are independently validated before restore or verification. The daemon uses a read-only macaroon that LND confirms cannot spend; LND traffic is TLS-pinned; the console is loopback-only with token, Host and Origin checks and a nonce CSP; logs redact credentials. Details and non-goals: `docs/security-architecture.md`.

## Why it is different

Lifeboat's differentiation is the combination: seed-only recovery, untrusted relays as storage, verification of the relay copy against the live node, and an automated restore drill, for a stock LND node with no account or vendor. Existing approaches (scripts to Dropbox or GitHub, vendor backups, peer storage and VSS for other stacks) and their limits are in `docs/differentiation.md` and `docs/competitive-analysis.md`. No "first" or "only" claim is made.

## Track fit

**Freedom Stack**: Nostr as storage and identity for a system whose useful property (recovery) does not depend on trusting a vendor or the relays. Honest gap: no ecash. Cypherpunk and Machine Money are weak fits and are not claimed. See `docs/boss-battle-positioning.md`.

## Demo instructions

```bash
git clone [GitHub URL — TO BE ADDED] && cd lifeboat
npm install
npm run check          # typecheck + tests
npm run web            # open http://127.0.0.1:8080/ and press "Run recovery drill" (needs Docker)
```

Optional live-node console: `npm run playground`, open `/console`, and `npm run playground:open -- 250000` in a second terminal. Full script: `docs/demo-script.md`.

## Tech stack

TypeScript (Node 22+), LND 0.20 REST, `nostr-tools` (NIP-44, NIP-78), `@noble/curves` and `@noble/hashes`, `ws`, static HTML with a nonce CSP, Docker (regtest), `node:test` with headless Chrome over the DevTools protocol.

## Known limitations

- A restore closes channels: funds return on-chain and peers must be online to force-close
- Recovery needs the seed and the URL of at least one relay that still holds the backup; relay URLs are not derived from the seed
- About 200 channels per backup (NIP-44's 64 KB limit; no chunking)
- LND only; regtest-verified; testnet and mainnet were not run
- Public relays were tested only with a one-shot dummy-event test (results were intermittent on one relay); retention over time is unmeasured
- Verified in Chrome only

## Future roadmap

Chunked backups for large nodes; a multi-week public-relay retention test; a testnet run using `docs/testnet-checklist.md`; Tor/proxy support for relay connections; self-hosted fonts; other Lightning implementations.

## Demo URL

[Demo URL — NOT HOSTED] The demo runs locally (`npm run web`); nothing is deployed.

## Repository

[GitHub URL — TO BE ADDED] (no repository exists yet; waiting for the owner's approval)

## Video

[Video URL — TO BE ADDED] (not recorded or uploaded; see `docs/video-script.md`)

## Evidence (measured)

- Recovery drill, 2026-09-20 (final local QA): 1,492,866 of 1,493,060 channel sats recovered on-chain, 194 sats in fees, 36.4 s for the whole drill (23.9 s from wipe to funds back), with one of two relays switched off during the restore
- Tests: 161 unit, integration and browser tests pass; 46 real-LND end-to-end checks pass; `npm audit` reports 0 vulnerabilities
