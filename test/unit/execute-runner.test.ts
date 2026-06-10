import { describe, expect, test } from "bun:test";
import type { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { createExecuteRunner } from "../../src/mcp-server";

/** Minimal LspApi stub — the failing-warmup tests never reach an lsp.* call. */
function stubApi(): LspApi {
  return {
    listFiles: async () => [],
  } as unknown as LspApi;
}

describe("createExecuteRunner error normalization", () => {
  test("a rejecting warmup resolves to a normalized payload, not a rejection", async () => {
    const { execute } = createExecuteRunner({
      api: stubApi(),
      timeoutMs: 1000,
      warmup: Promise.reject(new Error("LSP server failed to spawn")),
      client: {
        ensureAlive: async () => undefined,
      } as unknown as LspClient,
    });

    const payload = await execute("1 + 1");
    expect(payload.result).toContain("LSP server failed to spawn");
    expect(payload.logs).toBe("");
    expect(payload.changes).toEqual([]);
  });

  test("an ensureAlive that throws resolves to a normalized payload", async () => {
    const { execute } = createExecuteRunner({
      api: stubApi(),
      timeoutMs: 1000,
      warmup: Promise.resolve(),
      client: {
        ensureAlive: async () => {
          throw new Error("LSP crashed and could not be respawned");
        },
      } as unknown as LspClient,
    });

    const payload = await execute("1 + 1");
    expect(payload.result).toContain("LSP crashed and could not be respawned");
    expect(payload.changes).toEqual([]);
  });

  test("after an ensureAlive failure, the mutex stays usable for the next call", async () => {
    let calls = 0;
    // ensureAlive throws on the first call (crash that can't be respawned), then
    // succeeds; the second execute should run the script normally — proving the
    // failure was normalized and the mutex queue did not wedge.
    const { execute } = createExecuteRunner({
      api: stubApi(),
      timeoutMs: 1000,
      warmup: Promise.resolve(),
      client: {
        ensureAlive: async () => {
          calls += 1;
          if (calls === 1) throw new Error("first ensureAlive failed");
        },
      } as unknown as LspClient,
    });

    const first = await execute("1 + 1");
    expect(first.result).toContain("first ensureAlive failed");

    const second = await execute("2 + 3");
    expect(second.result).toBe("5");
    expect(calls).toBe(2);
  });
});
