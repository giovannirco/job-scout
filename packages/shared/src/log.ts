/**
 * Structured logger. One JSON object per line on stdout (production / LOG_FORMAT=json),
 * or a compact human line in dev. No dependencies; Loki parses it with `| json`.
 *
 *   { "ts": "...", "level": "info", "component": "worker", "msg": "job.ok", "type": "triage", "ms": 1653 }
 *
 * Levels: debug < info < warn < error. LOG_LEVEL selects the floor (default info).
 * Every process should call `setLogContext({ component })` once at boot; child loggers add fields.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// apps/web imports this package's barrel, so this module is evaluated in the browser
// too, where `process` does not exist. Read env defensively rather than at the top level.
const env: Record<string, string | undefined> = typeof process !== "undefined" && process.env ? process.env : {};

const envFormat = env.LOG_FORMAT || (env.NODE_ENV === "production" ? "json" : "pretty");
const envLevel = (env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
const FLOOR = LEVELS[envLevel] ?? LEVELS.info;

let baseContext: LogFields = {};

/** Process-wide fields (component, version). Call once at boot. */
export function setLogContext(fields: LogFields) {
  baseContext = { ...baseContext, ...fields };
}

export function isLogFormatJson(): boolean {
  return envFormat === "json";
}

function serializeError(e: unknown): LogFields {
  if (e instanceof Error) {
    const out: LogFields = { error: e.message, errorName: e.name };
    if (e.stack) out.stack = e.stack.split("\n").slice(0, 8).join("\n");
    const cause = (e as { cause?: unknown }).cause;
    if (cause) out.cause = cause instanceof Error ? cause.message : String(cause);
    return out;
  }
  return { error: String(e) };
}

function normalize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === "err" || k === "error") {
      if (v instanceof Error) Object.assign(out, serializeError(v));
      else out.error = typeof v === "string" ? v : JSON.stringify(v);
      continue;
    }
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

const PRETTY_COLORS: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function write(level: LogLevel, msg: string, fields: LogFields) {
  if (LEVELS[level] < FLOOR) return;
  const record: LogFields & { ts: string; level: LogLevel; msg: string } = { ts: new Date().toISOString(), level, ...baseContext, msg, ...normalize(fields) };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (envFormat === "json") {
    stream.write(JSON.stringify(record) + "\n");
    return;
  }
  const { ts, level: _l, msg: _m, component, ...rest } = record;
  const kv = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(" ");
  const time = String(ts).slice(11, 19);
  const c = PRETTY_COLORS[level];
  stream.write(`${c}${time} ${level.padEnd(5)}${RESET} ${component ? `[${String(component)}] ` : ""}${msg}${kv ? " " + kv : ""}\n`);
}

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export function createLogger(bound: LogFields = {}): Logger {
  const emit = (level: LogLevel) => (msg: string, fields: LogFields = {}) => write(level, msg, { ...bound, ...fields });
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createLogger({ ...bound, ...fields }),
  };
}

/** Root logger; use `log.child({ scope: "scan" })` for module-level loggers. */
export const log = createLogger();
