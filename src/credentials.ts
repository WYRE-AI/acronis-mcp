/**
 * Acronis credential handling: env mode (ACRONIS_*) and gateway headers.
 * Error messages never echo credential values.
 */

export interface AcronisCredentials {
  /** Normalised https origin of the Acronis datacenter, e.g. https://us5-cloud.acronis.com */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface CredentialResult {
  credentials?: AcronisCredentials;
  error?: string;
}

/** Exact gateway header names (match conduit vendor-config headerMapping). */
export const GATEWAY_HEADERS = [
  "X-Acronis-Base-Url",
  "X-Acronis-Client-Id",
  "X-Acronis-Client-Secret",
] as const;

const MAX_CRED_LENGTH = 512;

/**
 * EXACTLY one DNS label under acronis.com (us5-cloud, eu8-cloud, ...), the same
 * rule as Conduit's `acronisOrigin` (conduit src/credentials/vendor-config.ts).
 * A deeper name (user-content.files.acronis.com) could be user content or a
 * takeover-prone host, and it would receive the client_secret. The label must
 * be a valid DNS label (no leading or trailing hyphen, at most 63 characters).
 * Tested against URL.hostname, which is already lowercased, punycoded (IDN
 * look-alikes become xn-- names that are not under acronis.com) and keeps a
 * trailing dot, so `acronis.com.` and `a.acronis.com.` fail.
 */
const ALLOWED_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.acronis\.com$/;

/**
 * SSRF guard (WYREAI-454, WYREAI-711): https only, hostname exactly one label
 * under acronis.com, no userinfo, default port only, no path/query/fragment.
 * Returns the normalised origin.
 */
export function validateBaseUrl(raw: string | undefined): { url?: string; error?: string } {
  const value = (raw ?? "").trim();
  if (!value) return { error: "Acronis base URL is missing" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "Acronis base URL is not a valid URL" };
  }
  if (parsed.protocol !== "https:") return { error: "Acronis base URL must use https" };
  if (parsed.username || parsed.password) {
    return { error: "Acronis base URL must not contain credentials" };
  }
  if (parsed.port && parsed.port !== "443") {
    return { error: "Acronis base URL must use the default https port" };
  }
  if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    return { error: "The Acronis Data center URL must be just the address, such as https://us5-cloud.acronis.com, with nothing after .com. Reconnect Acronis in Conduit with that address." };
  }
  if (!ALLOWED_HOST.test(parsed.hostname)) {
    return { error: "Acronis base URL hostname must be exactly one label under acronis.com, such as us5-cloud.acronis.com" };
  }
  return { url: `https://${parsed.hostname}` };
}

export function buildCredentials(
  baseUrl: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  missingHint: string
): CredentialResult {
  const id = (clientId ?? "").trim();
  const secret = clientSecret ?? "";
  if (!baseUrl?.trim() || !id || !secret) {
    return { error: `Missing credential: ${missingHint}` };
  }
  if (id.length > MAX_CRED_LENGTH || secret.length > MAX_CRED_LENGTH) {
    return { error: "Client id or secret is too long" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id) || /[\u0000-\u001f\u007f]/.test(secret)) {
    return { error: "Client id or secret contains control characters" };
  }
  const { url, error } = validateBaseUrl(baseUrl);
  if (error || !url) return { error };
  return { credentials: { baseUrl: url, clientId: id, clientSecret: secret } };
}

/** Per-request gateway credentials from a (lowercased) header accessor. Never reads env. */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): CredentialResult {
  return buildCredentials(
    getHeader("x-acronis-base-url"),
    getHeader("x-acronis-client-id"),
    getHeader("x-acronis-client-secret"),
    GATEWAY_HEADERS.join(", ")
  );
}

/** Env-mode credentials (stdio / local). */
export function resolveEnvCredentials(
  env: Record<string, string | undefined> = process.env
): CredentialResult {
  return buildCredentials(
    env.ACRONIS_BASE_URL,
    env.ACRONIS_CLIENT_ID,
    env.ACRONIS_CLIENT_SECRET,
    "ACRONIS_BASE_URL, ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET"
  );
}
