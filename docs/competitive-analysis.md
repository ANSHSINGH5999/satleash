# Competitive analysis

**Method.** Web searches on 2026-09-19 (LND docs, Bitcoin Optech, Core Lightning, ZEUS, Alby, LDK, Umbrel/Start9 community pages, GitHub), the Devfolio project search that backs the `assessProject` tool (three queries; it returned the Devfolio results below), and the BOSS Battle gallery names supplied earlier. Pages were read through search summaries, not always in full, and "what it does" below is what those sources state. **A search that finds nothing is not proof that nothing exists**, and no claim here says "first" or "only".

## Adjacent projects

| Project | URL | What it does | Technology | Overlap with Lifeboat | Where Lifeboat differs | Potential concern for Lifeboat |
|---|---|---|---|---|---|---|
| LND Static Channel Backup + `VerifyChanBackup` | https://github.com/lightningnetwork/lnd/blob/master/docs/recovery.md | The base mechanism: an encrypted `channel.backup` (or RPC export/subscribe) that lets a node restored from the same seed ask peers to force-close. `VerifyChanBackup` checks a blob decrypts with the node's key | LND, aezeed-derived key | Lifeboat *is* SCB, transported and checked differently. It now calls `VerifyChanBackup` on the relay copy | Moves the backup off the machine to relays automatically; checks the *relay copy* against the node's current channel set; runs a wipe-and-restore drill | Inherits SCB's limits: channels close, peers must cooperate |
| MiniBolt / RaspiBolt channel-backup guides | https://github.com/minibolt-guide/minibolt/blob/main/lightning/channel-backup.md | Shell script watches `channel.backup`, saves timestamped copies locally or to a private GitHub repo (systemd service) | bash, systemd, git | Same goal: keep a fresh SCB off the node | No GitHub account or repo, no manual setup, integrity and freshness checked against the node | These guides are what operators actually follow; Lifeboat has to be easier than a script |
| `lnd-channel-remote-backup` | https://github.com/andgohq/lnd-channel-remote-backup | Uploads changed `channel.backup` to Dropbox | Node script, Dropbox API | Same goal | Cloud account not needed; verification | None beyond the general "a script is enough" |
| Umbrel built-in backup | https://community.umbrel.com/t/lightning-backups/5321 (community thread, reported) | Reported to back up encrypted SCBs to Umbrel's servers | Vendor infrastructure | Same goal | No vendor in the loop | Only relevant to Umbrel users |
| ZEUS embedded node (Olympus) | https://docs.zeusln.app/for-users/local-wallets/embedded-lnd/backup-and-recovery | Embedded-node channels backed up to the Olympus server, encrypted with the wallet seed | Vendor server | Seed-encrypted, off-device backup | Any LND node; relays not one vendor | Mobile-wallet users are served already |
| `cldcb` (ZmnSCPxj) | https://github.com/ZmnSCPxj/cldcb | Dynamic remote channel backup for Core Lightning: server, plugin, client; data encrypted so only the node can read it; recovery needs `hsm_secret` and the backup | Core Lightning plugin, SQLite, own server | Off-machine encrypted channel backup with untrusted storage | LND, Nostr relays instead of a dedicated server, seed-only key | Dynamic backups keep channel state, which SCBs cannot |
| `ln-health` | https://github.com/shadowbipnode/ln-health | Scores node health 0–100; its "backup verification" reads the backup file's existence, size and modification time | Python, LND and Core Lightning | Both report on backup status | Lifeboat checks restorability evidence: authentic, lnd-decryptable, matches current channels | A judge may see "monitoring" as crowded |
| Peer storage (CLN #5361, Eclair #2888, BOLTs #1110 per Bitcoin Optech) | https://bitcoinops.org/en/topics/peer-storage/ | Peers store a small encrypted blob for you and return it on reconnect | Protocol-level, in implementations | Same problem, no third party | Works today on stock LND; not protocol-dependent | Peer storage can keep channels alive; it is the long-term answer where implemented |
| Phoenix | https://medium.com/@ACINQ/phoenix-wallet-part-3-backup-f63a9470d4e7 | Sends encrypted channel data to its peer on each update; reinstall with the seed | Eclair, one LSP | Seed-only recovery | Node operators using LND | Better UX, wallet-specific |
| Alby Hub VSS (Alby Pro) | https://guides.getalby.com/user-guide/alby-hub/backups-and-recover | Continuous versioned backups of channel state; paid | Vendor service | Seed plus account recovery | No subscription; SCB only | Keeps channels; Lifeboat does not |
| LDK `vss-server` | https://github.com/lightningdevkit/vss-server | Versioned storage service for Lightning wallets | Server, LDK | Off-device encrypted state | Targets LND node operators | Infrastructure for wallet developers |
| ShockWallet / Lightning.Pub | https://github.com/shocknet/Lightning.Pub | Nostr-native Lightning node; multi-device sync of wallet state via NIP-78 (per search summary) | Nostr, LND | Also uses NIP-78 (kind 30078) for wallet state | Lifeboat backs up channel *recovery data* of an existing LND node | Shows NIP-78 is a known pattern for wallet state |

**Link check, 2026-09-20:** every URL above returned HTTP 200 to an automated fetch except the Phoenix post on Medium, which answered 403 to the script (Medium blocks non-browser clients; not opened by hand). A ZEUS link that returned 404 was replaced with the page that now hosts the embedded-node backup text, which was read and confirms the Olympus / seed-encrypted claim. A Breez SDK row was removed because no primary page had been read for it.

## BOSS Battle entries

The Devfolio search returned three BOSS Battle projects for these queries: **Splitsats** (bill splitting over Lightning), **NostrPulse** (Nostr reputation engine and Cashu NutZaps) and **AgentSats** (AI agent swarm coordinated by Nostr). None is about channel backup or recovery. About 30 entries exist in the gallery; only these three surfaced, so this is **not** a review of all of them. Re-read the live gallery before submitting.

## What the searches did not find

No repository or Devfolio entry that publishes LND static channel backups as NIP-44-encrypted Nostr events under a seed-derived key, and verifies them against the node. Search coverage is bounded (the Devfolio tool says so itself), so this is weak evidence.

## Honest weaknesses

1. SCB restore closes channels. Dynamic approaches (Alby VSS, Phoenix, `cldcb`, peer storage) can keep them open; Lifeboat cannot.
2. Relay durability over time is unmeasured (see `public-relay-testing.md`).
3. LND only, regtest-verified, about 200 channels per backup.
