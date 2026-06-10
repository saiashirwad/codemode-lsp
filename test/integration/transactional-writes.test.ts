import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { createExecuteRunner, type ExecuteResult } from "../../src/mcp-server";
import { lspBin, tempFixture } from "../helpers/fixture";

/** Hash every file under a dir so we can assert disk is byte-identical. */
function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        hash.update(full.slice(dir.length));
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

describe("transactional writes via the execute runner (integration)", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let client: LspClient;
  let api: LspApi;

  function runner(readonly = false) {
    return createExecuteRunner({
      api,
      client,
      timeoutMs: 30_000,
      warmup: client.start().then(() => client.ready()),
      rootDir: fixture.dir,
      readonly,
    });
  }

  beforeEach(() => {
    fixture = tempFixture();
    client = new LspClient({ rootDir: fixture.dir, lspBin });
    api = new LspApi({ rootDir: fixture.dir, client });
  });

  afterEach(async () => {
    await client.stop();
    fixture.cleanup();
  });

  test(
    "a failing write script leaves disk byte-identical and notes the rollback",
    async () => {
      const before = hashTree(fixture.dir);
      const { execute } = runner();
      const result: ExecuteResult = await execute(
        `await lsp.replaceSymbolBody("src/users.ts", "isAdmin",
            "export const isAdmin = (user) => true;");
         await lsp.writeFile("src/brand-new.ts", "export const brand = 1;\\n");
         // Now fail on a bad symbol path — everything above must roll back.
         await lsp.getSymbolBody("src/auth.ts", "AuthService/doesNotExist");`,
      );
      // Disk untouched: same hash, no new file.
      expect(hashTree(fixture.dir)).toBe(before);
      expect(result.changes).toEqual([]);
      // The trace ends with the exact rollback sentence.
      expect(result.result).toContain(
        "All buffered changes were rolled back; the codebase is unchanged.",
      );
      expect(result.result).toContain("completed:");
      expect(result.result).toContain("failed at:");
    },
    { timeout: 30_000 },
  );

  test(
    "a successful multi-write script updates disk and returns reviewable diffs",
    async () => {
      const { execute } = runner();
      const result = await execute(
        `await lsp.replaceSymbolBody("src/users.ts", "isAdmin",
            "export const isAdmin = (user) => user.role === \\"admin\\" || user.role === \\"member\\";");
         await lsp.writeFile("src/created.ts", "export const created = 42;\\n");
         "done";`,
      );
      expect(JSON.parse(result.result)).toBe("done");

      const byFile = new Map(result.changes.map((c) => [c.file, c]));
      const modified = byFile.get("src/users.ts");
      const created = byFile.get("src/created.ts");
      expect(modified?.kind).toBe("modified");
      expect(modified?.diff).toContain("--- a/src/users.ts");
      expect(modified?.diff).toContain("+++ b/src/users.ts");
      expect(modified?.diff).toContain("member");
      expect(created?.kind).toBe("created");
      expect(created?.diff).toContain("+export const created = 42;");

      // Disk reflects the flush.
      expect(readFileSync(join(fixture.dir, "src/users.ts"), "utf8")).toContain(
        '|| user.role === "member"',
      );
      expect(
        readFileSync(join(fixture.dir, "src/created.ts"), "utf8"),
      ).toContain("created = 42");
    },
    { timeout: 30_000 },
  );

  test(
    "renameSymbol fan-out flushes consistently across files",
    async () => {
      const { execute } = runner();
      const result = await execute(
        `const r = await lsp.renameSymbol("src/users.ts", "findUser", "lookupUser");
         ({ filesChanged: r.filesChanged });`,
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.filesChanged).toContain("src/users.ts");
      expect(parsed.filesChanged).toContain("src/auth.ts");
      // Both files flushed and consistent on disk.
      const changedFiles = result.changes.map((c) => c.file).sort();
      expect(changedFiles).toEqual(["src/auth.ts", "src/users.ts"]);
      expect(readFileSync(join(fixture.dir, "src/users.ts"), "utf8")).toContain(
        "export function lookupUser",
      );
      expect(readFileSync(join(fixture.dir, "src/auth.ts"), "utf8")).toContain(
        "lookupUser(user.id)",
      );
    },
    { timeout: 30_000 },
  );

  test(
    "read-after-write within one script sees buffered content",
    async () => {
      const { execute } = runner();
      const result = await execute(
        `await lsp.replaceSymbolBody("src/auth.ts", "AuthService/logout",
            "logout(token) { this.sessions.clear(); }");
         const body = await lsp.getSymbolBody("src/auth.ts", "AuthService/logout");
         ({ body });`,
      );
      expect(JSON.parse(result.result).body).toContain("this.sessions.clear()");
    },
    { timeout: 30_000 },
  );

  test(
    "deleteFile then readFile throws the documented error",
    async () => {
      const before = hashTree(fixture.dir);
      const { execute } = runner();
      const result = await execute(
        `await lsp.deleteFile("src/users.ts");
         await lsp.readFile("src/users.ts");`,
      );
      // The script failed → rollback → disk untouched.
      expect(hashTree(fixture.dir)).toBe(before);
      expect(result.result).toContain("deleted earlier in this script");
      expect(result.result).toContain(
        "All buffered changes were rolled back; the codebase is unchanged.",
      );
    },
    { timeout: 30_000 },
  );

  test(
    "a successful deleteFile removes the file from disk",
    async () => {
      const { execute } = runner();
      const result = await execute(
        `await lsp.deleteFile("src/broken.ts");
         "deleted";`,
      );
      expect(JSON.parse(result.result)).toBe("deleted");
      expect(() => statSync(join(fixture.dir, "src/broken.ts"))).toThrow();
      const deleted = result.changes.find((c) => c.file === "src/broken.ts");
      expect(deleted?.kind).toBe("deleted");
    },
    { timeout: 30_000 },
  );

  test(
    "CODEMODE_READONLY removes write ops from the sandbox; reads still work",
    async () => {
      const { execute } = runner(true);
      const result = await execute(
        `({
           writeFile: typeof lsp.writeFile,
           renameSymbol: typeof lsp.renameSymbol,
           deleteFile: typeof lsp.deleteFile,
           deleteSymbol: typeof lsp.deleteSymbol,
           replaceSymbolBody: typeof lsp.replaceSymbolBody,
           insertBeforeSymbol: typeof lsp.insertBeforeSymbol,
           insertAfterSymbol: typeof lsp.insertAfterSymbol,
           readFile: typeof lsp.readFile,
           getSymbols: typeof lsp.getSymbols,
           getDiagnostics: typeof lsp.getDiagnostics,
           fileCount: (await lsp.listFiles("src/**/*.ts")).length,
         })`,
      );
      const parsed = JSON.parse(result.result);
      expect(parsed.writeFile).toBe("undefined");
      expect(parsed.renameSymbol).toBe("undefined");
      expect(parsed.deleteFile).toBe("undefined");
      expect(parsed.deleteSymbol).toBe("undefined");
      expect(parsed.replaceSymbolBody).toBe("undefined");
      expect(parsed.insertBeforeSymbol).toBe("undefined");
      expect(parsed.insertAfterSymbol).toBe("undefined");
      // Read ops + getDiagnostics remain.
      expect(parsed.readFile).toBe("function");
      expect(parsed.getSymbols).toBe("function");
      expect(parsed.getDiagnostics).toBe("function");
      expect(parsed.fileCount).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );
});
