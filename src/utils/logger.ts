/**
 * Stderr-only logger. stdout is reserved for the MCP JSON-RPC channel in
 * stdio mode, so every log line goes to stderr regardless of transport.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = JSON.stringify({
    level,
    message,
    ...(meta ?? {}),
    timestamp: new Date().toISOString(),
  });
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
