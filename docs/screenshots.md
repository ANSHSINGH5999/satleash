# Screenshots

All ten were captured on 2026-09-19 (`01-landing.png` was re-captured on 2026-09-20 after the hero button's text colour was changed for contrast) from the **real running application** with headless Chrome (`scripts/capture-screenshots.mjs`): the console from `npm run playground` against a live regtest LND, the drill screens from a real drill started with the page's own button. Nothing is mocked up. The one diagram (09) is rendered from `docs/diagrams/architecture.svg`.

| # | File | What it shows | Source |
|---|---|---|---|
| 1 | `screenshots/01-landing.png` | Landing page above the fold, with the cursor lens lighting the ridges under the pointer | `npm run playground` (or `web`), `/` |
| 2 | `screenshots/02-dashboard.png` | Recovery readiness evidence and key numbers | console, Dashboard tab |
| 3 | `screenshots/03-backup.png` | Backup pipeline state, Nostr key, publish history | console, Backup tab |
| 4 | `screenshots/04-verify.png` | Verification verdict and what was checked (author and signature, lnd accepted, channel set, relay redundancy) | console, Verify tab |
| 5 | `screenshots/05-recovery-drill.png` | The drill mid-run, restore stage active | landing, real drill |
| 6 | `screenshots/06-relays.png` | Relay health table and the public relay test form | console, Relays tab |
| 7 | `screenshots/07-security.png` | Security Center checks | console, Security tab |
| 8 | `screenshots/08-recovered-state.png` | Final recovered state: sats before and after, fees, all checks passed, metrics | landing, after the drill |
| 9 | `screenshots/09-architecture.png` | Architecture and trust boundaries | `docs/diagrams/architecture.svg` |
| 10 | `screenshots/10-proof-metrics.png` | Technical proof: measured metrics grid and fingerprint | landing, after the drill |

The numbers in 5, 8 and 10 belong to the single drill run that produced them; another run will differ in fees and timings.

## Regenerate them

```bash
npm run playground                              # wait for "READY", then in another terminal:
node scripts/capture-screenshots.mjs console    # 01, 02, 03, 04, 06, 07, 09
# Ctrl-C the playground, then:
npm run web                                     # needs Docker
node scripts/capture-screenshots.mjs drill      # 05, 08, 10 (runs the real drill, about 45 s)
```

`node scripts/capture-screenshots.mjs landing` re-takes only 01 (needs `npm run web` or the playground, no Docker for the page itself).

Needs Chrome or Chromium (`CHROME_PATH` if it is not in the usual place). The script refuses to run if nothing answers on the port, and if a drill fails it captures nothing as a result.

## Capturing by hand

Browser window 1280×800 at 100 % zoom, dark mode as served. For the console use the tabs named above; for the drill press **Run recovery drill** and wait for the status pill to read **Passed** before shots 8 and 10. Do not crop out the network badge (REGTEST) or the status pill. Check each image for personal information (none is expected: no path, hostname or key material beyond regtest fingerprints).

## Not captured

Mobile layouts (checked by tests, not part of the package), Firefox and Safari (not tested).
