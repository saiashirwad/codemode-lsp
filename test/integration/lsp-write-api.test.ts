import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, tempFixture } from "../helpers/fixture";

describe("LspApi write operations (integration)", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let client: LspClient;
  let api: LspApi;

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
    "replaceSymbolBody updates the buffer; reads within the script see it",
    async () => {
      api.beginTransaction();
      try {
        const newBody =
          "logout(token: Token): void {\n    this.sessions.clear();\n  }";
        const result = await api.replaceSymbolBody(
          "src/auth.ts",
          "AuthService/logout",
          newBody,
        );
        expect(result.filesChanged).toEqual(["src/auth.ts"]);
        // Read-after-write within the same transaction reflects the buffer.
        const text = await api.readFile("src/auth.ts");
        expect(text).toContain("this.sessions.clear()");
        const body = await api.getSymbolBody(
          "src/auth.ts",
          "AuthService/logout",
        );
        expect(body).toContain("this.sessions.clear()");
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "insertBeforeSymbol and insertAfterSymbol place code around a symbol",
    async () => {
      api.beginTransaction();
      try {
        await api.insertBeforeSymbol(
          "src/users.ts",
          "isAdmin",
          "// before isAdmin",
        );
        await api.insertAfterSymbol(
          "src/users.ts",
          "isAdmin",
          "// after isAdmin",
        );
        const text = await api.readFile("src/users.ts");
        const beforeIdx = text.indexOf("// before isAdmin");
        const isAdminIdx = text.indexOf("export const isAdmin");
        const afterIdx = text.indexOf("// after isAdmin");
        expect(beforeIdx).toBeGreaterThanOrEqual(0);
        expect(beforeIdx).toBeLessThan(isAdminIdx);
        expect(afterIdx).toBeGreaterThan(isAdminIdx);
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "deleteSymbol removes the symbol and its leading JSDoc",
    async () => {
      api.beginTransaction();
      try {
        await api.deleteSymbol("src/auth.ts", "AuthService/validate");
        const text = await api.readFile("src/auth.ts");
        expect(text).not.toContain("validate(token: Token): User | undefined");
        // The JSDoc comment immediately above validate is removed too.
        expect(text).not.toContain("Validate a token and return");
        // Sibling methods survive.
        expect(text).toContain("validateToken(token: Token): boolean");
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "writeFile creates a new file (buffered); deleteFile then readFile throws",
    async () => {
      api.beginTransaction();
      try {
        await api.writeFile("src/extra.ts", "export const extra = 1;\n");
        expect(await api.readFile("src/extra.ts")).toContain("extra = 1");

        await api.deleteFile("src/users.ts");
        await expect(api.readFile("src/users.ts")).rejects.toThrow(
          /deleted earlier in this script/,
        );
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "renameSymbol fans out across files once references are warm",
    async () => {
      api.beginTransaction();
      try {
        // Warm the cross-file reference index (what a real script does first).
        await api.findReferences("src/users.ts", "findUser");
        const result = await api.renameSymbol(
          "src/users.ts",
          "findUser",
          "lookupUser",
        );
        expect(result.filesChanged).toContain("src/users.ts");
        expect(result.filesChanged).toContain("src/auth.ts");
        // Both buffers reflect the new name.
        expect(await api.readFile("src/users.ts")).toContain(
          "export function lookupUser",
        );
        expect(await api.readFile("src/auth.ts")).toContain("lookupUser(");
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "a write that introduces a type error surfaces it in diagnostics",
    async () => {
      api.beginTransaction();
      try {
        // Replace a function body with a return-type mismatch.
        const result = await api.replaceSymbolBody(
          "src/users.ts",
          "isAdmin",
          "export const isAdmin = (user: User): boolean => 123;",
        );
        let diagnostics = result.diagnostics;
        // Diagnostics may lag (PRD Risk #1); fall back to an explicit bounded poll.
        if (!diagnostics.some((d) => d.severity === "error")) {
          diagnostics = await api.getDiagnostics("src/users.ts");
        }
        expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
      } finally {
        api.endTransaction();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "write ops require an active transaction",
    async () => {
      await expect(api.writeFile("src/x.ts", "nope")).rejects.toThrow(
        /requires an active transaction/,
      );
    },
    { timeout: 30_000 },
  );

  test("buffer never touches disk until flush", async () => {
    const usersPath = join(fixture.dir, "src/users.ts");
    const before = readFileSync(usersPath, "utf8");
    const buffer = api.beginTransaction();
    try {
      await api.replaceSymbolBody(
        "src/users.ts",
        "isAdmin",
        "export const isAdmin = (user: User): boolean => false;",
      );
      // Not flushed yet: disk is unchanged.
      expect(readFileSync(usersPath, "utf8")).toBe(before);
      const changes = buffer.flush();
      expect(changes.some((c) => c.kind === "modified")).toBe(true);
      expect(readFileSync(usersPath, "utf8")).toContain("=> false");
      expect(existsSync(usersPath)).toBe(true);
    } finally {
      api.endTransaction();
    }
  });
});
