import { describe, expect, it } from "vitest";
import {
  MAX_ERROR_MESSAGE,
  MAX_TEXT_BYTES,
  REDACTED,
  TRUNCATION_MARKER,
  capText,
  errorResult,
  redactText,
  sanitizeToolResult,
} from "../sanitize.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redactText", () => {
  it.each([
    "secret",
    "password",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "api-key",
    "apikey",
    "authorization",
    "client_secret",
    "next_page_token",
    "Client_Secret",
  ])("redacts JSON string values under key %s", (key) => {
    const out = redactText(JSON.stringify({ [key]: "hunter2-value", keep: "visible" }));
    expect(out).not.toContain("hunter2-value");
    expect(out).toContain(REDACTED);
    expect(out).toContain("visible");
  });

  it("redacts non-string JSON values and nested keys", () => {
    const out = redactText('{"a":{"password":12345,"token":null},"b":[{"secret":true}]}');
    expect(out).not.toContain("12345");
    expect(out).not.toContain("true");
    expect(out).not.toContain("null");
  });

  it("redacts Bearer tokens and JWT-looking strings anywhere", () => {
    const out = redactText(`header Authorization: Bearer abcDEF123456789xyz and jwt ${JWT} end`);
    expect(out).not.toContain("abcDEF123456789xyz");
    expect(out).not.toContain(JWT);
    expect(out).toContain("end");
  });

  it("redacts key=value pairs in plain text", () => {
    const out = redactText("failed: client_secret=s3cr3tvalue&grant_type=client_credentials");
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).toContain("grant_type=client_credentials");
  });

  it("leaves benign text alone", () => {
    const text = JSON.stringify({ id: "a1", title: "Disk almost full", severity: "warning" });
    expect(redactText(text)).toBe(text);
  });
});

describe("capText", () => {
  it("passes small text through", () => {
    expect(capText("hello")).toBe("hello");
  });

  it("truncates at 100 KB with a marker", () => {
    const out = capText("a".repeat(MAX_TEXT_BYTES + 5000));
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_TEXT_BYTES + Buffer.byteLength(TRUNCATION_MARKER));
  });

  it("does not split multi-byte characters", () => {
    const out = capText("€".repeat(MAX_TEXT_BYTES));
    expect(out).not.toContain("�");
  });
});

describe("sanitizeToolResult", () => {
  it("redacts whole object values under sensitive JSON keys", () => {
    const text = JSON.stringify({ ok: 1, tokens: { a: "x" }, credentials: { password: "pw-leak-1" }, secret: ["s-leak"] });
    const res = sanitizeToolResult({ content: [{ type: "text", text }] });
    const out = res.content[0].text;
    expect(out).not.toContain("pw-leak-1");
    expect(out).not.toContain("s-leak");
    expect(out).not.toContain('"a":"x"');
    expect(out).toContain('"ok":1');
  });

  it("redacts then caps large text", () => {
    const big = JSON.stringify({ blob: "x".repeat(MAX_TEXT_BYTES * 2), access_token: "tok-leak" });
    const res = sanitizeToolResult({ content: [{ type: "text", text: big }] });
    expect(res.content[0].text).not.toContain("tok-leak");
    expect(res.content[0].text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("drops non-text blocks and redacts structuredContent", () => {
    const res = sanitizeToolResult({
      content: [{ type: "image", data: "AAAA" }, { type: "text", text: "hi" }],
      structuredContent: { client_secret: "leak", n: 1 },
    });
    expect(res.content).toEqual([{ type: "text", text: "hi" }]);
    expect(res.structuredContent).toEqual({ client_secret: REDACTED, n: 1 });
  });

  it("redacts supplied secrets inside structuredContent string values", () => {
    const res = sanitizeToolResult(
      { content: [{ type: "text", text: "ok" }], structuredContent: { note: "id cid-1234 / s3cret-value", nested: [{ v: "s3cret-value" }] } },
      ["s3cret-value", "cid-1234"]
    );
    expect(JSON.stringify(res.structuredContent)).not.toMatch(/s3cret-value|cid-1234/);
  });

  it("converts upstream errors to {error:{code,message}} capped at 500 chars", () => {
    const res = sanitizeToolResult(
      { isError: true, content: [{ type: "text", text: "boom ".repeat(400) }] },
      []
    );
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE);
  });

  it("never echoes supplied credentials in errors or results", () => {
    const secret = "my-oauth-secret-9981";
    const err = sanitizeToolResult(
      { isError: true, content: [{ type: "text", text: `401 for client my-client with ${secret}` }] },
      [secret, "my-client"]
    );
    expect(err.content[0].text).not.toContain(secret);
    expect(err.content[0].text).not.toContain("my-client");
    const ok = sanitizeToolResult({ content: [{ type: "text", text: `echo ${secret}` }] }, [secret]);
    expect(ok.content[0].text).not.toContain(secret);
  });
});

describe("errorResult", () => {
  it("caps message at 500 chars and redacts bearer tokens", () => {
    const res = errorResult("x", `Bearer abcdefghijklmnop ${"y".repeat(1000)}`);
    const msg = JSON.parse(res.content[0].text).error.message as string;
    expect(msg.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE);
    expect(msg).not.toContain("abcdefghijklmnop");
  });
});
