import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, tempFixture } from "../helpers/fixture";

describe("native source actions (integration)", () => {
  let fixture: ReturnType<typeof tempFixture>;
  let client: LspClient;
  let api: LspApi;

  beforeEach(() => {
    fixture = tempFixture();
    writeFileSync(
      join(fixture.dir, "src/messy.ts"),
      [
        'import { findUser, type User } from "./users";',
        'import { AuthService } from "./auth";',
        "",
        "export function probe(id: string) {",
        "  const u = findUser(id);",
        "  return isAdmin(u);",
        "}",
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
    "addMissingImports then organizeImports leaves a complete, minimal header",
    async () => {
      const buffer = api.beginTransaction();
      // isAdmin is used but unimported — auto-import should add it.
      const added = await api.addMissingImports("src/messy.ts");
      expect(added.filesChanged).toEqual(["src/messy.ts"]);
      let text = buffer.peekText(join(fixture.dir, "src/messy.ts")) ?? "";
      expect(text).toMatch(/import \{[^}]*isAdmin[^}]*\} from "\.\/users"/);

      // Organize: now that all names resolve, the unused AuthService import
      // and the unused User type go away and imports are sorted/merged.
      const organized = await api.organizeImports("src/messy.ts");
      expect(organized.filesChanged).toEqual(["src/messy.ts"]);
      text = buffer.peekText(join(fixture.dir, "src/messy.ts")) ?? "";
      expect(text).not.toContain("AuthService");
      expect(text).not.toContain("type User");
      expect(text).toMatch(/import \{ findUser, isAdmin \} from "\.\/users"/);

      buffer.flush();
      api.endTransaction();
    },
    { timeout: 60_000 },
  );

  test(
    "organizeImports with nothing to do reports no changed files",
    async () => {
      api.beginTransaction();
      // users.ts has no imports at all — nothing to organize.
      const result = await api.organizeImports("src/users.ts");
      expect(result.filesChanged).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      api.endTransaction();
    },
    { timeout: 60_000 },
  );
});
