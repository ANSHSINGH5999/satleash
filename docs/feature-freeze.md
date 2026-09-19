# Feature freeze

Frozen 2026-09-19. Nothing below is to be added or changed before submission except bug fixes found by the checks in `test-matrix.md`. Classification is by evidence: **what was verified**, not what was intended.

| Class | Meaning |
|---|---|
| CORE | The product. Must work in the demo. Verified against real LND |
| STABLE | Built, tested, used by the demo or by an operator, not required to explain the product |
| OPTIONAL | Works, but stays out of the primary demo path |
| EXPERIMENTAL | Implemented but only partly verified. Never in the demo path |
| REMOVE | Nothing is scheduled for removal; the one third-party asset (a hero video) was already replaced by a canvas |

## CORE (the demo path)

| Feature | Files | Verified by |
|---|---|---|
| Publish LND static channel backups as NIP-44-encrypted kind-30078 events on every change | `backup.ts`, `nostr.ts`, `payload.ts` | e2e (live channel update), `backup.test.ts` |
| Nostr key derived from the seed through LND's signer | `keys.ts` | e2e (same key after a wipe), `keys.test.ts` |
| Untrusted-relay validation and newest-usable-event selection | `nostr.ts` | `nostr.test.ts`, `hostile.test.ts`, e2e |
| Verification: relay copy vs live node, per relay, lnd decrypts the copy | `backup.ts` (`verifyBackup`) | `verify.test.ts`, e2e (real LND) |
| Restore from seed alone with peer redial | `backup.ts` (`restoreFromNostr`) | e2e, four drills |
| Regtest disaster drill (two relays, one switched off, funds measured) | `demo.ts`, `regtest.ts`, `drill*.ts` | `npm run demo` (4 runs), UI rehearsal |
| Landing page with the live drill | `web/index.html`, `web.ts` | `ui.test.ts`, UI rehearsal |
| Least-privilege macaroons (`bake`), confirmed by LND | `cli.ts`, `lnd.ts` | e2e |
| Mainnet refusal, network labels | `config.ts`, `monitor.ts` | `config.test.ts`, `monitor.test.ts` |

## STABLE

Console (`/console`, 8 tabs) and Security Center; backup state machine and jittered retry; self-healing republish; `/healthz`; SSE broadcaster; explained errors and request ids; redacting logger; the playground (`npm run playground`) as the live-node demo; `npm run demo:check`, `demo:reset` and prerequisite checks (unit-tested; reset verified from several working directories); regtest e2e suite (44 checks).

## OPTIONAL (not in the primary demo)

| Feature | Why it stays out |
|---|---|
| Relay management in the console (add, remove, enable, disable, test) | Works and is tested, but adds clicks; not needed to explain the product |
| Public relay test (CLI, API, UI) | Depends on third-party relays that were intermittent (`public-relay-testing.md`); never run live in front of judges |
| `bake --restore`, `LIFEBOAT_NETWORK`, `STALE_AFTER_SEC` | Operator settings |
| `playground:open` | Nice second act if there is time; needs the playground |
| Activity and Settings tabs | Informational |

## EXPERIMENTAL (never in the demo path)

| Feature | State |
|---|---|
| `testnet4` / testnet / signet handling | Labels and guards are unit-tested against a stubbed node only. **No testnet node was run** |
| Console rendering in Firefox and Safari | Not tested. Chrome only |
| Public relays as a durable store | One-shot tests only; retention over time unmeasured |
| Node.js 22 | `engines` says >=22; only Node 26 was used |

## REMOVE

Nothing. Reasons for keeping things that look extra: each has tests and none is loaded unless used.

## Rules while frozen

1. No new features. Bug fixes need a failing test first.
2. The demo path is: `npm run web` → landing page → **Run recovery drill**. The optional console tour uses `npm run playground`. Everything else is off the path.
3. Any claim in the README, the submission copy or the video must be traceable to a row in `test-matrix.md` or `FINAL_PROJECT_STATUS.md`.
