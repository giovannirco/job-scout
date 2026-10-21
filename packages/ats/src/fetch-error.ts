/**
 * Why an ATS fetch produced no posting. Callers store this in
 * metadata.lastAtsFetch and return it from refresh/intake so "fetch failed"
 * never reaches the operator without a cause.
 */
export type AtsFetchFailureReason =
  | "http_status"
  | "blocked"
  | "timeout"
  | "network"
  | "parse_failed"
  | "unsupported_provider";

export type AtsFetchFailure = {
  reason: AtsFetchFailureReason;
  message: string;
  httpStatus?: number;
  url?: string;
  provider?: string;
  /** Low-level cause code (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, …). */
  causeCode?: string;
};

export class AtsFetchError extends Error {
  readonly reason: AtsFetchFailureReason;
  readonly httpStatus?: number;
  readonly url?: string;
  readonly provider?: string;
  readonly causeCode?: string;

  constructor(failure: AtsFetchFailure, options?: { cause?: unknown }) {
    super(failure.message, options);
    this.name = "AtsFetchError";
    this.reason = failure.reason;
    this.httpStatus = failure.httpStatus;
    this.url = failure.url;
    this.provider = failure.provider;
    this.causeCode = failure.causeCode;
  }

  toJSON(): AtsFetchFailure {
    return {
      reason: this.reason,
      message: this.message,
      ...(this.httpStatus != null ? { httpStatus: this.httpStatus } : {}),
      ...(this.url ? { url: this.url } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.causeCode ? { causeCode: this.causeCode } : {}),
    };
  }
}

/** Status codes that mean a bot wall / auth gate rather than a missing or broken page (429 is a retryable http_status). */
const BLOCKING_STATUS = new Set([401, 403, 407, 451]);

const BLOCKED_MESSAGE_RE = /(must address a public|non-public address|no public address|redirect cannot downgrade|too many ats redirects)/i;
const TIMEOUT_CODE_RE = /^(UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT)$/;

function causeChain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    out.push(current);
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return out;
}

function errorCode(e: unknown): string | undefined {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && code ? code : undefined;
}

/** HTTP failure → structured reason (401/403 read as a block, the rest as http_status). */
export function httpFailure(status: number, ctx: { url?: string; provider?: string } = {}): AtsFetchError {
  const reason: AtsFetchFailureReason = BLOCKING_STATUS.has(status) ? "blocked" : "http_status";
  return new AtsFetchError({ reason, httpStatus: status, message: `${ctx.provider || "ats"} fetch returned HTTP ${status}`, ...ctx });
}

/**
 * Map any thrown value to a structured failure. Undici reports every
 * network-level problem as `TypeError: fetch failed`; the useful part is
 * in `cause` (DNS, TLS, reset, the SSRF guard in public-fetch).
 */
export function classifyFetchError(error: unknown, ctx: { url?: string; provider?: string } = {}): AtsFetchError {
  if (error instanceof AtsFetchError) {
    if ((error.url || !ctx.url) && (error.provider || !ctx.provider)) return error;
    return new AtsFetchError({ ...error.toJSON(), url: error.url || ctx.url, provider: error.provider || ctx.provider }, { cause: error.cause });
  }
  const chain = causeChain(error);
  const messages = chain.map((e) => (e instanceof Error ? e.message : String(e)));
  const codes = chain.map(errorCode).filter((c): c is string => Boolean(c));
  const names = chain.map((e) => (e instanceof Error ? e.name : ""));
  const causeCode = codes[0];
  const detail = messages.filter(Boolean).join(": ").slice(0, 300) || "fetch failed";
  if (names.some((n) => n === "AbortError" || n === "TimeoutError") || codes.some((c) => TIMEOUT_CODE_RE.test(c))) {
    return new AtsFetchError({ reason: "timeout", message: `timed out: ${detail}`, causeCode, ...ctx }, { cause: error });
  }
  if (messages.some((m) => BLOCKED_MESSAGE_RE.test(m))) {
    return new AtsFetchError({ reason: "blocked", message: detail, causeCode, ...ctx }, { cause: error });
  }
  if (names.some((n) => n === "SyntaxError")) {
    return new AtsFetchError({ reason: "parse_failed", message: `could not parse the response: ${detail}`, causeCode, ...ctx }, { cause: error });
  }
  const status = messages.map((m) => m.match(/(?:fetch failed|board [^:]*|job [^:]*|failed):\s*(\d{3})\b/i)?.[1]).find(Boolean);
  if (status) return httpFailure(Number(status), ctx);
  return new AtsFetchError({ reason: "network", message: detail, causeCode, ...ctx }, { cause: error });
}
