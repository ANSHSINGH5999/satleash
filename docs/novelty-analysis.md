# Novelty analysis

Evidence base: `competitive-analysis.md` (searches on 2026-09-19). This document separates what is known, what is inferred and what is unknown. It makes **no "first" or "only" claim**.

## Core concept

Keep an LND node's static channel backup on Nostr relays, encrypted under a key derived from the wallet seed, so that a node wiped down to its 24 words can find the backup again; then check, before any disaster, that what the relays hold matches the node, and rehearse the restore on a real LND.

## Primitives and where they already exist

| Primitive | Exists elsewhere? | Evidence |
|---|---|---|
| Static channel backup, export and subscribe | Yes, it is LND's own feature | LND `docs/recovery.md` |
| Copying the SCB off the machine automatically | Yes: scripts to Dropbox or a private GitHub repo, vendor services (Umbrel, ZEUS/Olympus) | MiniBolt guide, `lnd-channel-remote-backup`, ZEUS docs |
| Backup encrypted under a seed-derived key | Yes, inside SCB itself | LND docs |
| Storing application data as NIP-78 (kind 30078) events | Yes, a known Nostr pattern; one Lightning project is described as using it for wallet state | Lightning.Pub search summary |
| Backing up channel data to storage the operator does not trust | Yes for Core Lightning (`cldcb`), peer storage, VSS | `cldcb`, Optech |
| A Nostr identity derived from the wallet seed through LND's signer, using a point with unknown discrete log | **Not found** in these searches | Lifeboat's own construction (`docs/protocol.md`) |
| Publishing SCBs as Nostr events specifically | **Not found** in these searches | absence of results |
| Checking the *relay copy* against the node's current channel set, per relay (healthy, stale, missing, down) | **Not found**; `ln-health` checks only file existence, size and age | ln-health summary |
| Asking LND itself to decrypt the relay copy (`VerifyChanBackup`) as part of a routine check | The RPC exists; using it on a relay-held copy was **not found** elsewhere | LND API reference |
| Untrusted-relay validation, tested against a hostile scripted relay | Standard client hygiene in principle; the tests here are Lifeboat's | `src/hostile.test.ts` |
| An automated wipe-and-restore drill on real LND nodes, shown in a UI with measured timings | **Not found**; SCB docs describe the manual procedure | LND docs, guides |
| Least-privilege macaroons confirmed by LND | LND feature, used here | LND |

## Combinations that appear uncommon

1. **Seed-only identity + Nostr relays + SCB**: recovery needs nothing but the seed. Vendor services need an account; scripts need a cloud account or repository.
2. **Relay-copy verification against the live node**, per relay, with LND deciding what the blob contains.
3. **A drill that is real** (LND wiped, restored, funds measured), presented next to the daily verification.

## Overlap that a critical judge will notice

- The SCB itself is unchanged and inherits its limits (channels close, peers must cooperate). Dynamic backups (Alby VSS, Phoenix, `cldcb`, peer storage) keep channels open; Lifeboat cannot.
- Off-machine SCB backup is a solved problem for anyone willing to run a script or use a vendor. The differentiator is trust model (no account, no vendor, untrusted relays), verification and the drill, not the act of copying a file.

## Remaining uncertainty

- Search coverage is bounded. Private repositories, non-English communities and unindexed Devfolio entries were not searched. The BOSS Battle gallery (about 30 entries) was not reviewed entry by entry.
- Public relay retention over time is unmeasured, so "relays are a good place to keep this" is a hypothesis with two single-shot tests behind it.
- No user has tried it.

## Wording to use

"Lifeboat differs by keeping recovery dependent only on the seed, treating relays as untrusted storage, and checking the relay copy against the live node, including a real restore drill." Not: "first", "only", "nobody has".
