import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, tempFixture } from "../helpers/fixture";

/**
 * Field-driven op (PRD § decision log): two sessions hand-rolled the same
 * extraction with string splices — "the LSP gave me intelligence but not the
 * mechanical move — so I hand-rolled line-range surgery, which is exactly the
 * error-prone part it could have owned."
 */
describe("moveSymbol (integration)", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let client: LspClient;
  let api: LspApi;

  beforeEach(() => {
    fixture = tempFixture();
    // An external consumer sharing one import declaration between a moved and
    // a staying symbol — the split-rewire case.
    writeFileSync(
      join(fixture.dir, "src/consumer.ts"),
      [
        'import { AuthService, createAuthMiddleware } from "./auth";',
        "",
        "export const middleware = createAuthMiddleware(new AuthService());",
        "",
      ].join("\n"),
    );
    client = new LspClient({ rootDir: fixture.dir, lspBin });
    api = new LspApi({ rootDir: fixture.dir, client });
  });

  afterEach(async () => {
    await client.stop();
    fixture.cleanup();
  });

  test(
    "moves a function: target header computed, source pruned, importer split-rewired",
    async () => {
      const buffer = api.beginTransaction();
      const result = await api.moveSymbol(
        "src/auth.ts",
        "createAuthMiddleware",
        "src/middleware.ts",
      );
      expect(result.filesChanged).toEqual([
        "src/auth.ts",
        "src/consumer.ts",
        "src/middleware.ts",
      ]);
      expect(result.autoExported).toEqual([]);

      const target =
        buffer.peekText(join(fixture.dir, "src/middleware.ts")) ?? "";
      // Deterministic header from the dependency analysis: the value import it
      // brought along, plus same-file deps imported back from auth (Token is a
      // type alias, so it gets the inline type qualifier).
      expect(target).toContain('import { findUser } from "./users";');
      expect(target).toContain(
        'import { AuthService, type Token } from "./auth";',
      );
      expect(target).toContain("export function createAuthMiddleware");

      const source = buffer.peekText(join(fixture.dir, "src/auth.ts")) ?? "";
      expect(source).not.toContain("createAuthMiddleware");
      // findUser left with the moved body; the still-used type import stays.
      expect(source).not.toContain("findUser");
      expect(source).toContain("User");

      const consumer =
        buffer.peekText(join(fixture.dir, "src/consumer.ts")) ?? "";
      expect(consumer).toContain(
        'import { createAuthMiddleware } from "./middleware";',
      );
      expect(consumer).toMatch(/import \{ AuthService,?\s*\} from "\.\/auth"/);

      // The whole transaction type-checks (minus the intentional fixture error).
      const check = await api.checkProject();
      expect(
        check.diagnostics.filter((d) => d.file !== "src/broken.ts"),
      ).toEqual([]);

      buffer.flush();
      api.endTransaction();
      expect(
        readFileSync(join(fixture.dir, "src/middleware.ts"), "utf8"),
      ).toContain("export function createAuthMiddleware");
    },
    { timeout: 60_000 },
  );

  test(
    "moving a type still used by the source adds a back-import",
    async () => {
      const buffer = api.beginTransaction();
      const result = await api.moveSymbol(
        "src/auth.ts",
        "Token",
        "src/types.ts",
      );
      const source = buffer.peekText(join(fixture.dir, "src/auth.ts")) ?? "";
      // AuthService still uses Token heavily — the source re-imports it.
      expect(source).toContain('import type { Token } from "./types";');
      const target = buffer.peekText(join(fixture.dir, "src/types.ts")) ?? "";
      expect(target).toContain("export type Token = string;");
      expect(result.filesChanged).toContain("src/types.ts");
      const check = await api.checkProject();
      expect(
        check.diagnostics.filter((d) => d.file !== "src/broken.ts"),
      ).toEqual([]);
      api.endTransaction();
    },
    { timeout: 60_000 },
  );

  test(
    "moveSymbols batch: shared dependencies are imported once (field bug: Duplicate identifier)",
    async () => {
      // Two functions sharing both an import dep (findUser) and a type dep
      // (User) — the exact shape that produced "Duplicate identifier
      // 'PaymentAccountRecord'" in the field when moved sequentially.
      writeFileSync(
        join(fixture.dir, "src/pair.ts"),
        [
          'import { findUser, type User } from "./users";',
          "",
          "export function lookupA(id: string): User | undefined {",
          "  return findUser(id);",
          "}",
          "",
          "export function lookupB(id: string): User | undefined {",
          "  return findUser(id);",
          "}",
          "",
        ].join("\n"),
      );
      const buffer = api.beginTransaction();
      const result = await api.moveSymbols(
        "src/pair.ts",
        ["lookupA", "lookupB"],
        "src/moved-pair.ts",
      );
      expect(result.filesChanged).toContain("src/moved-pair.ts");
      const target =
        buffer.peekText(join(fixture.dir, "src/moved-pair.ts")) ?? "";
      // One import declaration from ./users, each name bound exactly once.
      expect((target.match(/from "\.\/users"/g) ?? []).length).toBe(1);
      expect(
        (target.match(/\bfindUser\b/g) ?? []).filter(Boolean).length,
      ).toBeGreaterThan(0);
      const importLines = target
        .split("\n")
        .filter((line) => line.startsWith("import"));
      expect(importLines.join("\n").match(/findUser/g)?.length).toBe(1);
      const check = await api.checkProject();
      expect(
        check.diagnostics.filter((d) => d.file !== "src/broken.ts"),
      ).toEqual([]);
      api.endTransaction();
    },
    { timeout: 60_000 },
  );

  test(
    "moving a symbol into a file that already imports it drops the stale import",
    async () => {
      const buffer = api.beginTransaction();
      // consumer.ts imports createAuthMiddleware from ./auth; move the symbol
      // INTO consumer.ts — the old import would collide with the definition.
      const result = await api.moveSymbol(
        "src/auth.ts",
        "createAuthMiddleware",
        "src/consumer.ts",
      );
      const consumer =
        buffer.peekText(join(fixture.dir, "src/consumer.ts")) ?? "";
      expect(consumer).toContain("export function createAuthMiddleware");
      // The binding is no longer imported anywhere in consumer.ts.
      const importLines = consumer
        .split("\n")
        .filter((line) => line.startsWith("import"));
      expect(importLines.join("\n")).not.toContain("createAuthMiddleware");
      expect(result.filesChanged).toContain("src/consumer.ts");
      const check = await api.checkProject();
      expect(
        check.diagnostics.filter((d) => d.file !== "src/broken.ts"),
      ).toEqual([]);
      api.endTransaction();
    },
    { timeout: 60_000 },
  );

  test(
    "nested symbols are rejected with the top-level rule spelled out",
    async () => {
      api.beginTransaction();
      try {
        await expect(
          api.moveSymbol("src/auth.ts", "AuthService/validate", "src/v.ts"),
        ).rejects.toThrow(/TOP-LEVEL symbols only.*AuthService/s);
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "moving onto the source file is rejected",
    async () => {
      api.beginTransaction();
      try {
        await expect(
          api.moveSymbol("src/auth.ts", "Token", "src/auth.ts"),
        ).rejects.toThrow(/same file/);
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );
});
