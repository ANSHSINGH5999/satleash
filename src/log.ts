export type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogEntry = { t: string; level: Level; msg: string; fields?: Record<string, unknown> };

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /(macaroon|mnemonic|seed|password|passwd|token|secret|privkey|private|nsec|authorization)/i;

/** Strips anything that looks like a credential and shortens large blobs (backups, hex macaroons). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 40)}...[${value.length} chars]`;
  return value;
}

const defaultWrite = (line: string, level: Level) => (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line + '\n');

export class Logger {
  private ring: LogEntry[] = [];

  constructor(private o: { level?: Level; json?: boolean; write?: (line: string, level: Level) => void; ringSize?: number } = {}) {}

  private emit(level: Level, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.o.level ?? 'info']) return;
    const entry: LogEntry = { t: new Date().toISOString(), level, msg, ...(fields ? { fields: redact(fields) as Record<string, unknown> } : {}) };
    this.ring.push(entry);
    if (this.ring.length > (this.o.ringSize ?? 200)) this.ring.shift();
    const line = this.o.json
      ? JSON.stringify(entry)
      : `${entry.t} ${level.toUpperCase().padEnd(5)} ${msg}${entry.fields ? ' ' + JSON.stringify(entry.fields) : ''}`;
    (this.o.write ?? defaultWrite)(line, level);
  }

  debug = (msg: string, fields?: Record<string, unknown>) => this.emit('debug', msg, fields);
  info = (msg: string, fields?: Record<string, unknown>) => this.emit('info', msg, fields);
  warn = (msg: string, fields?: Record<string, unknown>) => this.emit('warn', msg, fields);
  error = (msg: string, fields?: Record<string, unknown>) => this.emit('error', msg, fields);

  recent(n = 50): LogEntry[] {
    return this.ring.slice(-n);
  }
}

/** `stderr: true` sends every level to stderr, for commands whose stdout carries their result (`verify`, `pubkey`). */
export const createLogger = (env: NodeJS.ProcessEnv = process.env, o: { stderr?: boolean } = {}) =>
  new Logger({ level: (env.LOG_LEVEL as Level | undefined) ?? 'info', json: env.LOG_FORMAT === 'json', write: o.stderr ? (line) => void process.stderr.write(line + '\n') : undefined });
