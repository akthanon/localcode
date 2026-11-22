/** Lightweight logger with levels and stderr output to keep the TUI clean. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: LogLevel;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = "info", scope = "localcode"): Logger {
  const write = (lvl: LogLevel, message: string, data?: unknown) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] ${lvl.toUpperCase()} ${scope}:`;
    if (data === undefined) {
      process.stderr.write(`${prefix} ${message}\n`);
    } else {
      process.stderr.write(`${prefix} ${message} ${safeStringify(data)}\n`);
    }
  };
  return {
    level,
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (s) => createLogger(level, `${scope}/${s}`),
  };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = createLogger(
  (process.env.LOCALCODE_LOG_LEVEL as LogLevel) || "info",
);
