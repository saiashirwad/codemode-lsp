import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { lspBin, sampleFixtureDir } from "../helpers/fixture";

/**
 * Smoke test for the whole toolchain: spawns the locally installed
 * typescript-language-server, completes the init handshake over
 * vscode-jsonrpc, and gets document symbols for a fixture file.
 * If this passes on a fresh clone, the dev environment works.
 */
describe("typescript-language-server smoke", () => {
  test(
    "initialize handshake and documentSymbol",
    async () => {
      const proc = spawn(lspBin, ["--stdio"], {
        cwd: sampleFixtureDir,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const connection = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      );
      connection.listen();

      try {
        const initResult: any = await connection.sendRequest("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(sampleFixtureDir).href,
          capabilities: {
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
          },
          workspaceFolders: null,
        });
        expect(initResult.capabilities).toBeDefined();
        await connection.sendNotification("initialized", {});

        const authPath = join(sampleFixtureDir, "src", "auth.ts");
        const authUri = pathToFileURL(authPath).href;
        await connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: authUri,
            languageId: "typescript",
            version: 1,
            text: readFileSync(authPath, "utf8"),
          },
        });

        const symbols: any[] = await connection.sendRequest(
          "textDocument/documentSymbol",
          { textDocument: { uri: authUri } },
        );
        const names = symbols.map((s) => s.name);
        expect(names).toContain("AuthService");
        expect(names).toContain("createAuthMiddleware");

        const authService = symbols.find((s) => s.name === "AuthService");
        const childNames = (authService?.children ?? []).map(
          (c: any) => c.name,
        );
        expect(childNames).toContain("validate");

        await connection.sendRequest("shutdown");
        await connection.sendNotification("exit");
      } finally {
        connection.dispose();
        proc.kill();
      }
    },
    { timeout: 30_000 },
  );
});
