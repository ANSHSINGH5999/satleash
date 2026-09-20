# Video script (about 2 minutes)

Target 90 to 150 seconds. The video shows the running product only: screen recordings of the real landing page, drill and console. **No third-party footage, stock clips, music you do not own, or mock-ups.** Numbers spoken must be read off the screen from the take you record, not from this file.

Recording setup is in `video-checklist.md`.

| # | Time | Scene | On screen | Voice-over (about 150 words per minute) |
|---|---|---|---|---|
| 1 | 0:00 to 0:12 | Problem | Landing hero | "A Lightning node keeps its channel state on one machine. The backup that protects it is a file somebody has to keep copying, and if that copy is stale or gone, the money in the channels depends on your peers." |
| 2 | 0:12 to 0:22 | The node | Architecture section, LND box highlighted | "Lifeboat sits next to an LND node and watches its channel-backup stream." |
| 3 | 0:22 to 0:32 | Backup | Click **Run recovery drill**; stages 01 to 03 | "Every channel change becomes a backup." |
| 4 | 0:32 to 0:42 | Encryption | Terminal pane: backup identity, fingerprint | "It is encrypted with NIP-44, under a key the node derives from its seed. Nothing extra to store." |
| 5 | 0:42 to 0:55 | Relay distribution | `published: 1ch->2relay, 2ch->2relay` | "And published to several Nostr relays. Relays are treated as untrusted: everything they return is validated locally." |
| 6 | 0:55 to 1:08 | Verification | Pill **Backup verified by lnd before the wipe** | "Before any disaster, verification: LND itself decrypts the relay copy and confirms it covers the node's channels." |
| 7 | 1:08 to 1:20 | Wipe | Stage 04; `alice is gone`, `relay … switched off too` | "Now we destroy the node completely, and switch one relay off." |
| 8 | 1:20 to 1:38 | Recovery | Stage 05; identity, key, fingerprint pills | "A new node from the 24 words and a known relay finds the same key, fetches the backup, and restores it. Same identity, same fingerprint." |
| 9 | 1:38 to 1:52 | Results | Stage 06 and metrics grid | "Funds are back on-chain: [sats after] of [sats before], [fees] in fees, in [seconds]. This is regtest." |
| 10 | 1:52 to 2:05 | Security | Security model section | "The daemon is read-only and LND confirms it cannot spend. Relay data is validated locally. The console is loopback-only." |
| 11 | 2:05 to 2:15 | Final product | Limits, then hero | "It closes channels on restore, needs peers online, and is only verified on regtest. Lifeboat: seed-only recovery for LND channel funds, over Nostr." |

## Do not say

"Unhackable", "military-grade", "first", "only", "trustless", "guaranteed", "works on mainnet". Do not show a mainnet or personal node.
