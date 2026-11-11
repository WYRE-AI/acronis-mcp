import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AcronisCredentials } from "../credentials.js";

const made = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdtemp: async (prefix: string) => {
      const dir = await real.mkdtemp(prefix);
      made.push(dir);
      return dir;
    },
    chmod: async () => {
      throw new Error("EPERM: operation not permitted");
    },
  };
});

const { createStdioSpawner } = await import("../upstream-pool.js");

const creds: AcronisCredentials = { baseUrl: "https://eu8-cloud.acronis.com", clientId: "a", clientSecret: "s" };

describe("stdio spawner", () => {
  it("removes the child's temp HOME when it cannot be made private, instead of leaking it", async () => {
    await expect(createStdioSpawner()(creds, [], { onClose: () => undefined })).rejects.toThrow("EPERM");
    expect(made).toHaveLength(1);
    expect(existsSync(made[0]!)).toBe(false);
  });
});
