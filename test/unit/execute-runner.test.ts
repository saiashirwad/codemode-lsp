import { describe, expect, test } from "bun:test";
import type { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import {
  type Change,
  capChanges,
  createExecuteRunner,
  DIFF_TRUNCATION_MARKER,
} from "../../src/mcp-server";

/** Minimal LspApi stub — the failing-warmup tests never reach an lsp.* call. */
function stubApi(): LspApi {
  const noopBuffer = {
    isDirty: () => false,
    rollback: () => {},
    flush: () => [],
  };
  return {
    listFiles: async () => [],
    beginTransaction: () => noopBuffer,
    endTransaction: () => {},
    takeHints: () => [],
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

describe("capChanges — diffs count toward the result size cap", () => {
  const change = (file: string, diff: string): Change => ({
    file,
    kind: "modified",
    diff,
  });

  test("changes within budget pass through untouched", () => {
    const changes = [
      change("a.ts", "x".repeat(10)),
      change("b.ts", "y".repeat(10)),
    ];
    expect(capChanges(changes, 50)).toEqual(changes);
  });

  test("a diff overflowing the budget is cut at the budget with the marker", () => {
    const [capped] = capChanges([change("a.ts", "x".repeat(30))], 10);
    expect(capped?.diff).toBe("x".repeat(10) + DIFF_TRUNCATION_MARKER);
  });

  test("after the budget is spent, later changes keep file/kind but lose the diff", () => {
    const changes = [
      change("a.ts", "x".repeat(10)),
      change("b.ts", "y".repeat(10)),
    ];
    const capped = capChanges(changes, 10);
    expect(capped[0]?.diff).toBe("x".repeat(10));
    expect(capped[1]?.file).toBe("b.ts");
    expect(capped[1]?.kind).toBe("modified");
    expect(capped[1]?.diff).toBe(DIFF_TRUNCATION_MARKER);
  });

  test("zero budget replaces every diff with the marker", () => {
    const [capped] = capChanges([change("a.ts", "x")], 0);
    expect(capped?.diff).toBe(DIFF_TRUNCATION_MARKER);
  });
});
