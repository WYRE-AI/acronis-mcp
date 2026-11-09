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
