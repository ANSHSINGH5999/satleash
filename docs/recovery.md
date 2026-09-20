# Recovery

## What recovery does

Restore imports the newest valid backup into a **new LND created from the same 24-word seed**, then waits for the peers to force-close. Funds come back on-chain; the channels themselves do not survive. That is LND's Static Channel Backup design (data-loss protection), not something Lifeboat can change.

## Steps

1. Create a new node from the seed (`lncli create`, existing seed). Wait for it to sync.
2. Bake a restore macaroon from an admin macaroon: `npm run cli -- bake --restore --out restore.macaroon`.
3. `LND_CERT=$LND_DIR/tls.cert LND_MACAROON=restore.macaroon RELAYS=wss://relay-one.example,wss://relay-two.example npm run cli -- restore` (use your own relays and lnd directory).
4. Keep the node running and online. Peers force-close once they see the request; funds arrive after the closes confirm (timelocks apply).

Internally: wait for `SERVER_ACTIVE`, derive the backup key through LND, pick the newest valid decryptable event across relays, validate the payload, `RestoreChannelBackups`, then redial the peer hints for several rounds (LND's own single dial can be torn down mid-handshake when there are several channels to one peer).

## Measured (regtest drill, 2026-09-18/19)

Two channels, 1,493,060 sats: 1,492,866 recovered on-chain, 194 sats in fees. About 36 to 41 s for the whole drill (36.4 s in the 2026-09-20 QA run) (fresh network, two channels, backup, wipe, restore, wait for funds). The drill prints its own timings (`discoverMs`, `importMs`, `recoveryMs`, `totalMs`); the e2e suite also restored 3 channels using only the restricted restore macaroon.

## What can go wrong

| Situation | Effect |
|---|---|
| A peer is offline | Its channel funds wait until it is back |
| A peer refuses to force-close | Funds stay locked. Inherent to SCB |
| Backup older than a channel you opened | That channel is not in it. `verify` shows "behind the node" beforehand |
| Every relay lost the event | Nothing to restore. Use two or more independent relays |
| Seed lost | Nothing can be done: the seed is also the decryption root |

## Practice it

Run `npm run demo` (a full wipe-and-restore on regtest) or the landing page's drill, and `verify` regularly on a real node. Only restore drills on regtest have been run; see `testnet-checklist.md` for the untested step up.
