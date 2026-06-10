import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, sampleFixtureDir, tempFixture } from "../helpers/fixture";

describe("call hierarchy (integration)", () => {
  let client: LspClient;
  let api: LspApi;

  beforeEach(() => {
    client = new LspClient({ rootDir: sampleFixtureDir, lspBin });
    api = new LspApi({ rootDir: sampleFixtureDir, client });
  });

  afterEach(async () => {
    await client.stop();
  });

  test(
    "incomingCalls returns true callers with exact call sites",
    async () => {
      const callers = await api.incomingCalls("src/users.ts", "findUser");
      expect(callers).toHaveLength(1);
      const caller = callers[0];
      expect(caller?.file).toBe("src/auth.ts");
      expect(caller?.symbolPath).toBe("createAuthMiddleware");
      expect(caller?.kind).toBe("function");
      expect(caller?.callSites).toHaveLength(1);
      expect(caller?.callSites[0]?.context).toContain("findUser(user.id)");
    },
    { timeout: 30_000 },
  );

  test(
    "a call inside an anonymous arrow is attributed to the enclosing named function",
    async () => {
      // service.validate(token) sits inside the arrow returned by
      // createAuthMiddleware — the CallInfo must name the function, not the
      // unaddressable arrow (field report: callers got `<function>`-ish noise).
      const callers = await api.incomingCalls(
        "src/auth.ts",
        "AuthService/validate",
      );
      expect(callers.map((c) => c.symbolPath)).toEqual([
        "createAuthMiddleware",
      ]);
      expect(callers[0]?.callSites[0]?.context).toContain(
        "service.validate(token)",
      );
    },
    { timeout: 30_000 },
  );

  test(
    "outgoingCalls resolves callees across files and skips library calls",
    async () => {
      const callees = await api.outgoingCalls(
        "src/auth.ts",
        "createAuthMiddleware",
      );
      const handles = callees.map((c) => `${c.file}::${c.symbolPath}`);
      // Cross-file resolution: findUser is imported from users.ts. Calls into
      // lib.d.ts (Map.get etc.) are filtered out.
      expect(handles).toContain("src/users.ts::findUser");
      expect(handles).toContain("src/auth.ts::AuthService/validate");
      for (const callee of callees) {
        expect(callee.file.startsWith("src/")).toBe(true);
        // Dedupe: no repeated call-site positions (tsserver quirk).
        const positions = callee.callSites.map((s) => `${s.line}:${s.column}`);
        expect(new Set(positions).size).toBe(positions.length);
      }
    },
    { timeout: 30_000 },
  );

  test(
    "a non-callable symbol throws an error naming its kind and the fix",
    async () => {
      await expect(api.incomingCalls("src/users.ts", "User")).rejects.toThrow(
        /no call hierarchy.*function, method, or constructor.*"interface"/s,
      );
    },
    { timeout: 30_000 },
  );

  test(
    'a module-level caller gets symbolPath "" — never the filename',
    async () => {
      // Field report: calls inside bare test(...) blocks were attributed to
      // the FILE as a CallHierarchyItem, leaking its name (a filename) into
      // symbolPath, where it cannot round-trip. "" marks top level, matching
      // the Reference convention.
      const fixture = tempFixture();
      writeFileSync(
        join(fixture.dir, "src", "seed.ts"),
        'import { findUser } from "./users";\n\nexport const seeded = findUser("u1");\n',
      );
      const tempClient = new LspClient({ rootDir: fixture.dir, lspBin });
      const tempApi = new LspApi({ rootDir: fixture.dir, client: tempClient });
      try {
        const callers = await tempApi.incomingCalls("src/users.ts", "findUser");
        const fromSeed = callers.find((c) => c.file === "src/seed.ts");
        expect(fromSeed).toBeDefined();
        // `seeded` is a variable, not a function — depending on tsserver the
        // item is the file or the binding; either way the path must round-trip
        // or be "".
        expect(fromSeed?.symbolPath.endsWith(".ts")).toBe(false);
      } finally {
        await tempClient.stop();
        fixture.cleanup();
      }
    },
    { timeout: 30_000 },
  );

  test(
    "findReferences attributes a reference to the enclosing function, not the nearest binding",
    async () => {
      // `const user = service.validate(token)` — the reference must belong to
      // createAuthMiddleware, never to the local `user` binding.
      const refs = await api.findReferences(
        "src/auth.ts",
        "AuthService/validate",
      );
      const inMiddleware = refs.find((ref) =>
        ref.context.includes("service.validate(token)"),
      );
      expect(inMiddleware?.symbolPath).toBe("createAuthMiddleware");
    },
    { timeout: 30_000 },
  );
});
