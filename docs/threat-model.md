# Threat model

**Assets:** the ability to recover channel funds after losing the node; confidentiality of channel topology; the Nostr backup key (derived, never stored); the LND macaroon; the seed.

**Trust boundaries:** LND (trusted, local) | Lifeboat process | Nostr relays (untrusted) | local browser and other local processes | the internet.

**Assumptions:** the host running Lifeboat and LND is not compromised; the seed is kept offline; clocks are roughly right (skew beyond 10 minutes is flagged).

## Actors

| # | Actor / event | Goal or fault | Mitigation | Test | Residual risk |
|---|---|---|---|---|---|
| 1 | Malicious relay | Serve garbage, foreign or tampered events | Local author/kind/tag/signature checks; skip and continue; newest valid across relays | `nostr.test.ts`, e2e | None known for integrity |
| 2 | Withholding or stale relay | Hide or downgrade the backup | Several relays; verify reports `stale` / `missing` and "behind the node"; self-healing republish | `verify.test.ts`, `monitor.test.ts` | If every relay is stale, channels opened since are not recoverable |
| 3 | Relay that acks but does not serve | Look healthy on write | Read-back in verify; public relay test measures it | `verify.test.ts`, `public-relay-testing.md` (damus) | Retention over time is unmeasured |
| 4 | Relay operator / passive observer | Learn about the user | NIP-44 + padding; wss recommended | `nostr.test.ts` | Publish times, rough size and IP are visible. No Tor built in |
| 5 | Network attacker on cleartext `ws://` | Read or block traffic | Content encrypted; cleartext remote relays flagged (security check `transport`); non-loopback add needs confirmation | `security.test.ts`, `web.test.ts` | Metadata visible, blocking possible |
| 6 | Clock skew / future-dated event | Shadow new backups | Events over +600 s ignored unless the only option (then flagged); new events ordered after existing ones | `nostr.test.ts`, `backup.test.ts` | A writer with our key can still post a newer event |
| 7 | Replay of an old valid event | Roll the backup back | Newest wins; verify compares to the node's channel fingerprint and flags "behind" | `verify.test.ts` | Between a channel opening and the next publish, the old copy is what recovery gets |
| 8 | Oversize / malformed payload | Crash or block restore | Payload validation (version, base64, peers, fingerprint); explicit size error | `payload.test.ts` | About 200 channels per backup |
| 9 | Stolen daemon macaroon | Read node data | Read-only macaroon confirmed by LND; file `0600`, loose modes warned | e2e, `config.test.ts` | Reveals channel and peer info |
| 10 | Stolen seed | Take funds and decrypt backups | Out of scope: the seed already controls funds | | Total |
| 11 | Hostile web page against the local console | Drive the console from a browser | Loopback bind; Host/Origin checks; per-run token (constant time); nonce CSP; `frame-ancestors 'none'` | `web.test.ts`, `ui.test.ts` | Same-user local software can read files anyway |
| 12 | Hostile strings from LND, relays, logs | Script the dashboard | Text-only rendering; CSP | `ui.test.ts` (mutation-checked) | None known |
| 13 | Local DoS of the console | Exhaust it | SSE client cap and slow-client drop, body size limit, single-flight drill/verify/relay test, request timeouts | `web.test.ts`, `sse.test.ts` | A local process can still burn CPU |
| 14 | Offline peer during restore | Funds stay locked | Peer hints and repeated redials | e2e | Funds wait for the peer |
| 15 | Misconfiguration (mainnet by accident, bad relay URL, credentials in URL) | Real funds at risk | Mainnet refused without `LIFEBOAT_ALLOW_MAINNET=1`; strict URL/config validation | `config.test.ts` | Operator can set the flag |
| 16 | Public relay test misused | Leak a real backup | The test uses no lnd, key or backup; `--yes` / confirm checkbox; single-flight; throwaway key and isolated namespace | `relay-test.test.ts`, `web.test.ts` | Dummy event may stay if a relay ignores deletion |
| 17 | Compromised dependency or Docker image | Run hostile code | `npm audit` clean (0 vulnerabilities on 2026-09-19); few dependencies; lockfile | audit | Supply chain risk is never zero; regtest images are third-party |
| 18 | Third-party font host (Google Fonts, both pages) | Learn that a page was opened | CSP restricts remote loads to fonts only | `web.test.ts` | Google sees a request from the local user's browser when a page loads. Self-hosting fonts would remove it |

Not modelled: compromise of LND or the host, side channels, malicious peer implementations beyond refusing to close.
