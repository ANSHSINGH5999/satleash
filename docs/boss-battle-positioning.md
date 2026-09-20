# BOSS Battle positioning

Track texts are from Devfolio's `getHackathonTracksAndPrizes` for `boss-battle` (retrieved 2026-09-19; $1,000 per track). The event overview page names three "boss fights", Privacy, Nostr and AI, which line up with Cypherpunk, Freedom Stack and Machine Money; that mapping is my reading, not the organisers' statement. No judging criteria are published on the overview page. Do not change the product to force a fit.

## Freedom Stack: primary track

| | |
|---|---|
| What the track asks for | Nostr and ecash as answers to intermediaries that can revoke access, read contents or change the rules; systems whose useful properties "shouldn't depend on trusting whoever operates it"; explore what that makes possible and where it "still falls short" |
| What Lifeboat demonstrates | Recovery of a Lightning node with no vendor, account or trusted server. Nostr relays are storage and identity, and are treated as untrusted: encrypted, validated locally, several used, one switched off in the drill |
| Evidence | Seed-derived Nostr identity (`keys.ts`, e2e); hostile-relay tests (`hostile.test.ts`); per-relay verification (`verify.test.ts`); the drill restoring with 1 of 2 relays down; a one-shot test on public relays (`public-relay-testing.md`) |
| What does not align | No ecash. The text names it as one of two answers; it does not require both, but a judge may look for it |
| Potential weakness | Relay durability and economics are unmeasured; public relays were intermittent in testing; "where it still falls short" is answered in the Limits section rather than solved |

## Cypherpunk: weak, do not lead with it

| | |
|---|---|
| What the track asks for | Bitcoin **private in practice**: tooling where good privacy is the default; payments on a public ledger are traceable |
| What Lifeboat demonstrates | Backups are encrypted and padded before they reach a relay; recovery leaks nothing to a vendor; the console is local-only |
| Evidence | NIP-44 with padding (`nostr.test.ts`); no account; loopback console (`web.test.ts`) |
| What does not align | The track is about payment and on-chain privacy. Lifeboat is about recoverability. Relays still see the backup key, timing, rough size and your IP; there is no Tor or proxy support |
| Potential weakness | A judge can fairly call it off-theme |

## Machine Money: weak, do not enter

| | |
|---|---|
| What the track asks for | Software that transacts on its own behalf; what machine intelligence can do for people and infrastructure running Bitcoin |
| What Lifeboat demonstrates | Unattended infrastructure: automatic backup on every change, self-healing republish, scheduled verification |
| Evidence | `backup.test.ts`, `monitor.test.ts`, e2e |
| What does not align | No machine payments and no AI. Automation is not machine intelligence |
| Potential weakness | Substantial mismatch |

## Recommendation

Submit under **Freedom Stack**, say plainly that ecash is not used, and let the Limits section carry the "where it still falls short" half of the brief.
