import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, sampleFixtureDir, tempFixture } from "../helpers/fixture";

describe("checkProject (integration)", () => {
  test(
    "whole-project check finds the intentional fixture error without a transaction",
    async () => {
      const client = new LspClient({ rootDir: sampleFixtureDir, lspBin });
      const api = new LspApi({ rootDir: sampleFixtureDir, client });
      try {
        const check = await api.checkProject();
        expect(check.ok).toBe(false);
        expect(check.errorCount).toBe(1);
        expect(check.checkedFileCount).toBeGreaterThanOrEqual(3);
        expect(check.diagnostics[0]?.file).toBe("src/broken.ts");
        expect(check.diagnostics[0]?.severity).toBe("error");
      } finally {
        await client.stop();
      }
    },
    { timeout: 30_000 },
  );

  describe("with tsconfig path aliases", () => {
    let fixture: ReturnType<typeof tempFixture>;
    let client: LspClient;
    let api: LspApi;

    beforeEach(() => {
      fixture = tempFixture();
      writeFileSync(
        join(fixture.dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "es2022",
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            baseUrl: ".",
            paths: { "@app/*": ["src/*"] },
          },
          include: ["src"],
        }),
      );
      client = new LspClient({ rootDir: fixture.dir, lspBin });
      api = new LspApi({ rootDir: fixture.dir, client });
    });

    afterEach(async () => {
      await client.stop();
      fixture.cleanup();
    });

    test(
      "aliases resolve in files CREATED this transaction; real errors still surface",
      async () => {
        // The exact scenario tsserver gets wrong (inferred project → phantom
        // "Cannot find module"): a buffered created file importing via alias.
        api.beginTransaction();
        await api.writeFile(
          "src/new-module.ts",
          'import { findUser } from "@app/users";\nexport const probe = findUser("u1");\n',
        );
        await api.writeFile(
          "src/bad-module.ts",
          'import { nope } from "@app/users";\nexport const n: number = "s";\n',
        );
        const check = await api.checkProject();
        const byFile = (file: string) =>
          check.diagnostics.filter((d) => d.file === file);
        // The correct created file is CLEAN — no alias false positives.
        expect(byFile("src/new-module.ts")).toEqual([]);
        // Genuine mistakes in another created file are still caught.
        const bad = byFile("src/bad-module.ts").map((d) => d.message);
        expect(bad.some((m) => m.includes("nope"))).toBe(true);
        expect(bad.some((m) => m.includes("not assignable"))).toBe(true);
        // Deleting a buffered file removes it from the program.
        await api.deleteFile("src/bad-module.ts");
        const recheck = await api.checkProject();
        expect(
          recheck.diagnostics.filter((d) => d.file === "src/bad-module.ts"),
        ).toEqual([]);
        api.endTransaction();
      },
      { timeout: 60_000 },
    );
  });
});
