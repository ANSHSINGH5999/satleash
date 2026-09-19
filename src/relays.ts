import { parseRelays } from './config.js';

export type RelayEntry = { url: string; enabled: boolean; addedAt: number; session: boolean };

/**
 * The relays in use. In memory only: Lifeboat keeps no state on disk, so changes made at runtime last until restart
 * (set RELAYS to make them permanent). At least one relay always stays enabled.
 */
export class RelaySet {
  private list: RelayEntry[];
  private listeners = new Set<() => void>();

  constructor(urls: string[]) {
    this.list = parseRelays(urls.join(',')).map((url) => ({ url, enabled: true, addedAt: Date.now(), session: false }));
  }

  all(): RelayEntry[] {
    return this.list.map((r) => ({ ...r }));
  }
  active(): string[] {
    return this.list.filter((r) => r.enabled).map((r) => r.url);
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private changed() {
    for (const f of this.listeners) f();
  }
  private find(url: string): RelayEntry {
    let norm: string;
    try {
      norm = new URL(url).href;
    } catch {
      throw new Error(`invalid relay URL: ${url}`);
    }
    const r = this.list.find((x) => x.url === norm);
    if (!r) throw new Error(`relay is not configured: ${url}`);
    return r;
  }

  add(url: string): RelayEntry {
    if (typeof url !== 'string' || url.includes(',') || /\s/.test(url)) throw new Error(`invalid relay URL: ${String(url).slice(0, 80)}`);
    const [norm] = parseRelays(url);
    if (this.list.some((r) => r.url === norm)) throw new Error(`relay is already configured: ${norm}`);
    if (this.list.length >= 10) throw new Error('at most 10 relays are supported');
    const entry = { url: norm, enabled: true, addedAt: Date.now(), session: true };
    this.list.push(entry);
    this.changed();
    return { ...entry };
  }

  remove(url: string) {
    const r = this.find(url);
    if (r.enabled && this.active().length === 1) throw new Error('at least one relay must stay enabled');
    this.list = this.list.filter((x) => x !== r);
    this.changed();
  }

  setEnabled(url: string, enabled: boolean) {
    const r = this.find(url);
    if (!enabled && r.enabled && this.active().length === 1) throw new Error('at least one relay must stay enabled');
    if (r.enabled === enabled) return;
    r.enabled = enabled;
    this.changed();
  }
}
