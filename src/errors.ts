/** Turns a raw failure into what an operator needs: what happened, what it affects, what to do. */
export type Explained = { error: string; cause?: string; impact?: string; action?: string };

const RULES: { test: RegExp; cause: string; impact: string; action: string }[] = [
  { test: /no relay accepted/i, cause: 'Every enabled relay refused or could not be reached.', impact: 'The backup on the relays was not updated. Earlier copies are unchanged.', action: 'Check relay reachability on the Relays tab. A retry with backoff is already scheduled.' },
  { test: /no relay is enabled/i, cause: 'All relays are disabled.', impact: 'Nothing can be published or verified.', action: 'Enable at least one relay on the Relays tab.' },
  { test: /timed out after \d+ms|no response within timeout/i, cause: 'lnd did not answer within the time limit.', impact: 'The last known state is shown; nothing was changed.', action: 'Check that lnd is running and reachable, then retry.' },
  { test: /ECONNREFUSED|ECONNRESET|socket hang up/i, cause: 'The connection to lnd was refused or dropped.', impact: 'Node data and backups pause until lnd is reachable again.', action: 'Start lnd or check LND_HOST and LND_PORT. The daemon and the console reconnect by themselves.' },
  { test: /verification failed|invalid macaroon|signature mismatch|macaroon.*(expired|not found)/i, cause: 'lnd rejected the macaroon (wrong node, wrong network or corrupted file).', impact: 'No lnd call can succeed with this macaroon.', action: 'Point LND_MACAROON at a macaroon baked by this node (npm run cli -- bake).' },
  { test: /permission denied/i, cause: 'The macaroon does not allow this call.', impact: 'That feature is unavailable with the current macaroon.', action: 'Bake a macaroon with the needed permissions (npm run cli -- bake).' },
  { test: /still in the process of starting/i, cause: 'lnd has not finished starting.', impact: 'Calls fail until it is ready.', action: 'Wait a few seconds and retry.' },
  { test: /invalid JSON/i, cause: 'lnd (or something in front of it) returned a page that is not JSON.', impact: 'The call was ignored.', action: 'Check that LND_HOST and LND_PORT point at the lnd REST port, not a proxy.' },
  { test: /self.signed|unable to verify|certificate/i, cause: 'The TLS certificate does not match the pinned lnd certificate.', impact: 'Lifeboat refuses to talk to this endpoint.', action: 'Check LND_CERT points at this node\'s tls.cert.' },
  { test: /over the NIP-44 limit/i, cause: 'The backup is larger than a NIP-44 message can hold.', impact: 'It cannot be published (about 200 channels is the limit).', action: 'Chunked backups are not implemented yet.' },
];

export function explain(e: unknown): Explained {
  const error = e instanceof Error ? e.message : String(e);
  const rule = RULES.find((r) => r.test.test(error));
  return rule ? { error, cause: rule.cause, impact: rule.impact, action: rule.action } : { error };
}
