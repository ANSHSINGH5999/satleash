# Differentiation

Lifeboat's differentiation is a combination, not a single invention. Sources and coverage limits are in `competitive-analysis.md` and `novelty-analysis.md`; this page is the short argument. It makes no "first", "only" or "never done" claim: the searches behind it are bounded and an empty result is not proof.

## The existing problem

An LND node's channel state lives on one machine. Losing it means the usual way to get channel funds back is a static channel backup (SCB) plus peers willing to force-close. The SCB is small and safe to copy, but it changes with every channel, so an old copy misses newer channels.

## Existing approaches

- Copy `channel.backup` by hand or with a script to a USB stick, a private GitHub repository or Dropbox (MiniBolt/RaspiBolt guides, `lnd-channel-remote-backup`).
- Vendor-hosted backups (Umbrel, reported; ZEUS/Olympus for its embedded node; Alby Hub VSS on a paid plan).
- Dynamic or peer-based backups for other stacks: Core Lightning `cldcb`, peer storage in CLN and Eclair, Phoenix, LDK's VSS server.
- Health monitors that look at the backup file (`ln-health` checks existence, size and age).

## Their limitations (for an LND operator who wants no vendor)

- A script copies a file; it does not say whether the copy is current, decryptable by the node or complete, and it ties recovery to an account or a repository.
- Vendor services ask you to trust and depend on one company.
- Dynamic and peer-based schemes are not available for a stock LND node, or need wallet or peer support.
- File-level monitoring cannot tell whether a restore would work.

## Lifeboat's approach

Publish every backup change to Nostr relays as one encrypted event under a key derived from the seed; treat relays as untrusted storage; check the relay copy against the live node, per relay, with LND decrypting it; and rehearse the restore on real LND nodes.

## Technical difference

| Where | Typical | Lifeboat |
|---|---|---|
| Where the copy lives | one account, repository or vendor | several Nostr relays, any one enough |
| What recovery needs | the file, an account, sometimes a second secret | the 24 words |
| Trust in storage | full | none: author, signature, payload and channel set re-checked locally |
| Knowing it works | trust the file | `verify`: authentic, LND-decryptable, matches the node, redundancy per relay |
| Proof of restore | a manual procedure | an automated wipe-and-restore drill with measured time, sats and fees |

## Why this combination matters

Each piece exists somewhere. What Lifeboat adds is putting them together so an operator with a stock LND node can answer, *today*, "if this machine died right now, could I get my channel funds back, and from where?", without an account, a vendor or a second secret.

## What it does not change

The restore still closes channels and depends on peers; dynamic backup schemes are better where available. Relay retention over time is unmeasured. It is regtest-verified and LND-only.
