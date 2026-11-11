import { describe, expect, it } from "vitest";
import { buildCredentials, resolveEnvCredentials, resolveGatewayCredentials, validateBaseUrl } from "../credentials.js";

describe("validateBaseUrl (SSRF guard)", () => {
  it.each([
    ["https://us5-cloud.acronis.com", "https://us5-cloud.acronis.com"],
    ["https://US5-Cloud.Acronis.com/", "https://us5-cloud.acronis.com"],
    ["https://mc-beta-cloud.acronis.com:443", "https://mc-beta-cloud.acronis.com"],
    ["  https://eu2-cloud.acronis.com  ", "https://eu2-cloud.acronis.com"],
    ["https://eu8-cloud.acronis.com", "https://eu8-cloud.acronis.com"],
    ["https://cloud.acronis.com", "https://cloud.acronis.com"],
    ["https://a.acronis.com", "https://a.acronis.com"],
    // URL parsing lowercases the host, so these are the same host, stored lowercase.
    ["https://EU8-Cloud.ACRONIS.com", "https://eu8-cloud.acronis.com"],
    [`https://${"a".repeat(63)}.acronis.com`, `https://${"a".repeat(63)}.acronis.com`],
  ])("accepts %s", (input, expected) => {
    expect(validateBaseUrl(input)).toEqual({ url: expected });
  });

  it.each([
    "",
    undefined,
    "not a url",
    "http://us5-cloud.acronis.com",
    "ftp://us5-cloud.acronis.com",
    "https://acronis.com",
    "https://evil.com",
    "https://acronis.com.evil.com",
    "https://evilacronis.com",
    "https://us5-cloud.acronis.com.evil.com",
    "https://evil.com/.acronis.com",
    "https://evil.com?x=.acronis.com",
    "https://us5-cloud.acronis.com@evil.com",
    "https://user:pw@us5-cloud.acronis.com",
    "https://us5-cloud.acronis.com:8443",
    "https://us5-cloud.acronis.com/api/2",
    "https://us5-cloud.acronis.com/?a=b",
    "https://us5-cloud.acronis.com/#x",
    "https://127.0.0.1",
    "https://localhost",
    "https://[::1]",
    "https://169.254.169.254",
    "https://us5-cloud.acronis.com.",
    // WYREAI-711: exactly one label under acronis.com (Conduit's rule).
    "https://a.b.acronis.com",
    "https://user-content.files.acronis.com",
    "https://eu8-cloud.eu.acronis.com",
    "https://ACRONIS.COM",
    "https://acronis.com.",
    "https://eu8-cloud.acronis.com.",
    "https://.acronis.com",
    "https://..acronis.com",
    "https://-a.acronis.com",
    "https://a-.acronis.com",
    "https://a_b.acronis.com",
    `https://${"a".repeat(64)}.acronis.com`,
    "https://EU8-CLOUD.ACRONIS.COM.EVIL.COM",
    "https://eu8-cloud.acronis.com%2eevil.com",
    "https://eu8-cloud.acronis.com:443@evil.com",
    "https://evil.com\\.acronis.com",
    "https://eu8-cloud.acronis.com\\@evil.com",
    "https://eu8-cloud.acronis.com:80",
    "https://eu8-cloud.acronis.com:0",
    // IDN / punycode look-alikes of acronis.com resolve to xn-- hosts that are not under it.
    "https://аcronis.com", // Cyrillic a
    "https://eu8-cloud.аcronis.com",
    "https://xn--cronis-2nf.com",
    "https://eu8-cloud.xn--cronis-2nf.com",
    "https://ⓐcronis.com", // normalises to the apex acronis.com
    "https://eu8-cloud.acronis.com.xn--evil-7ia.com",
    "https://evil-acronis.com",
    "https://notacronis.com",
  ])("rejects %j", (input) => {
    const r = validateBaseUrl(input);
    expect(r.url).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});

describe("credential resolution", () => {
  it("env mode reads ACRONIS_* only", () => {
    const r = resolveEnvCredentials({
      ACRONIS_BASE_URL: "https://us5-cloud.acronis.com",
      ACRONIS_CLIENT_ID: "id",
      ACRONIS_CLIENT_SECRET: "secret",
      API_BASE_URL: "https://other.acronis.com",
      OAUTH_CLIENT_ID: "x",
    });
    expect(r.credentials).toEqual({ baseUrl: "https://us5-cloud.acronis.com", clientId: "id", clientSecret: "secret" });
    expect(resolveEnvCredentials({ API_BASE_URL: "https://a.acronis.com", OAUTH_CLIENT_ID: "x", OAUTH_CLIENT_SECRET: "y" }).credentials).toBeUndefined();
  });

  it("gateway mode reads headers and never consults process.env", () => {
    const saved = { ...process.env };
    process.env.ACRONIS_BASE_URL = "https://env.acronis.com";
    process.env.ACRONIS_CLIENT_ID = "env-id";
    process.env.ACRONIS_CLIENT_SECRET = "env-secret";
    try {
      const none = resolveGatewayCredentials(() => undefined);
      expect(none.credentials).toBeUndefined();
      expect(none.error).toContain("X-Acronis-Base-Url");
      const partial = resolveGatewayCredentials((n) => ({ "x-acronis-base-url": "https://h.acronis.com" })[n]);
      expect(partial.credentials).toBeUndefined();
      const seen: string[] = [];
      const ok = resolveGatewayCredentials((n) => {
        seen.push(n);
        return { "x-acronis-base-url": "https://h.acronis.com", "x-acronis-client-id": "hid", "x-acronis-client-secret": "hsec" }[n];
      });
      expect(ok.credentials).toEqual({ baseUrl: "https://h.acronis.com", clientId: "hid", clientSecret: "hsec" });
      expect(seen).toEqual(["x-acronis-base-url", "x-acronis-client-id", "x-acronis-client-secret"]);
    } finally {
      process.env = saved;
    }
  });

  it("rejects a bad base URL without echoing secrets", () => {
    const r = buildCredentials("https://evil.com", "id", "super-secret-value", "hint");
    expect(r.credentials).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("super-secret-value");
  });

  it("rejects control characters and oversized values", () => {
    expect(buildCredentials("https://a.acronis.com", "id", "se\ncret", "h").error).toBeTruthy();
    expect(buildCredentials("https://a.acronis.com", "id", "x".repeat(600), "h").error).toBeTruthy();
  });
});
