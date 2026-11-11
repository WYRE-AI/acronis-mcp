/**
 * Tenant isolation, end to end (WYREAI-711): real HTTP requests through the real
 * server and handler, real upstream child processes, a local fake Acronis.
 *
 * - Two requests with DIFFERENT credentials get two SEPARATE child processes;
 *   the same credentials reuse one.
 * - Request A's credentials never appear in request B's child (env, argv), in
 *   the requests the fake Acronis saw for B, or in B's HTTP response.
 *
 * The children really run: the fake Acronis answers each child's token request
 * with a token that names the client it was issued to, so an API call carrying
 * the wrong tenant's token is visible. A preload fixture (record-child.cjs)
 * records what each child process actually received.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "../index.js";
import { createStdioSpawner, setDefaultSpawner } from "../upstream-pool.js";

const S2S_SECRET = "isolation-test-s2s-secret";
const BASE_URL = "https://eu8-cloud.acronis.com"; // valid for the sidecar; the child's API_BASE_URL is the fake
const RECORDER = new URL("./fixtures/record-child.cjs", import.meta.url).pathname;

const A = { id: "client-id-aaaa", secret: "secret-AAAA-do-not-leak" };
const B = { id: "client-id-bbbb", secret: "secret-BBBB-do-not-leak" };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const reversed = (s: string) => [...s].reverse().join("");

interface ChildRecord {
  pid: number;
  argv: string[];
  env: Record<string, string>;
}

let fake: Server;
let sidecar: Server;
let sidecarUrl: string;
let recordDir: string;
/** Token requests the fake Acronis received: which client asked, with which secret. */
let tokenRequests: Array<{ clientId: string; clientSecret: string }>;
/** API calls the fake Acronis received: which tenant's token they carried. */
let apiCalls: Array<{ tokenClientId: string; raw: string }>;

beforeAll(async () => {
  recordDir = mkdtempSync(join(tmpdir(), "acronis-iso-rec-"));

  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.endsWith("/idp/token")) {
        const form = new URLSearchParams(body);
        const clientId = form.get("client_id") ?? "";
        tokenRequests.push({ clientId, clientSecret: form.get("client_secret") ?? "" });
        const jwt = `${b64({ alg: "none" })}.${b64({ cid: clientId, scope: [{ tid: "00000000-0000-0000-0000-000000000000" }] })}.sig`;
        res.end(JSON.stringify({ access_token: jwt, expires_in: 3600, token_type: "bearer" }));
        return;
      }
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
      const claims = bearer ? JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") : {};
      if (!req.url?.includes("resolve_ids")) apiCalls.push({ tokenClientId: String(claims.cid), raw: `${req.url} ${body}` });
      // Reversed, because the sidecar redacts the caller's own client id from results.
      res.end(JSON.stringify({ items: [{ servedFor: reversed(String(claims.cid)) }] }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakeOrigin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  // The real server and handler, in gateway mode, spawning REAL children. Only the
  // child's API_BASE_URL is redirected to the fake (the guard allows exactly that origin).
  process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
  process.env.AUTH_MODE = "gateway";
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  setDefaultSpawner(
    createStdioSpawner({
      API_BASE_URL: fakeOrigin,
      NODE_OPTIONS: `--require ${RECORDER}`,
      ACRONIS_TEST_RECORD_DIR: recordDir,
    })
  );
});

afterAll(async () => {
  await new Promise<void>((r) => fake.close(() => r()));
  setDefaultSpawner(undefined);
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.AUTH_MODE;
  rmSync(recordDir, { recursive: true, force: true });
});

// A fresh server (and so a fresh, empty pool) per test.
beforeEach(async () => {
  // A 1 Gi container, as the runtime would report it: room for the two tenants' children (0.5 Gi allows one).
  // Per test, because the vitest config restores mocks before each one.
  vi.spyOn(process, "constrainedMemory").mockReturnValue(1024 * 1024 * 1024);
  tokenRequests = [];
  apiCalls = [];
  for (const f of readdirSync(recordDir)) rmSync(join(recordDir, f));
  sidecar = await startHttpTransport();
  sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  await new Promise<void>((r) => sidecar.close(() => r())); // closing the server closes every child
});

/** One signed gateway request: tools/call acronis_fetch_all_alerts as the given tenant. */
async function callAs(tenant: { id: string; secret: string }): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", S2S_SECRET).update(`t=${t}`).digest("hex");
  const res = await fetch(sidecarUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-gateway-s2s": `t=${t},v1=${sig}`,
      "x-acronis-base-url": BASE_URL,
      "x-acronis-client-id": tenant.id,
      "x-acronis-client-secret": tenant.secret,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "acronis_fetch_all_alerts", arguments: {} },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

const childRecords = (): ChildRecord[] =>
  readdirSync(recordDir).map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")) as ChildRecord);
const childOf = (tenant: { id: string }) => childRecords().filter((c) => c.env.OAUTH_CLIENT_ID === tenant.id);

describe("HTTP tenant isolation (real children)", () => {
  it("gives different credentials separate child processes, and reuses a child for the same credentials", async () => {
    const respA1 = await callAs(A);
    const respB = await callAs(B);
    const respA2 = await callAs(A);

    // Two children in total: one per credential, and A's second request reused A's.
    const records = childRecords();
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.pid)).size).toBe(2);
    expect(childOf(A)).toHaveLength(1);
    expect(childOf(B)).toHaveLength(1);
    expect(childOf(A)[0].pid).not.toBe(childOf(B)[0].pid);

    // Each child fetched its own token once...
    expect(tokenRequests.map((t) => t.clientId).sort()).toEqual([A.id, B.id].sort());
    // ...and every API call carried the token of the tenant that made the request.
    expect(apiCalls.map((c) => c.tokenClientId)).toEqual([A.id, B.id, A.id]);
    expect(respA1).toContain(reversed(A.id));
    expect(respB).toContain(reversed(B.id));
    expect(respA2).toContain(reversed(A.id));
  }, 60_000);

  it("never exposes request A's credentials to request B's child, traffic or response", async () => {
    const respA = await callAs(A);
    const respB = await callAs(B);

    const [childA] = childOf(A);
    const [childB] = childOf(B);
    // Sanity: the recorder sees the real child, and A's child does hold A's credentials.
    expect(childA.env.OAUTH_CLIENT_SECRET).toBe(A.secret);
    expect(childB.env.OAUTH_CLIENT_SECRET).toBe(B.secret);

    // B's child: no trace of A in its env or argv.
    const bProcess = JSON.stringify({ argv: childB.argv, env: childB.env });
    expect(bProcess).not.toContain(A.secret);
    expect(bProcess).not.toContain(A.id);
    // ...and no sidecar-level secrets either (the env is built from scratch).
    expect(bProcess).not.toContain(S2S_SECRET);
    // A's child likewise has nothing of B.
    expect(JSON.stringify({ argv: childA.argv, env: childA.env })).not.toContain(B.secret);

    // What the fake Acronis saw for B: B's secret only, never A's.
    const forB = tokenRequests.filter((t) => t.clientId === B.id);
    expect(forB).toEqual([{ clientId: B.id, clientSecret: B.secret }]);
    expect(JSON.stringify(apiCalls.filter((c) => c.tokenClientId === B.id))).not.toContain(A.secret);

    // B's HTTP response: nothing of A.
    expect(respB).not.toContain(A.secret);
    expect(respB).not.toContain(A.id);
    expect(respA).not.toContain(B.secret);
  }, 60_000);
});
