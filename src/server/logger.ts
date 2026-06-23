type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, message: string, meta?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](prefix, message, meta);
  } else {
    // eslint-disable-next-line no-console
    console[level === "debug" ? "log" : level](prefix, message);
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
  debug: (message: string, meta?: unknown) => {
    if (process.env.DEBUG) emit("debug", message, meta);
  },
};
