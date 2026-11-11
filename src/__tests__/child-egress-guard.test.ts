/**
 * child-egress-guard.cjs, run the way the pool runs it: preloaded into a node
 * process whose API_BASE_URL is the only origin it may reach (WYREAI-711).
 *
 * - the URL that is checked is the URL that is requested (no toString trick),
 * - other origins and redirects are refused,
 * - a response body over the cap is aborted while it streams, whether or not
 *   the server declares a Content-Length, and a normal response is untouched.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GUARD = new URL("../../child-egress-guard.cjs", import.meta.url).pathname;
const CAP = 512 * 1024;

interface Hits {
  urls: string[];
}

async function listen(handler: (url: string, res: import("node:http").ServerResponse, hits: Hits) => void) {
  const hits: Hits = { urls: [] };
  const server: Server = createServer((req, res) => {
    hits.urls.push(req.url ?? "");
    handler(req.url ?? "", res, hits);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { hits, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let api: Awaited<ReturnType<typeof listen>>;
let elsewhere: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  elsewhere = await listen((_url, res) => res.end("evil"));
  api = await listen((url, res) => {
    if (url === "/redirect") {
      res.statusCode = 307;
      res.setHeader("location", `${elsewhere.origin}/redirected`);
      res.end();
    } else if (url === "/declared-big") {
      res.setHeader("content-length", String(CAP * 4));
      res.end(Buffer.alloc(CAP * 4, "x"));
    } else if (url === "/chunked-big") {
      res.write(Buffer.alloc(CAP / 2, "x")); // no Content-Length: chunked
      res.write(Buffer.alloc(CAP / 2, "x"));
      res.write(Buffer.alloc(CAP, "x"));
      res.end();
    } else if (url === "/just-under") {
      res.end(Buffer.alloc(CAP - 1, "x"));
    } else {
      res.statusCode = 201;
      res.setHeader("x-test", "kept");
      res.end("hello");
    }
  });
});

afterAll(async () => {
  await Promise.all([api.close(), elsewhere.close()]);
});

/**
 * Runs `script` in a node process with the guard preloaded; returns its stdout.
 * Async on purpose: the servers above live in this process and must keep answering.
 */
function inChild(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--require", GUARD, "-e", script],
      { env: { PATH: process.env.PATH ?? "", API_BASE_URL: api.origin, EVIL: elsewhere.origin }, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        expect(stderr).toBe("");
        resolve(stdout.trim());
      }
    );
  });
}

const show = `.then(async (r) => { try { console.log("OK " + r.status + " " + (await r.text()).length); } catch (e) { console.log("ERR " + e.message); } }, (e) => console.log("ERR " + e.message))`;

describe("child egress guard", () => {
  it("requests exactly the URL it checked: an object whose toString() names another URL does not bypass it", async () => {
    const out = await inChild(
      `fetch({ url: process.env.API_BASE_URL + "/small", toString: () => process.env.EVIL + "/evil" })${show}`
    );
    expect(out).toBe("OK 201 5"); // the checked URL was fetched...
    expect(api.hits.urls).toContain("/small");
    expect(elsewhere.hits.urls).toEqual([]); // ...and the toString() one was not
  });

  it("does not let a Request subclass report one URL and fetch another", async () => {
    const out = await inChild(
      `class Sneaky extends Request { get url() { return process.env.API_BASE_URL + "/small"; } }
       fetch(new Sneaky(process.env.EVIL + "/evil"))${show}`
    );
    expect(out).toMatch(/^ERR Blocked request/); // the Request's real URL is the other origin
    expect(elsewhere.hits.urls).toEqual([]);
  });

  it("allows a string, a URL and a Request for its own origin", async () => {
    const out = await inChild(`
      (async () => {
        const base = process.env.API_BASE_URL;
        for (const input of [base + "/small", new URL(base + "/small"), new Request(base + "/small")]) {
          const r = await fetch(input);
          console.log(r.status, r.headers.get("x-test"), await r.text());
        }
      })();`);
    expect(out.split("\n")).toEqual(["201 kept hello", "201 kept hello", "201 kept hello"]);
  });

  it("blocks any other origin, however the URL is given", async () => {
    const out = await inChild(`
      (async () => {
        const evil = process.env.EVIL + "/evil";
        for (const input of [evil, new URL(evil), new Request(evil), { url: evil }]) {
          await fetch(input).then(() => console.log("REACHED"), (e) => console.log("blocked: " + e.message.slice(0, 7)));
        }
      })();`);
    expect(out.split("\n")).toEqual(Array(4).fill("blocked: Blocked"));
    expect(elsewhere.hits.urls).toEqual([]);
  });

  it("refuses to follow a redirect", async () => {
    const out = await inChild(`fetch(process.env.API_BASE_URL + "/redirect")${show}`);
    expect(out).toMatch(/^ERR /);
    expect(elsewhere.hits.urls).toEqual([]);
  });

  it("passes a normal response through unchanged: status, headers, body", async () => {
    const out = await inChild(`fetch(process.env.API_BASE_URL + "/small").then(async (r) => console.log(r.status, r.statusText, r.headers.get("x-test"), await r.text()))`);
    expect(out).toBe("201 Created kept hello");
  });

  it("reads a body just under the cap", async () => {
    expect(await inChild(`fetch(process.env.API_BASE_URL + "/just-under")${show}`)).toBe(`OK 200 ${CAP - 1}`);
  });

  it("rejects a response whose declared Content-Length is over the cap, without reading it", async () => {
    const out = await inChild(`fetch(process.env.API_BASE_URL + "/declared-big")${show}`);
    expect(out).toMatch(/^ERR Acronis response is larger than 524288 bytes/);
  });

  it("aborts a chunked response (no Content-Length) while reading it once it passes the cap", async () => {
    const out = await inChild(`fetch(process.env.API_BASE_URL + "/chunked-big")${show}`);
    expect(out).toMatch(/^ERR Acronis response is larger than 524288 bytes/);
  });
});
