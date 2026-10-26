export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, message: string, meta?: unknown) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    if (meta === undefined) out(line);
    else out(line, meta instanceof Error ? (meta.stack ?? meta.message) : meta);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}

/** Logger that swallows everything (tests). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
