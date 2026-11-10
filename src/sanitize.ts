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
 * every pass is linear-time and free of regex repeats. A regex with an
 * unbounded repeat on each side of the key alternation, such as
 * \b[\w-]*KEY[\w-]*, retries from every start position and is cubic on text
 * like "-token-token…". A repeat that one match can stretch over millions of
 * characters, such as "(?:[^"\\]|\\.)*" or [A-Za-z0-9+/=]{8,}, overflows V8's
 * regex backtracking stack and throws RangeError. Keys, values, tokens and
 * JWTs are therefore found by forward scans; the only regexes left match a
 * fixed word (KEY_PATTERN, BEARER_WORD, BASIC_WORD) or two characters.
 */

const BEARER_WORD = /\bBearer/gi;
const BASIC_WORD = /\bBasic/gi;
const JSON_ESCAPE = /\\./g;

const QUOTE = 0x22;
const APOSTROPHE = 0x27;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const COLON = 0x3a;
const EQUALS = 0x3d;

/** [A-Za-z0-9]. */
function isAlnum(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
}

/** [A-Za-z0-9_-]: a plain-text key character, and a JWT segment character. */
function isKeyChar(c: number): boolean {
  return isAlnum(c) || c === 0x5f || c === 0x2d;
}

/** Regex \w: [A-Za-z0-9_]. */
function isWordChar(c: number): boolean {
  return isAlnum(c) || c === 0x5f;
}

