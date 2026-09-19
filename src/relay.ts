// Tiny in-memory Nostr relay for tests, the demo and the playground. Not a production relay.
import { matchFilter } from 'nostr-tools/filter';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { WebSocketServer } from 'ws';

const slot = (e: Event) =>
  e.kind >= 30000 && e.kind < 40000 ? `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : e.id;

/** `ignoreFilters` makes the relay answer every REQ with everything it has, to simulate a hostile relay in tests. */
export function startRelay(port: number, opts: { ignoreFilters?: boolean; honorDeletions?: boolean } = {}) {
  const store = new Map<string, Event>();
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m: any[];
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m[0] === 'EVENT') {
        const e = m[1] as Event;
        if (!verifyEvent(e)) return ws.send(JSON.stringify(['OK', e?.id, false, 'invalid: bad signature']));
        if (e.kind === 5) {
          if (opts.honorDeletions === false) return ws.send(JSON.stringify(['OK', e.id, true, '']));
          // NIP-09: delete events of the same author referenced by `e` or `a` tags
          for (const t of e.tags) {
            if (t[0] === 'e') for (const [k, v] of store) if (v.id === t[1] && v.pubkey === e.pubkey) store.delete(k);
            if (t[0] === 'a') {
              const [kind, pk, d] = t[1].split(':');
              const k = `${kind}:${pk}:${d ?? ''}`;
              if (pk === e.pubkey && store.has(k)) store.delete(k);
            }
          }
          return ws.send(JSON.stringify(['OK', e.id, true, '']));
        }
        const old = store.get(slot(e));
        if (!old || e.created_at > old.created_at || (e.created_at === old.created_at && e.id < old.id)) {
          store.set(slot(e), e);
        }
        ws.send(JSON.stringify(['OK', e.id, true, '']));
      } else if (m[0] === 'REQ') {
        const [, sub, ...filters] = m;
        for (const e of store.values()) if (opts.ignoreFilters || filters.some((f) => matchFilter(f, e))) ws.send(JSON.stringify(['EVENT', sub, e]));
        ws.send(JSON.stringify(['EOSE', sub]));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/`,
    stored: () => [...store.values()],
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}
