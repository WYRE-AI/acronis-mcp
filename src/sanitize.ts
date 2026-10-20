/**
 * Sanitising of everything that comes back from the upstream child process.
 * Caps size, redacts secret-looking values, and normalises errors so
 * credentials are never echoed to the caller.
 */

export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_ERROR_MESSAGE = 500;
export const REDACTED = "[REDACTED]";
export const TRUNCATION_MARKER = "\n…[truncated: response exceeded 100 KB]";

const SENSITIVE_KEY =
  "(?:secret|password|token|access_token|refresh_token|api[_-]?key|authorization|client_secret)";
const KEY_PATTERN = new RegExp(SENSITIVE_KEY, "i");

// "key": "value" / "key": 123 / "key": true|null in JSON text (also with escaped quotes).
// The key may contain the sensitive word anywhere (e.g. "next_page_token").
const JSON_KV_RE = new RegExp(
  `("(?:[^"\\\\]|\\\\.)*${SENSITIVE_KEY}(?:[^"\\\\]|\\\\.)*"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?[\\w.+-]+)`,
  "gi"
);
// key=value / key: value in plain text (query strings, logs, error messages).
const PLAIN_KV_RE = new RegExp(
  `(\\b[\\w-]*${SENSITIVE_KEY}[\\w-]*\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'}]+)`,
  "gi"
);
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

/** Redact secret values and token-shaped strings from arbitrary text. */
export function redactText(text: string): string {
  // Bearer/Basic/JWT first so "Authorization: Bearer xyz" loses the token, not just the scheme word.
  return text
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(BASIC_RE, `Basic ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(JSON_KV_RE, (_m, prefix: string) => `${prefix}"${REDACTED}"`)
    .replace(PLAIN_KV_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

/**
 * Redact tool-result text. JSON text is redacted structurally first (so object
 * and array values under sensitive keys are removed whole), then the regex
 * pass catches anything left plus non-JSON text.
 */
export function redactResultText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      text = JSON.stringify(redactStructured(JSON.parse(text)));
    } catch {
      /* not JSON — fall through to the regex pass */
    }
  }
  return redactText(text);
}

/** Cap to 100 KB (UTF-8 bytes) with a visible marker. */
export function capText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Slice on bytes, then drop a possibly split trailing code point.
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return sliced + TRUNCATION_MARKER;
}

/** Redact then cap. Redaction first so a secret straddling the cut cannot survive. */
export function sanitizeText(text: string): string {
  return capText(redactText(text));
}

export function isSensitiveKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export interface SanitizedContent {
  type: "text";
  text: string;
}

export interface SanitizedResult {
  content: SanitizedContent[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Build the caller-facing error payload: {error:{code,message}}. */
export function errorResult(
  code: string,
  message: string,
  secrets: readonly string[] = []
): SanitizedResult {
  let msg = redactText(String(message));
  for (const s of secrets) {
    if (s.length >= 4) msg = msg.split(s).join(REDACTED);
  }
  if (msg.length > MAX_ERROR_MESSAGE) msg = msg.slice(0, MAX_ERROR_MESSAGE - 1) + "…";
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message: msg } }) }],
  };
}

function redactStructured(value: unknown, depth = 0, secrets: readonly string[] = []): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === "string") {
    let text = redactText(value);
    for (const s of secrets) if (s.length >= 4) text = text.split(s).join(REDACTED);
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactStructured(v, depth + 1, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactStructured(v, depth + 1, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Sanitise a tools/call result from upstream. Only text content is passed
 * through (capped + redacted); non-text blocks are dropped. Upstream errors
 * become {error:{code,message}}.
 */
export function sanitizeToolResult(
  result: { content?: unknown; isError?: boolean; structuredContent?: unknown },
  secrets: readonly string[] = []
): SanitizedResult {
  const blocks = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: unknown }>) : [];
  const texts = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string") as SanitizedContent[];

  if (result.isError) {
    const message = texts.map((b) => b.text).join("\n") || "Upstream tool call failed";
    return errorResult("upstream_error", message, secrets);
  }

  let content: SanitizedContent[] = texts.map((b) => {
    let text = redactResultText(b.text);
    for (const s of secrets) if (s.length >= 4) text = text.split(s).join(REDACTED);
    return { type: "text", text: capText(text) };
  });
  if (content.length === 0) content = [{ type: "text", text: "" }];

  const out: SanitizedResult = { content };
  if (result.structuredContent !== undefined) {
    const structured = redactStructured(result.structuredContent, 0, secrets);
    // Structured payloads must obey the same cap; drop rather than truncate JSON.
    if (Buffer.byteLength(JSON.stringify(structured), "utf8") <= MAX_TEXT_BYTES) {
      out.structuredContent = structured;
    }
  }
  return out;
}
