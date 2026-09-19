# Testnet readiness checklist

Lifeboat has been exercised end to end **only on regtest**. Do not use funds you cannot lose. Mainnet is refused unless `LIFEBOAT_ALLOW_MAINNET=1`, and the console and `assess()` show a MAINNET warning. Set `LIFEBOAT_NETWORK=testnet` (or `testnet4`, `signet`, `regtest`) to say which network you mean: a node on any other network, mainnet included, is then refused even if the mainnet flag is set. The network is labelled REGTEST, TESTNET, TESTNET4, SIGNET or MAINNET in the console and in `/api/monitor`.

## Before a testnet/signet run

- [ ] `LIFEBOAT_NETWORK` set to the network you intend
- [ ] LND 0.20 (other versions untested), fully synced, on testnet/signet with test coins
- [ ] `npm run check` passes on your machine
- [ ] Two independent `wss://` relays you are willing to publish encrypted backups to
- [ ] `cli bake` a read-only macaroon; `lnd confirms: this macaroon cannot spend on-chain funds` printed
- [ ] `cli verify` exits 0 (verdict `verified`), and the console shows the network as TESTNET/SIGNET
- [ ] Seed written down offline before opening channels

## The run

- [ ] Open at least two channels, one to a peer you can switch off
- [ ] Watch the console: publish per channel change, verdict `verified`
- [ ] Stop the node, delete its data, recreate it from the seed
- [ ] `cli restore`; check the peers force-close and funds return
- [ ] Record timings and any relay problems

## Status

Nothing on this list has been run: **testnet is NOT TESTED**. The guardrails (labels, `LIFEBOAT_NETWORK`, mainnet refusal, `testnet4` recognition) are unit-tested against a stubbed node only.

## Not verified for testnet

Public relay retention over days, long-running daemon behaviour (soak), LND versions other than 0.20, Tor/proxy use, and any peer implementation other than LND (only LND-to-LND was tested).
