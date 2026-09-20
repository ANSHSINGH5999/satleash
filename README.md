# Lifeboat

**Lifeboat is a TypeScript daemon and console that lets a self-hosted LND operator recover channel funds from the 24-word seed and a known relay URL, with no other secret or key file, by publishing encrypted static channel backups to Nostr relays and verifying them against the live node before they are needed.**

Built for BOSS Battle (Bitshala). Status: verified on regtest with real LND nodes; testnet and mainnet were not run. See [Limitations](#limitations).

![Lifeboat recovery drill result](screenshots/08-recovered-state.png)

## Problem

An LND node's channel state lives on one machine. The static channel backup (SCB) that protects it is a file someone has to keep copying, and it often sits on the machine that just died. If the copy is stale or missing, the money in channels depends on peers, and nothing tells you how to get it back.

## Solution

A small daemon publishes every backup change to several Nostr relays as one encrypted, addressable event. The key that signs and encrypts it is derived from the wallet seed inside LND, so a node recreated from the same 24 words finds its own backup again. "Seed-only" means the seed is the only secret required: no separate Lifeboat key, backup secret or key file. It is not the only input: the encrypted backup lives on the relays, so you also need the URL of at least one relay that still holds it. Relay URLs are not derived from the seed; keep them with the seed (they are not secret). A verification step checks the relay copy against the live node, and a drill wipes a regtest node and restores it for real.

## Why Lifeboat

- **The seed is the only secret required.** No cloud account, no vendor, no second secret; a known relay URL locates the backup.
- **Relays are untrusted.** Every event is re-validated locally; several relays are used; one can be gone.
- **You can check before the disaster.** Verification asks LND itself to decrypt the relay copy and compares the channels inside with the node's, per relay.
- **The restore is rehearsed on real LND nodes**, with measured time, sats and fees.

How it differs from scripts, vendor backups and peer storage: [docs/differentiation.md](docs/differentiation.md). No "first" or "only" claim is made.

## Architecture

![Architecture and trust boundaries](docs/diagrams/architecture.svg)

Trusted: your machine (LND, the seed-derived key, local validation). Untrusted: relays and the network. More: [architecture](docs/architecture.md), [protocol](docs/protocol.md), [nostr](docs/nostr.md), [technical story](docs/technical-story.md).

## How it works

1. **Back up.** The daemon watches LND's channel-backup stream. On every change it builds `{v, scb, peers, cp}` and encrypts it with NIP-44 to a Nostr key derived from the seed (`DeriveSharedKey` through LND's signer).
2. **Publish.** One kind-30078 event (`d = lifeboat/scb/v1`) goes to every enabled relay; relays keep the newest per key.
3. **Verify.** Fetch from every relay, keep only valid events by our key, ask LND to decrypt the newest usable copy, compare its channels with the node's. Verdicts: `verified`, `degraded`, `failed`; per relay: `healthy`, `stale`, `missing`, `down`.
4. **Restore.** A new LND created from the same seed re-derives the key, fetches, validates, imports the backup and redials the peers until they force-close. Funds return on-chain.

## Security model

Backup payloads are encrypted before relay publication, and relay events are independently validated (author, kind, tag, signature, payload, channel set) before restore or verification. The daemon runs with a read-only macaroon that LND confirms cannot spend; LND traffic is TLS-pinned; the console is loopback-only with token, Host and Origin checks and a nonce CSP; logs redact credentials; mainnet is refused unless explicitly allowed. What it does *not* protect against (compromised host, stolen seed, relay metadata, all relays withholding) is in [docs/security-architecture.md](docs/security-architecture.md) and the [threat model](docs/threat-model.md).

## Recovery drill

`npm run demo` (or the button on the landing page) creates a throwaway regtest network with two LND nodes and two relays, opens two channels, publishes the backup, verifies it, deletes the node, switches one relay off, restores from the seed and the relays and waits for funds. Latest recorded run (2026-09-20, the output shown on the landing page): 1,492,866 of 1,493,060 channel sats recovered on-chain, 194 sats in fees, ~40 s total (39.33 s) and ~24 s from wipe to funds back (24.226 s), with one of two relays switched off during the restore. Timings vary per run (roughly 36 to 41 s observed) and are not a guarantee; the page shows the numbers of the run you start. About 15 s of the recovery is a fixed redial schedule, not measured work. Details: [recovery](docs/recovery.md).

## Features

