import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseLine, type DrillEvent } from './drill-parse.js';
import { ROOT, wipeData } from './regtest.js';

/** Runs the drill, calling `emit` for each output line. Resolves with the exit code. */
export type RunFn = (emit: (line: string, isErr: boolean) => void, setKiller: (kill: () => void) => void) => Promise<number | null>;

const spawnDrill: RunFn = async (emit, setKiller) => {
  const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/demo.ts'], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
  setKiller(() => p.kill('SIGTERM'));
  const out = createInterface({ input: p.stdout });
  const err = createInterface({ input: p.stderr });
  out.on('line', (l) => emit(l, false));
  err.on('line', (l) => emit(l, true));
  p.on('error', (e) => emit(`could not start the drill: ${e.message}`, true));
  const [, , [code]] = await Promise.all([once(out, 'close'), once(err, 'close'), once(p, 'close')]);
  return code as number | null;
};

export const dockerCleanup = () =>
  new Promise<void>((resolve) =>
    execFile('docker', ['compose', 'down', '-v'], { cwd: ROOT, timeout: 60_000 }, () => {
      wipeData();
      resolve();
    }),
  );

/** One drill at a time; keeps its events so a page that loads later can replay the run. */
export class DrillRunner {
  private evs: DrillEvent[] = [];
  private lines = 0;
  private isBusy = false;
  private subs = new Set<(e: DrillEvent) => void>();
  private kill: () => void = () => {};

  constructor(private o: { run?: RunFn; cleanup?: () => Promise<void>; maxLines?: number } = {}) {}

  busy = () => this.isBusy;
  events = () => this.evs;

  /** Claim before any await so two simultaneous requests can't both start a run. */
  tryClaim(): boolean {
    if (this.isBusy) return false;
    this.isBusy = true;
    return true;
  }
  release() {
    this.isBusy = false;
  }

  subscribe(fn: (e: DrillEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private push(e: DrillEvent) {
    if (e.type === 'line' && ++this.lines > (this.o.maxLines ?? 3000)) return;
    this.evs.push(e);
    for (const s of this.subs) s(e);
  }

  /** Caller must hold the claim. Always ends with `end` then `idle`, even if the drill crashes. */
  async run(): Promise<void> {
    this.evs = [];
    this.lines = 0;
    this.push({ type: 'start', at: Date.now() });
    let code: number | null = 1;
    try {
      code = await (this.o.run ?? spawnDrill)(
        (line, isErr) => (isErr ? this.push({ type: 'line', text: line, kind: 'err' }) : parseLine(line).forEach((e) => this.push(e))),
        (k) => (this.kill = k),
      );
    } catch (e) {
      this.push({ type: 'line', text: `drill crashed: ${(e as Error).message}`, kind: 'err' });
    }
    this.push({ type: 'end', ok: code === 0, at: Date.now() });
    await (this.o.cleanup ?? dockerCleanup)().catch(() => undefined);
    this.isBusy = false;
    this.push({ type: 'idle' });
  }

  shutdown() {
    this.kill();
  }
}
