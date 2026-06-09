import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { LspClient } from "../../src/lsp-client";
import { lspBin, sampleFixtureDir } from "../helpers/fixture";

/**
 * Phase 1 exit criterion: against the real typescript-language-server, the
 * client spawns, completes the handshake + warmup, and returns a symbol tree
 * for a fixture file. Also covers the crash-recovery primitive: a dead server
 * is respawned transparently on the next operation.
 */
describe("LspClient (integration, real typescript-language-server)", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient({ rootDir: sampleFixtureDir, lspBin });
  });

  afterEach(async () => {
    await client.stop();
  });

  test(
    "spawns, warms up, and returns a hierarchical symbol tree",
    async () => {
      await client.start();
      await client.ready();

      const symbols = (await client.documentSymbol(
        "src/auth.ts",
      )) as DocumentSymbol[];
      const names = symbols.map((s) => s.name);
      expect(names).toContain("AuthService");
      expect(names).toContain("createAuthMiddleware");

      const authService = symbols.find((s) => s.name === "AuthService");
      expect(authService?.children).toBeDefined();
      const childNames = (authService?.children ?? []).map((c) => c.name);
      expect(childNames).toContain("validate");

      // Hierarchical DocumentSymbol shape (not flat SymbolInformation):
      // DocumentSymbol carries selectionRange, SymbolInformation carries location.
      expect(authService).toHaveProperty("selectionRange");
      expect(authService).not.toHaveProperty("location");
    },
    { timeout: 30_000 },
  );

  test(
    "recovers transparently after the server process dies",
    async () => {
      await client.start();
      await client.ready();
      await client.documentSymbol("src/auth.ts");

      await client.killServer();
      expect(client.isAlive()).toBe(false);

      // Next operation must respawn + re-handshake without the caller knowing.
      const symbols = (await client.documentSymbol(
        "src/users.ts",
      )) as DocumentSymbol[];
      expect(symbols.map((s) => s.name)).toContain("findUser");
      expect(client.isAlive()).toBe(true);
    },
    { timeout: 30_000 },
  );

  test(
    "gates on warmup internally — documentSymbol works without an explicit ready()",
    async () => {
      // No await client.ready() here: documentSymbol must wait for warmup itself.
      await client.start();
      const symbols = (await client.documentSymbol(
        "src/users.ts",
      )) as DocumentSymbol[];
      expect(symbols.map((s) => s.name)).toContain("Outer");
    },
    { timeout: 30_000 },
  );

  test(
    "resolves absolute paths within the root",
    async () => {
      await client.start();
      await client.ready();
      const abs = `${sampleFixtureDir}/src/users.ts`;
      const symbols = (await client.documentSymbol(abs)) as DocumentSymbol[];
      expect(symbols.map((s) => s.name)).toContain("findUser");
    },
    { timeout: 30_000 },
  );
});

describe("LspClient handshake failure", () => {
  test(
    "a server that never answers initialize is torn down, not left healthy",
    async () => {
      // Fake "server": holds its stdout pipe open but never writes a response,
      // so the initialize request can only fail via the per-request timeout
      // (the connection stays open the whole time — a true wedged server).
      const dir = mkdtempSync(join(tmpdir(), "codemode-fakelsp-"));
      const fake = join(dir, "fake-lsp.sh");
      writeFileSync(fake, "#!/bin/sh\nexec sleep 600\n");
      chmodSync(fake, 0o755);

      const client = new LspClient({
        rootDir: sampleFixtureDir,
        lspBin: fake,
        requestTimeoutMs: 500,
      });
      try {
        await expect(client.start()).rejects.toThrow(/timed out/);
        // The wedged process must be reported dead so the next op retries.
        expect(client.isAlive()).toBe(false);
      } finally {
        await client.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 30_000 },
  );
});