- Backup daemon with a state machine, jittered retry, resubscribe, periodic refresh and self-healing republish
- Verification per relay with LND's `VerifyChanBackup`
- CLI: `pubkey`, `backup`, `verify`, `restore`, `bake`, `relay-test`
- Console (`/console`, 8 tabs): dashboard, backup, verify, relays, node, security, activity, settings
- Least-privilege macaroon baking, confirmed by LND
- Landing page with a live regtest drill; regtest playground with a live node
- `demo:check` (prints `READY` only when every component answered) and `demo:reset` (deletes `<repo>/data` only)

Classification of what is core, stable, optional and experimental: [docs/feature-freeze.md](docs/feature-freeze.md). Test evidence: [docs/test-matrix.md](docs/test-matrix.md).

## Technical stack

TypeScript (Node 22+), LND 0.20 REST, `nostr-tools` (NIP-44, NIP-78), `@noble/curves`, `@noble/hashes`, `ws`. Frontend: two static HTML pages, inline JS, nonce CSP, no framework. Tests: `node:test` via `tsx`, headless Chrome over the DevTools protocol, real-LND e2e. Regtest: Docker (`bitcoind` 30, `lnd` 0.20.0-beta).

## Installation

### Prerequisites

| Needed for | Requirement |
|---|---|
| Everything | Node.js 22 or newer (developed on Node 26; Node 22.23.2 was validated locally, 161 / 161 tests and 46 / 46 e2e) and npm |
| `npm run check` | Nothing else. No Docker, no network |
| Browser tests inside `npm run check` | Chrome or Chromium in a usual location, or `CHROME_PATH`; without one those 13 tests are skipped |
| `web` (live drill), `playground`, `demo`, `e2e` | Docker with a running daemon (Docker Desktop or the docker service). The first run pulls `polarlightning/lnd:0.20.0-beta` and `polarlightning/bitcoind:30.0` |
| The same | The repository must be in a folder Docker can bind-mount (on Docker Desktop, a folder under your home directory), because the regtest nodes write into `<repo>/data` |
| The same | Ports 7777, 7778 (relays) and 8080 (page) free, plus 8081, 8082 and 18443 for the Docker containers, all on 127.0.0.1 |

Without Docker, `npm run demo` and `npm run playground` stop within 15 s with one line, `prerequisite failed: Docker daemon: not reachable: start Docker Desktop or the docker service`; the landing page's drill button answers "Docker isn't running" (HTTP 503); `npm run demo:reset` says the containers were not touched. None of them hangs or prints a stack trace (tested).

```bash
git clone https://github.com/ANSHSINGH5999/lifeboat.git lifeboat && cd lifeboat
npm install
npm run check          # typecheck + 161 unit and browser tests
```

`npm run check` needs no Docker. Chrome is found automatically on macOS and Linux; set `CHROME_PATH` otherwise (browser tests are skipped if none is found).

### Repository layout

```
src/            TypeScript source; each module has its <name>.test.ts beside it
web/            the two static pages (landing + drill, console)
scripts/        screenshot capture tool
docs/           architecture, protocol, security, threat model, testing, positioning, checklists
submission/     Devfolio copy and links to the maintained documents
screenshots/    real screenshots of the running application
.github/        CI workflow
```

## Development

```bash
npm run web                          # landing page + live drill on http://127.0.0.1:8080 (needs Docker)
npm run playground                   # regtest network + console at http://127.0.0.1:8080/console (Ctrl-C tears it down)
npm run playground:open -- 250000    # open another channel and watch the backup follow (playground must be running)
npm run demo                         # the disaster drill in the terminal
npm run demo:check                   # READY only if the running playground answers on every component
npm run demo:reset                   # remove regtest containers and <repo>/data (nothing else)
npm run typecheck
```

Against your own node (regtest first):

```bash
export LND_DIR=~/.lnd          # your lnd data directory; the paths below use the regtest folder
LND_CERT=$LND_DIR/tls.cert LND_MACAROON=$LND_DIR/data/chain/bitcoin/regtest/admin.macaroon npm run cli -- bake --out monitor.macaroon
LND_CERT=$LND_DIR/tls.cert LND_MACAROON=monitor.macaroon RELAYS=wss://relay-one.example,wss://relay-two.example npm run daemon
LND_CERT=$LND_DIR/tls.cert LND_MACAROON=monitor.macaroon RELAYS=wss://relay-one.example,wss://relay-two.example npm run cli -- verify
```

