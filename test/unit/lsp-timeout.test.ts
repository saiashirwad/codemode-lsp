import { describe, expect, test } from "bun:test";
import { withTimeout } from "../../src/lsp-client";

describe("withTimeout", () => {
  test("resolves with the value when the work finishes first", async () => {
    const result = await withTimeout(async () => 42, 1000, "fast");
    expect(result).toBe(42);
  });

  test("rejects with a timeout error when the work hangs", async () => {
    const hang = withTimeout<never>(
      () => new Promise<never>(() => {}),
      20,
      "slow",
    );
    await expect(hang).rejects.toThrow(/timed out after 20ms/);
  });

  test("includes the request label in the timeout message", async () => {
    const hang = withTimeout<never>(
      () => new Promise<never>(() => {}),
      10,
      "textDocument/documentSymbol",
    );
    await expect(hang).rejects.toThrow(/textDocument\/documentSymbol/);
  });
});
