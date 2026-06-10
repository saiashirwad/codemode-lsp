import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, tempFixture } from "../helpers/fixture";

/**
 * Field report: a correct module split was rolled back because the newly
 * created file reported "Cannot find module '@/...'" for every path-aliased
 * import. Root cause: a buffered created file does not exist on disk, so
 * tsserver checks it in the INFERRED project where tsconfig "paths" do not
 * apply. The fix is two-sided: tag those diagnostics as likely false positives
 * in-transaction, and bounce the document on flush so it joins the configured
 * project and post-flush diagnostics tell the truth.
 */
describe("path-alias diagnostics on created files (integration)", () => {
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
    "in-transaction module errors are tagged; post-flush they clear",
    async () => {
      const buffer = api.beginTransaction();
      await api.writeFile(
        "src/new-module.ts",
        'import { findUser } from "@app/users";\nexport const probe = findUser("u1");\n',
      );
      // Under load the write's own 2s diagnostics window can elapse before
      // tsserver publishes; the publish is cached, so poll getDiagnostics
      // (which runs through the same annotation path).
      let moduleErrors: Awaited<ReturnType<typeof api.getDiagnostics>> = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const diagnostics = await api.getDiagnostics("src/new-module.ts");
        moduleErrors = diagnostics.filter((d) =>
          d.message.includes("Cannot find module"),
        );
        if (moduleErrors.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      // The alias fails in the inferred project — but the message must say
      // it's likely spurious so a verify gate doesn't abort over it.
      expect(moduleErrors.length).toBeGreaterThan(0);
      for (const diagnostic of moduleErrors) {
        expect(diagnostic.message).toContain("FALSE POSITIVE");
        expect(diagnostic.message).toContain("flushed");
      }
      buffer.flush();
      api.endTransaction();

      // After flush the file is on disk and was bounced into the configured
      // project — the alias now resolves. Poll briefly for fresh diagnostics.
      api.beginTransaction();
      let messages: string[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const diagnostics = await api.getDiagnostics("src/new-module.ts");
        messages = diagnostics.map((d) => d.message);
        if (!messages.some((m) => m.includes("Cannot find module"))) break;
      }
      expect(messages.filter((m) => m.includes("Cannot find module"))).toEqual(
        [],
      );
      api.endTransaction();
    },
    { timeout: 60_000 },
  );
});
