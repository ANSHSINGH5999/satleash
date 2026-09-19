# Security

Each control below names the test that enforces it. Nothing here is asserted without one.

| Control | Enforced by |
|---|---|
| Relays are untrusted: foreign, wrongly tagged, unsigned/tampered and undecryptable events are skipped, the newest valid one wins | `nostr.test.ts` (hostile relay, direct validation) |
| Payload from relays is validated before use (version, base64, peer syntax, fingerprint) | `payload.test.ts` |
| New events are dated after anything of ours already on relays, so a leftover future-dated event cannot shadow them | `backup.test.ts` |
| Backup key is derived through LND's signer against an unknown-log point, never stored | `keys.test.ts`, `docs/protocol.md`, e2e (same key after a wipe) |
| Content is NIP-44 encrypted and padded | `nostr.test.ts` (relay never holds plaintext) |
| LND traffic is TLS-pinned to the node's own certificate and every request has a timeout | `lnd.test.ts` (impostor cert refused, timeout) |
| Least-privilege macaroons, confirmed by LND: read-only daemon, restore adds import and dial, neither can spend | `e2e.ts` (send coins, bake and new address denied; `canSpendOnchain`) |
| Console: loopback bind, Host and Origin checks, per-run token in constant time, nonce CSP, `frame-ancestors 'none'`, capped SSE clients | `web.test.ts`, `ui.test.ts` |
| Dashboard renders lnd/relay/log strings as text only | `ui.test.ts` (hostile strings; mutation-checked with an `innerHTML` sink) |
| Logs redact credentials by key name and shorten large blobs | `log.test.ts` |
| Relay URLs must be ws/wss without credentials; cleartext remote relays are flagged | `config.test.ts`, `security.test.ts` |
| Loosely permissioned macaroon files are warned about | `config.test.ts` |
| Mainnet is refused unless `LIFEBOAT_ALLOW_MAINNET=1`, in the CLI and in the console's monitor | `config.test.ts`, `monitor.test.ts` |
| Relay management: adding a public (non-loopback) relay needs explicit confirmation; the last enabled relay cannot be removed | `web.test.ts`, `relays.test.ts` |
| Relay frames and events of any shape are handled without throwing: `isOwnValid` and the probe never throw on malformed input, junk and oversize events are dropped, an unusable newer payload cannot hide an older good backup | `hostile.test.ts` |
| Verification asks LND to decrypt the relay copy (`VerifyChanBackup`) and lets LND's channel list decide whether it matches the node | `verify.test.ts`, e2e (real LND, read-only macaroon) |
| An expected network (`LIFEBOAT_NETWORK`) refuses any other node, and a failed or refused start cannot be mistaken for a running service | `config.test.ts`, `monitor.test.ts`, `backup.test.ts` |
| Public relay test uses only a throwaway key, an isolated namespace and dummy content, and asks for deletion afterwards | `relay-test.test.ts`, `web.test.ts`, e2e, `public-relay-testing.md` |
| Strict request handling: JSON content type, object bodies, 16 KB limit, single-flight for drill / verify / relay test, SSE cap and slow-client drop, request ids | `web.test.ts`, `sse.test.ts` |
| Backup state machine rejects impossible transitions and surfaces them as a failed security check | `backup.test.ts`, `security.test.ts` |
| A dropped LND backup stream is resubscribed without an idle timeout killing it; the monitor republishes if the relays fall behind | `lnd.test.ts`, `monitor.test.ts` |
| Repo-root-safe paths: the drill never deletes a `data/` outside the repository | `regtest.test.ts` (paths come from the module location, not the working directory) |

## Secrets

The regtest Docker network publishes its ports on 127.0.0.1 only (bitcoind RPC uses a known throwaway password). No secret is committed. The regtest wallet password in `src/regtest.ts` is a fixed throwaway for a throwaway network. Macaroon files are created `0600` and refuse to overwrite (`bake` uses exclusive create); `*.macaroon` is git-ignored. The logger never receives the backup key, macaroons or the seed; redaction is a second line of defence.

## Known weaker spots

- Both pages load fonts from Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`); the CSP allows nothing else remote, but Google learns that a page was opened. Self-hosting the fonts would remove this and has not been done.
- The CSP allows `style-src-attr 'unsafe-inline'` for a few dynamic widths. Scripts stay nonce-only.
- The relay list added in the console is session-only.
- Security check verdicts are derived from live state; they are not a score and not a guarantee.

## Reporting

Regtest prototype: do not run against a node with funds you cannot lose. Report issues to the repository owner.