The CLI prints a command's result on stdout (`verify` prints pure JSON, `pubkey` the 64-hex key) and its log lines on stderr, so `npm run -s cli -- verify > result.json` and `KEY=$(npm run -s cli -- pubkey)` work (`-s` hides npm's own `> lifeboat@0.1.0 cli` banner, which npm prints on stdout otherwise). Variables are listed in [.env.example](.env.example). There is no build step and no lint script; `npm run typecheck` is the compile check.

## Testing

```bash
npm run check    # typecheck + 161 tests (no Docker)
npm run e2e      # 46 checks against real LND nodes on regtest (Docker; 46 s on the QA machine with the images already pulled, longer the first time)
npm audit        # 0 vulnerabilities on 2026-09-19
```

CI is written (`.github/workflows/ci.yml`): `npm ci`, `npm audit` and `npm run check` on Node 22. The run on commit `0cb7a92` (run 35503145035, Node 22.23.2) succeeded: 161/161 tests, 0 vulnerabilities. Earlier runs (commits `346215c` and `0127152`) were red and were fixed. `npm run e2e` needs Docker and is not part of the workflow; it passed locally, 46/46, on Node 22.23.2 and 26.7.0. See [docs/testing.md](docs/testing.md).

## Regtest demo

Live landing page: https://boss-battle-psi.vercel.app. It is a hosted static page that documents the project and shows a recorded run of the drill; its "Run recovery drill" button is disabled there. The recovery drill itself runs locally with Docker and a disposable regtest network, with no real funds; the hosted page does not provide an LND or recovery environment.

`npm run web`, open `http://127.0.0.1:8080/`, press **Run recovery drill**. Script with timings: [docs/demo-script.md](docs/demo-script.md). The regtest network is disposable: `npm run demo:reset` clears it.

## Testnet

**Not tested.** Labels (REGTEST, TESTNET, TESTNET4, SIGNET, MAINNET), the `LIFEBOAT_NETWORK` expected-network guard and the mainnet refusal (`LIFEBOAT_ALLOW_MAINNET=1` needed) are unit-tested against a stubbed node only. Checklist: [docs/testnet-checklist.md](docs/testnet-checklist.md).

## Public relay test

`npm run cli -- relay-test wss://relay.example --yes` publishes one dummy event, signed by a throwaway key in its own namespace and shaped like a backup but made of random bytes, reads it back, validates it, and asks the relay to delete it. It never touches your node or a real backup. One-shot results on four public relays (nos.lol and relay.primal.net passed both runs, relay.damus.io was intermittent, relay.nostr.band timed out once and was not retried) are in [docs/public-relay-testing.md](docs/public-relay-testing.md). Retention over time is unmeasured.

## Threat model

[docs/threat-model.md](docs/threat-model.md) (18 actors, each with a mitigation, a test and the residual risk) and [docs/security-architecture.md](docs/security-architecture.md).

## Limitations

- **Restore closes your channels.** Funds return on-chain; channel state does not come back.
- **Peers must be online** to force-close.
- **About 200 channels per backup** (NIP-44's 64 KB plaintext limit; no chunking).
- **Relay addresses are not in the seed.** Restore needs the 24 words and the URL of at least one relay that still holds the backup; Lifeboat has no default relay.
- **Relays can withhold or serve stale data.** Use at least two independent relays; `verify` shows divergence. Public relay durability is unmeasured.
- **Regtest-verified only.** Testnet and mainnet were not run.
- **LND only**, and only LND 0.20 was used.
- **Verified in Chrome only**; Firefox and Safari were not tested.
- **Accessibility is only partly checked.** The hero button text was changed to dark (`#111827` on `#e8702a`, 5.73:1; 4.62:1 on hover) after a contrast check, and the listed text-colour pairs reach 4.5:1 ([docs/landing-design.md](docs/landing-design.md)). No full WCAG audit was run and no conformance is claimed.
- **License:** MIT, see [LICENSE](LICENSE).

## BOSS Battle track

Intended track (not yet submitted): **Freedom Stack**: Nostr as storage and identity for a system whose useful property does not depend on trusting whoever operates it. Honest gap: no ecash. Cypherpunk and Machine Money are weak fits and not claimed. Reasoning: [docs/boss-battle-positioning.md](docs/boss-battle-positioning.md).

## Demo

Two to three minutes, one screen: [docs/demo-script.md](docs/demo-script.md). Screenshots: [docs/screenshots.md](docs/screenshots.md). Video plan: [docs/video-script.md](docs/video-script.md).

## Project status

[FINAL_PROJECT_STATUS.md](FINAL_PROJECT_STATUS.md): what was verified, bugs found and fixed, known limitations and exact next actions. Submission package: [submission/](submission/README-SUBMISSION.md).
