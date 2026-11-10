/**
 * Redaction runs on untrusted upstream text of any size before the 100 KB
 * cap, so it must be linear-time. The previous regexes were quadratic or
 * cubic: a 16 KB tool result of repeated "-token" took about 57 s.
 */
import { describe, expect, it } from "vitest";
import { REDACTED, errorResult, redactText, sanitizeToolResult } from "../sanitize.js";

const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

const HEADER = "eyJhbGciOiJIUzI1NiJ9";
const PAYLOAD = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
const SIG = "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const JWT = `${HEADER}.${PAYLOAD}.${SIG}`;
const JWT2 = "eyJraWQiOiJrMiJ9.eyJzdWIiOiJzZWNvbmQtdXNlciJ9.c2Vjb25kLXNpZ25hdHVyZS12YWx1ZQ";

/** Every part of a JWT that must not survive redaction. */
function expectGone(out: string, jwt: string) {
  const [h, p, s] = jwt.split(".");
  expect(out).not.toContain(h);
  expect(out).not.toContain(p);
  if (s) expect(out).not.toContain(s);
}

describe("redaction runs in linear time", () => {
  const cases: Array<[string, (n: number) => string]> = [
    ["-eyJ repeated", (n) => fill("-eyJ", n)],
    ["eyJ repeated", (n) => fill("eyJ", n)],
    ["chained JWT-shaped segments", (n) => fill("eyJabcdefgh.", n)],
    ["back-to-back JWTs", (n) => fill(JWT, n)],
    ["-token repeated", (n) => fill("-token", n)],
    ["token repeated", (n) => fill("token", n)],
    ["token= repeated", (n) => fill("token=", n)],
    ["token: with long whitespace", (n) => `token:${" ".repeat(n - 6)}`],
    ["sk-style key run", (n) => fill("sk-api_key-", n)],
    ["unclosed quoted key", (n) => `"${fill("token", n - 1)}`],
    ["escaped quotes", (n) => `"${fill('\\"', n - 1)}`],
    ["quoted keys without colons", (n) => fill('"x-token-x" ', n)],
    ["Bearer repeated", (n) => fill("Bearer ", n)],
    ["Bearer then whitespace", (n) => `Bearer${" ".repeat(n - 6)}`],
    ["Bearer glued to dashes", (n) => fill("Bearer-", n)],
    ["Basic repeated", (n) => fill("Basic ", n)],
    ["glued JWT-shaped segments", (n) => fill("xeyJabcdefgh.", n)],
    ["[REDACTED]. repeated", (n) => fill(`${REDACTED}.x`, n)],
  ];

  const bestMs = (fn: () => void) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it.each(cases)("%s: 4M chars under 500 ms, roughly linear from 1M", (_name, make) => {
    const small = make(1_000_000);
    const large = make(4_000_000);
    redactText(small); // warm up
    const t1 = bestMs(() => redactText(small));
    const t4 = bestMs(() => redactText(large));
    expect(t4).toBeLessThan(500);
    // Floor at 5 ms so timer noise on a very fast run cannot fail the ratio.
    expect(t4 / Math.max(t1, 5)).toBeLessThan(8);
  });

  it("sanitizeToolResult and errorResult stay fast on hostile text", () => {
    const hostile = `{"note":"${fill("-token", 4_000_000)}`;
    const start = performance.now();
    const res = sanitizeToolResult({ content: [{ type: "text", text: hostile }] });
    errorResult("upstream_error", hostile);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(res.content[0].text.length).toBeLessThan(110_000);
  });
});