/** Regex \s (without the u flag). */
function isSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The characters a regex `.` does not match. */
function isLineTerminator(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

function skipSpaces(text: string, i: number): number {
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

function skipWhile(text: string, i: number, accept: (c: number) => boolean): number {
  while (i < text.length && accept(text.charCodeAt(i))) i++;
  return i;
}

/** [A-Za-z0-9._~+/=-]: a Bearer token character. */
const isBearerChar = (c: number) =>
  isKeyChar(c) || c === DOT || c === 0x7e || c === 0x2b || c === 0x2f || c === EQUALS;
/** [A-Za-z0-9+/=]: a Basic credential character. */
const isBasicChar = (c: number) => isAlnum(c) || c === 0x2b || c === 0x2f || c === EQUALS;
/** [\w.+-]: a bare JSON value character (number, true, false, null). */
const isBareJsonChar = (c: number) => isKeyChar(c) || c === DOT || c === 0x2b;
/** A bare plain-text value runs up to whitespace or one of , ; & " ' }. */
const isBarePlainChar = (c: number) =>
  !isSpace(c) && c !== 0x2c && c !== 0x3b && c !== 0x26 && c !== QUOTE && c !== APOSTROPHE && c !== 0x7d;

/**
 * "Bearer <token>" / "Basic <token>": the scheme word at a word boundary,
 * whitespace, then at least 8 token characters. The whole match becomes
 * "<scheme> [REDACTED]". A failed attempt reads the whitespace after one
 * scheme word and at most 8 token characters, so the pass is linear.
 */
function redactScheme(text: string, word: RegExp, scheme: string, isTokenChar: (c: number) => boolean): string {
  const out: string[] = [];
  let copied = 0;
  word.lastIndex = 0;
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    const token = skipSpaces(text, word.lastIndex);
    if (token === word.lastIndex) continue;
    const end = skipWhile(text, token, isTokenChar);
    if (end - token < 8) continue;
    out.push(text.slice(copied, m.index), `${scheme} ${REDACTED}`);
    copied = word.lastIndex = end;
  }
  out.push(text.slice(copied));
  return out.join("");
}

/**
 * The value after a JSON key whose closing quote is at `i - 1`: \s*:\s* then
 * a string ("…", with escapes) or a run of [\w.+-]. Returns [value start,
 * value end], or null when no value follows.
 */
function jsonValueAt(text: string, i: number): [number, number] | null {
  i = skipSpaces(text, i);
  if (text.charCodeAt(i) !== COLON) return null;
  const value = skipSpaces(text, i + 1);
  let end: number;
  if (text.charCodeAt(value) === QUOTE) {
    end = scanString(text, value + 1);
    if (text.charCodeAt(end) !== QUOTE) return null;
    end++;
  } else {
    end = skipWhile(text, value, isBareJsonChar);
  }
  return end > value ? [value, end] : null;
}

/**
 * The value after a plain-text key ending at `i`: \s*[=:]\s* then "…", '…'
 * or a bare run. Returns [value start, value end], or null.
 */
function plainValueAt(text: string, i: number): [number, number] | null {
  i = skipSpaces(text, i);
  const sep = text.charCodeAt(i);
  if (sep !== EQUALS && sep !== COLON) return null;
  const value = skipSpaces(text, i + 1);
  const open = text.charCodeAt(value);
  let end: number;
  if (open === QUOTE || open === APOSTROPHE) {
    // Once a quote has no partner, no later quote of that kind does, so at
    // most one failed search per kind reads to the end of the text.
    const close = text.indexOf(text[value], value + 1);
    if (close === -1) return null;
    end = close + 1;
  } else {
    end = skipWhile(text, value, isBarePlainChar);
  }
  return end > value ? [value, end] : null;
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
    const value = isKey ? jsonValueAt(text, close + 1) : null;
    if (value) {
      out.push(text.slice(copied, value[0]), `"${REDACTED}"`);
      copied = value[1];
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
    const value = plainValueAt(text, i);
    if (!value) continue;
    out.push(text.slice(copied, value[0]), REDACTED);
    i = copied = value[1];
  }
  out.push(text.slice(copied));
  return out.join("");
}

/**
 * Index of the first "eyJ" inside text[from, to), or -1. Never looks past
 * `to`. With `boundary`, only an "eyJ" at a regex \b counts.
 */
function findEyJ(text: string, from: number, to: number, boundary: boolean): number {
  for (let i = from; i + 3 <= to; i++) {
    if (
      text.charCodeAt(i) === 0x65 &&
      text.charCodeAt(i + 1) === 0x79 &&
      text.charCodeAt(i + 2) === 0x4a &&
      !(boundary && i > 0 && isWordChar(text.charCodeAt(i - 1)))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * JWT-shaped tokens: "eyJ" plus at least 5 segment characters, "." plus at
 * least 5, "." plus any number (an unsigned JWT has an empty signature).
 *
 * The first pass (`glued` false) redacts exactly what the former regex
 * \beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]* redacted.
 *
 * The second pass (`glued` true) runs after the key/value passes and redacts
 * what the first one missed:
 * - a JWT glued to a word ("id_eyJ…"): redaction starts at the "eyJ";
 * - a JWT that starts inside another one ("eyJx.<jwt>", "<jwt><jwt>"): the
 *   redaction extends to the end of the last one;
 * - the rest of a JWT whose start the first pass already redacted: a run that
 *   opens with "." right after "[REDACTED]" is redacted together with it.
 *
 * O(n): each maximal run of [A-Za-z0-9_.-] is split into its "."-separated
 * segments once, and each segment is searched for "eyJ" at most once.
 */
function redactJwts(text: string, glued: boolean): string {
  if (!text.includes("eyJ") && !(glued && text.includes(`${REDACTED}.`))) return text;
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!isKeyChar(text.charCodeAt(i)) && text.charCodeAt(i) !== DOT) {
      i++;
      continue;
    }
    const run = i;
    const starts = [i];
    const ends: number[] = [];
    for (; i < text.length && (isKeyChar(text.charCodeAt(i)) || text.charCodeAt(i) === DOT); i++) {
      if (text.charCodeAt(i) === DOT) {
        ends.push(i);
        starts.push(i + 1);
      }
    }
    ends.push(i);
    const n = starts.length;
    const length = (k: number) => ends[k] - starts[k];
    /** Start of a JWT whose header is segment k, or -1. */
    const jwtAt = (k: number): number => {
      if (k + 2 >= n || length(k + 1) < 5) return -1;
      const at = findEyJ(text, starts[k], ends[k], !glued);
      return at !== -1 && ends[k] - at >= 8 ? at : -1;
    };
    // "[REDACTED].<seg>[.<seg>]": the redacted text is taken as the header
    // (or header and payload) of a JWT, so its payload and signature go too.
    const continued = glued && n > 1 && length(0) === 0 && length(1) > 0 && text.endsWith(REDACTED, run);
    for (let k = 0; k < n; ) {
      let from = jwtAt(k);
      let last = k + 2;
      if (k === 0 && continued) {
        from = run - REDACTED.length;
        last = n > 2 && length(1) >= 5 ? 2 : 1;
      }
      if (from === -1) {
        k++;
        continue;
      }
      if (glued) {
        for (let j = k + 1; j <= last; j++) if (jwtAt(j) !== -1) last = Math.max(last, j + 2);
      }
      out.push(text.slice(copied, from), REDACTED);
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
    redactScheme(redactScheme(text, BEARER_WORD, "Bearer", isBearerChar), BASIC_WORD, "Basic", isBasicChar),
    false
  );
  // Up to here the output is exactly that of the former regexes. Redacting
  // more JWT text before the key/value passes could remove a key name
  // ("…eyJ….payload.password: x" would lose "password") and let its value
  // through, so the extra JWT redaction runs last and only adds to it.
  return redactJwts(redactPlainValues(redactJsonValues(tokensGone)), true);
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
