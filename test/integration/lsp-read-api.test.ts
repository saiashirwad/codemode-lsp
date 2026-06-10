import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LspApi, type SymbolInfo } from "../../src/lsp-api";
import { LspClient } from "../../src/lsp-client";
import { lspBin, sampleFixtureDir } from "../helpers/fixture";

function flatten(symbols: SymbolInfo[]): SymbolInfo[] {
  return symbols.flatMap((symbol) => [
    symbol,
    ...flatten(symbol.children ?? []),
  ]);
}

describe("LspApi read operations (integration)", () => {
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
    "getSymbols returns discoverable slash paths and signatures",
    async () => {
      const symbols = flatten(await api.getSymbols("src/auth.ts"));
      const paths = symbols.map((symbol) => symbol.path);
      expect(paths).toContain("Token");
      expect(paths).toContain("AuthService");
      expect(paths).toContain("AuthService/validate");
      expect(
        paths.some((path) => path.startsWith("AuthService/constructor")),
      ).toBe(true);
      const validate = symbols.find(
        (symbol) => symbol.path === "AuthService/validate",
      );
      expect(validate?.signature).toContain("validate");
    },
    { timeout: 30_000 },
  );

  test(
    "getSymbolBody supports slash paths and dot aliases",
    async () => {
      const body = await api.getSymbolBody(
        "src/auth.ts",
        "AuthService/validate",
      );
      expect(body).toContain("validate(token: Token)");
      expect(body).toContain("this.sessions.get(token)");

      const dotAliasBody = await api.getSymbolBody(
        "src/auth.ts",
        "AuthService.validate",
      );
      expect(dotAliasBody).toBe(body);
    },
    { timeout: 30_000 },
  );

  test(
    "every fixture SymbolInfo.path round-trips through getSymbolBody",
    async () => {
      const files = await api.listFiles("src/**/*.ts");
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const symbols = flatten(await api.getSymbols(file));
        expect(symbols.length).toBeGreaterThan(0);

        for (const symbol of symbols) {
          const body = await api.getSymbolBody(file, symbol.path);
          expect(body.trim().length).toBeGreaterThan(0);
        }
      }
    },
    { timeout: 30_000 },
  );

  test(
    "getSymbolBody not-found errors list available symbols and children",
    async () => {
      await expect(
        api.getSymbolBody("src/auth.ts", "AuthService/missing"),
      ).rejects.toThrow(
        /Available top-level symbols:.*AuthService.*AuthService has children:.*validate/s,
      );
    },
    { timeout: 30_000 },
  );

  test(
    "findSymbol maps workspace symbols into SymbolInfo records",
    async () => {
      const results = await api.findSymbol("AuthService");
      expect(results.some((symbol) => symbol.name === "AuthService")).toBe(
        true,
      );
      expect(
        results.some((symbol) => symbol.path.includes("AuthService")),
      ).toBe(true);
      expect(results.some((symbol) => symbol.file === "src/auth.ts")).toBe(
        true,
      );
    },
    { timeout: 30_000 },
  );

  test(
    "findReferences returns line context and containing symbol handles",
    async () => {
      const refs = await api.findReferences(
        "src/auth.ts",
        "AuthService/validate",
      );
      expect(refs.some((ref) => ref.context.includes("service.validate"))).toBe(
        true,
      );
      expect(
        refs.some((ref) => ref.symbolPath === "createAuthMiddleware"),
      ).toBe(true);
      expect(refs.every((ref) => ref.isWriteAccess === false)).toBe(true);
    },
    { timeout: 30_000 },
  );

  test(
    "goToDefinition returns a workspace location",
    async () => {
      const location = await api.goToDefinition(
        "src/auth.ts",
        "AuthService/validate",
      );
      expect(location.file).toBe("src/auth.ts");
      expect(location.line).toBeGreaterThan(0);
      expect(location.symbolPath).toContain("AuthService/validate");
    },
    { timeout: 30_000 },
  );

  test("readFile returns raw contents", async () => {
    const text = await api.readFile("src/users.ts");
    expect(text).toContain("export interface User");
    expect(text).not.toContain("1: export interface User");
  });

  test("listFiles and searchText operate on workspace files", async () => {
    const files = await api.listFiles("src/**/*.ts");
    expect(files).toContain("src/auth.ts");
    expect(files).toContain("src/users.ts");
    expect(files).toContain("src/broken.ts");

    const matches = await api.searchText("findUser", "src/**/*.ts");
    expect(matches.some((match) => match.file === "src/auth.ts")).toBe(true);
    expect(matches.some((match) => match.file === "src/users.ts")).toBe(true);
  });

  test(
    "getDiagnostics returns the intentional fixture error after opening the file",
    async () => {
      const diagnostics = await api.getDiagnostics("src/broken.ts");
      expect(
        diagnostics.some((diagnostic) => diagnostic.file === "src/broken.ts"),
      ).toBe(true);
      expect(
        diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      ).toBe(true);
      expect(
        diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      ).toMatch(/number|string/);
    },
    { timeout: 30_000 },
  );

  test("rejects paths outside the workspace", async () => {
    await expect(api.readFile("../../etc/passwd")).rejects.toThrow(
      /outside the workspace root/,
    );
    await expect(
      api.readFile(join(sampleFixtureDir, "..", "outside.ts")),
    ).rejects.toThrow(/outside the workspace root/);
  });

  test(
    "getDependencies lists used imports and same-file helpers — the move computation",
    async () => {
      // createAuthMiddleware uses findUser (value import) but not User (type
      // import from the same declaration), plus same-file AuthService + Token.
      const middleware = await api.getDependencies(
        "src/auth.ts",
        "createAuthMiddleware",
      );
      expect(middleware.imports).toEqual([
        { name: "findUser", from: "./users", typeOnly: false },
      ]);
      expect(middleware.sameFile).toEqual(["AuthService", "Token"]);

      // A method: validate's signature uses the type-only User import and the
      // same-file Token alias; its own class is excluded.
      const validate = await api.getDependencies(
        "src/auth.ts",
        "AuthService/validate",
      );
      expect(validate.imports).toEqual([
        { name: "User", from: "./users", typeOnly: true },
      ]);
      expect(validate.sameFile).toEqual(["Token"]);
    },
    { timeout: 30_000 },
  );
});
