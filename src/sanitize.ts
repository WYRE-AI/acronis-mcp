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

/*
 * Redaction runs on untrusted upstream text of any size (before the cap), so
 * every pass is linear-time. A regex with an unbounded repeat on each side of
 * the key alternation, such as \b[\w-]*KEY[\w-]*, retries from every start
 * position and is cubic on text like "-token-token…". Keys and JWTs are
 * therefore found by single forward scans; regexes are kept only where they
 * are anchored (sticky) at one position or their parts cannot overlap.
 */

// Linear: the scheme word, \s+ and the token class are disjoint, so a failed
// attempt re-reads only the whitespace after one "Bearer"/"Basic".
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;

// Value tails, matched once at the end of a candidate key (sticky). Group 1
// is the separator that is kept; the rest is the value that is replaced.
// "key": "value" / "key": 123 / "key": true|null in JSON text.
const JSON_VALUE_TAIL = /(\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?[\w.+-]+)/y;
// key=value / key: value in plain text (query strings, logs, error messages).
const PLAIN_VALUE_TAIL = /(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"'}]+)/y;
const JSON_ESCAPE = /\\./g;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const DOT = 0x2e;

/** [A-Za-z0-9_-]: a plain-text key character, and a JWT segment character. */
function isKeyChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d;
}

/** The characters a regex `.` does not match. */
function isLineTerminator(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/**
 * Scans JSON string content from `i`. Returns the index of the closing quote,
 * or, when the string cannot close (a backslash before a line break or the
 * end of text), the index where it stopped, which holds no quote.
 */
function scanString(text: string, i: number): number {
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) return i;
    if (c === BACKSLASH) {
      if (i + 1 >= text.length || isLineTerminator(text.charCodeAt(i + 1))) return i;
      i++;
    }
  }
  return i;
}

/**
 * "key": value in JSON text, where the key contains a sensitive word anywhere
 * (e.g. "next_page_token"). Matches what the former regex matched: every
 * quote is tried as an opening quote, including a closing one. A quote
 * skipped over as escaped resumes the same scan, so it can only fail the same
 * way; each character is therefore scanned a bounded number of times.
 */
function redactJsonValues(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let q = text.indexOf('"');
  while (q !== -1) {
    const close = scanString(text, q + 1);
    if (text.charCodeAt(close) !== QUOTE) {
      q = text.indexOf('"', close);
      continue;
    }
    // An escape pair is one unit: "\t" + "oken" is not "token".
    const isKey = KEY_PATTERN.test(text.slice(q + 1, close).replace(JSON_ESCAPE, "  "));
    const tail = isKey ? matchAt(JSON_VALUE_TAIL, text, close + 1) : null;
    if (tail) {
      out.push(text.slice(copied, close + 1 + tail[1].length), `"${REDACTED}"`);
      copied = close + 1 + tail[0].length;
      q = text.indexOf('"', copied);
    } else {
      q = close;
    }
  }
  out.push(text.slice(copied));
  return out.join("");
}

/** key=value / key: value in plain text, where the key is a run of [A-Za-z0-9_-] containing a sensitive word. */
function redactPlainValues(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!isKeyChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && isKeyChar(text.charCodeAt(i))) i++;
    if (!KEY_PATTERN.test(text.slice(start, i))) continue;
    const tail = matchAt(PLAIN_VALUE_TAIL, text, i);
    if (!tail) continue;
    out.push(text.slice(copied, i + tail[1].length), REDACTED);
    i = copied = i + tail[0].length;
  }
  out.push(text.slice(copied));
  return out.join("");
}

/** Index of the first "eyJ" inside text[from, to), or -1. Never looks past `to`. */
function findEyJ(text: string, from: number, to: number): number {
  for (let i = from; i + 3 <= to; i++) {
    if (text.charCodeAt(i) === 0x65 && text.charCodeAt(i + 1) === 0x79 && text.charCodeAt(i + 2) === 0x4a) return i;
  }
  return -1;
}

/**
 * JWT-shaped tokens: "eyJ" plus at least 5 segment characters, "." plus at
 * least 5, "." plus any number (an unsigned JWT has an empty signature).
 * Redaction starts at the "eyJ", so a token glued to a word is still caught.
 * A JWT glued to the end of the previous one ("…signature" + "eyJ…") extends
 * the redaction, so its payload and signature cannot survive.
 *
 * O(n): each maximal run of [A-Za-z0-9_.-] is split into its "."-separated
 * segments once, and each segment is searched for "eyJ" at most twice.
 */
function redactJwts(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!isKeyChar(text.charCodeAt(i)) && text.charCodeAt(i) !== DOT) {
      i++;
      continue;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    let start = i;
    for (; i < text.length && (isKeyChar(text.charCodeAt(i)) || text.charCodeAt(i) === DOT); i++) {
      if (text.charCodeAt(i) === DOT) {
        starts.push(start);
        ends.push(i);
        start = i + 1;
      }
    }
    starts.push(start);
    ends.push(i);
    // Start of a JWT whose header is in segment k, or -1.
    const jwtAt = (k: number): number => {
      if (k + 2 >= starts.length || ends[k + 1] - starts[k + 1] < 5) return -1;
      const at = findEyJ(text, starts[k], ends[k]);
      return at !== -1 && ends[k] - at >= 8 ? at : -1;
    };
    for (let k = 0; k + 2 < starts.length; ) {
      const at = jwtAt(k);
      if (at === -1) {
        k++;
        continue;
      }
      let last = k + 2;
      while (jwtAt(last) !== -1) last += 2;
      out.push(text.slice(copied, at), REDACTED);
      copied = ends[last];
      k = last + 1;
    }
  }
  out.push(text.slice(copied));
  return out.join("");
}

/** Redact secret values and token-shaped strings from arbitrary text. Linear in the text length. */
export function redactText(text: string): string {
  // Bearer/Basic/JWT first so "Authorization: Bearer xyz" loses the token, not just the scheme word.
  const tokensGone = redactJwts(
    text.replace(BEARER_RE, `Bearer ${REDACTED}`).replace(BASIC_RE, `Basic ${REDACTED}`)
  );
  return redactPlainValues(redactJsonValues(tokensGone));
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