describe("no regex stack overflow on huge values", () => {
  // A regex repeat such as "(?:[^"\\]|\\.)*" or [A-Za-z0-9+/=]{8,} throws
  // RangeError once one match spans a few million characters.
  const N = 32_000_000;
  const big = "a".repeat(N);
  it.each([
    ["JSON string value", `{"token":"${big}"}`, `{"token":"${REDACTED}"}`],
    ["JSON string value with escapes", `{"token":"${"\\n".repeat(N / 2)}"}`, `{"token":"${REDACTED}"}`],
    ["JSON number value", `{"token":${"1".repeat(N)}}`, `{"token":"${REDACTED}"}`],
    ["plain quoted value", `token="${big}" x`, `token=${REDACTED} x`],
    ["plain bare value", `token=${big} x`, `token=${REDACTED} x`],
    ["Bearer token", `Bearer ${big} x`, `Bearer ${REDACTED} x`],
    ["Basic token", `Basic ${big} x`, `Basic ${REDACTED} x`],
    ["JWT signature", `eyJabcdefgh.abcdefgh.${big} x`, `${REDACTED} x`],
  ])("%s of 32M chars", (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("leaves a 32M-char unclosed JSON string alone", () => {
    const input = `{"token":"${big}`;
    expect(redactText(input)).toBe(input);
  });
});

describe("JWT redaction", () => {
  it("redacts a JWT glued to the end of another JWT", () => {
    const out = redactText(`a ${JWT}${JWT2} b`);
    expectGone(out, JWT);
    expectGone(out, JWT2);
    expect(out).toBe(`a ${REDACTED} b`);
  });

  it("redacts back-to-back JWTs separated by a dot, a dash or nothing", () => {
    for (const sep of [".", "-", "", "_"]) {
      const out = redactText(`${JWT}${sep}${JWT2}${sep}${JWT}`);
      expectGone(out, JWT);
      expectGone(out, JWT2);
    }
  });

  it("redacts a JWT glued after a word, keeping the word", () => {
    const out = redactText(`id_${JWT} end`);
    expectGone(out, JWT);
    expect(out).toBe(`id_${REDACTED} end`);
  });

  it("redacts a JWT that follows other dot-separated segments", () => {
    const out = redactText(`host.example.com.${JWT}`);
    expectGone(out, JWT);
    expect(out).toBe(`host.example.com.${REDACTED}`);
  });

  it("redacts a JWT whose header follows a JWT-shaped segment", () => {
    // The first segment passes for a header, so the real header is taken as its
    // payload. The real JWT starts inside that match and must extend it.
    for (const prefix of ["xeyJaaaaa.", "eyJaaaaa.", "id-eyJaaaaa.", `${HEADER}.`]) {
      const out = redactText(`a ${prefix}${JWT} b`);
      expectGone(out, JWT);
      expect(out).toMatch(/^a \S*\[REDACTED\] b$/);
    }
  });

  it("still redacts an unsigned JWT (empty signature)", () => {
    expect(redactText(`t=x ${HEADER}.${PAYLOAD}. end`)).toBe(`t=x ${REDACTED} end`);
  });

  it("leaves text that only looks partly like a JWT alone", () => {
    for (const text of ["eyJ", "eyJabc.def.ghi", `${HEADER}.abcd.efgh`, "version 1.2.3", "a.b.c.d.e.f"]) {
      expect(redactText(text)).toBe(text);
    }
  });
});

describe("key/value redaction is unchanged", () => {
  it.each([
    ['{"token":"abc123"}', '{"token":"[REDACTED]"}'],
    ['{"next_page_token" : -12.5e3, "a":1}', '{"next_page_token" : "[REDACTED]", "a":1}'],
    ['{"x\\"token":"v\\"x","y":"keep"}', '{"x\\"token":"[REDACTED]","y":"keep"}'],
    ["client_secret=s3cr3t&grant_type=client_credentials", "client_secret=[REDACTED]&grant_type=client_credentials"],
    ["x-api-key: 'abc def' next", "x-api-key: [REDACTED] next"],
    ["Password = \"a b\"; user=bob", "Password = [REDACTED]; user=bob"],
    ["refresh_token:abc,ok", "refresh_token:[REDACTED],ok"],
    ["sk-live-token=sk_live_abc}", "sk-live-token=[REDACTED]}"],
  ])("%s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    "tokenization is fun",
    "the token was rotated",
    "sk-abc123 is not a key name",
    '{"title":"secret santa","n":3}',
    "Bearer",
    "Basic auth is disabled",
  ])("leaves %j untouched", (text) => {
    expect(redactText(text)).toBe(text);
  });
});

/**
 * The regexes this module used before it switched to scanners. They are
 * super-linear, so they run here only on short inputs, as the reference that
 * the scanners must never redact less than.
 */
function legacyRedactText(text: string): string {
  const key = "(?:secret|password|token|access_token|refresh_token|api[_-]?key|authorization|client_secret)";
  const jsonKv = new RegExp(
    `("(?:[^"\\\\]|\\\\.)*${key}(?:[^"\\\\]|\\\\.)*"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?[\\w.+-]+)`,
    "gi"
  );
  const plainKv = new RegExp(`(\\b[\\w-]*${key}[\\w-]*\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'}]+)`, "gi");
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, `Basic ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(jsonKv, (_m, prefix: string) => `${prefix}"${REDACTED}"`)
    .replace(plainKv, (_m, prefix: string) => `${prefix}${REDACTED}`);
}

describe("never redacts less than the legacy regexes", () => {
  /** Deterministic PRNG (mulberry32) so a failure reproduces. */
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const NOISE = ["eyJ", "eyJaaaaa", "xeyJaaaaa", ".", "-", "_", " ", "x", '"', "\\", ":", "=", "token", "'", "}", "\n", ",", "Bearer ", "Basic ", "{", "&"];
  // Each planted secret carries unique markers ("S7zS"), so a marker that the
  // legacy output lacks must be missing from the new output too.
  const PLANTS: Array<(mark: (tag: string) => string) => string> = [
    (mark) => `eyJ${mark("H")}hdr.${mark("P")}pay.${mark("S")}sig`,
    (mark) => `eyJ${mark("H")}hdr.${mark("P")}pay.`,
    (mark) => `token=${mark("V")}`,
    (mark) => `"api_key": "${mark("V")}"`,
    (mark) => `"x_token":${mark("V")}`,
    (mark) => `password: '${mark("V")} v'`,
    (mark) => `Bearer ${mark("B")}tokenxx`,
    (mark) => `Basic ${mark("Q")}basicxx`,
  ];
  const VERIFIER = [`xeyJaaaaa.${JWT}`, `eyJaaaaa.${JWT}`, `id-eyJaaaaa.${JWT}`, `${JWT}${JWT2}`];

  function check(input: string, secrets: string[]) {
    const legacy = legacyRedactText(input);
    const current = redactText(input);
    for (const s of secrets) {
      if (!legacy.includes(s)) expect(current, `input ${JSON.stringify(input)}`).not.toContain(s);
    }
    // The passes before the last JWT pass reproduce the legacy output exactly;
    // the last pass only acts on "eyJ" or "[REDACTED]." in it.
    if (!legacy.includes("eyJ") && !legacy.includes(`${REDACTED}.`)) {
      expect(current, `input ${JSON.stringify(input)}`).toBe(legacy);
    }
  }

  it.each(VERIFIER)("%s", (input) => {
    check(input, [SIG, JWT2.split(".")[2]]);
  });

  it("on 20k random secret-bearing inputs", () => {
    const next = rng(8);
    const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];
    for (let iter = 0; iter < 20_000; iter++) {
      const markers: string[] = [];
      const mark = (tag: string) => {
        const marker = `${tag}${markers.length}z${tag}`;
        markers.push(marker);
        return marker;
      };
      const parts: string[] = [];
      for (let p = 1 + Math.floor(next() * 12); p > 0; p--) {
        parts.push(next() < 0.5 ? pick(NOISE) : pick(PLANTS)(mark));
      }
      check(parts.join(""), markers);
    }
  });
});
