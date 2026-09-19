# Local release checklist

Release candidate for a **future** publication. This phase is local only: nothing is hosted, pushed, submitted or uploaded, and no remote is configured. Dates are the day each item was verified; "pending" items are filled in after the commit and the clean-clone test.

| Done | Item | Result |
|---|---|---|
| [x] | `npm ci` | completed without errors (2026-09-20) |
| [x] | `npm run check` | typecheck clean, **158 / 158** tests pass in 22 files |
| [x] | `npm run e2e` | **44 / 44** checks against real LND regtest nodes |
| [x] | `npm audit` | 0 vulnerabilities |
| [x] | Chrome demo | landing page and live drill in a fresh Chrome profile, extensions disabled: passed, 0 console errors or warnings |
| [x] | Recovery drill | 37.6 s total, 24.0 s wipe to recovery, 1,492,866 of 1,493,060 sats, 194 sats fees, relays 2/0 accepted, verification verified |
| [x] | Docker unavailable | daemon down, not installed, hung `docker`: one clear line, prompt exit, no stack trace |
| [x] | Demo reset safety | only `<repo>/data`; links not followed; works from any working directory (tests + manual) |
| [x] | Secret scan | no real secrets; matches are test fixtures, `.example` hosts and the documented throwaway regtest passwords |
| [x] | `.gitignore` | `node_modules/`, `data/`, `.env`, `*.log`, `*.macaroon`, `*.pem`, `*.key`, `*.crt`, `*.cert`, `.DS_Store` |
| [x] | `.env.example` | placeholders only; every variable's source documented |
| [x] | Documentation | counts, benchmark, Chrome-only, public-relay-partial, testnet NOT TESTED and remote CI NOT RUN checked for consistency |
| [x] | Screenshots | 10 reviewed: no personal data, secrets or failed states; REGTEST badge and product name correct |
| [x] | Submission package | `submission/`: links to maintained documents, real test results, explicit URL placeholders |
| [ ] | Local Git commit | pending |
| [ ] | Clean local clone | pending |
| [ ] | Clean clone test | pending |
| [x] | No remote configured | `git remote -v` prints nothing |
| [x] | No public deployment | no deployment configuration exists; nothing is hosted |
| [x] | No Devfolio submission | nothing submitted |

## Still NOT verified (do not claim)

Testnet and mainnet; Firefox and Safari; Node 22; remote GitHub Actions; public relay retention over time (public relays were tested one-shot with dummy data only).

## Decisions that need the owner

License (`docs/license-decision.md`), repository name and URL, when to push, video, Devfolio submission.
