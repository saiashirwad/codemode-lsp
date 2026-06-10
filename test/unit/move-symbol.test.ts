import { describe, expect, test } from "bun:test";
import {
  addExportModifiers,
  aliasMapsFromPaths,
  importBindingNames,
  namesUsedOutsideImports,
  relativeSpecifier,
  removeImportOfName,
  renderImportHeader,
  rewireMovedImport,
  rewriteSpecifier,
  specifierResolvesTo,
} from "../../src/move-symbol";

describe("relativeSpecifier", () => {
  test("sibling directory", () => {
    expect(relativeSpecifier("src/a/x.ts", "src/b/y.ts")).toBe("../b/y");
  });

  test("same directory", () => {
    expect(relativeSpecifier("src/auth.ts", "src/middleware.ts")).toBe(
      "./middleware",
    );
  });

  test("collapses /index", () => {
    expect(relativeSpecifier("src/x.ts", "src/utils/index.ts")).toBe("./utils");
  });

  test("nested to parent", () => {
    expect(
      relativeSpecifier("src/server/payments/commands.ts", "src/db.ts"),
    ).toBe("../../db");
  });
});

describe("rewriteSpecifier", () => {
  test("relative specifier re-anchors to the new file", () => {
    expect(rewriteSpecifier("./users", "src/auth.ts", "src/sub/m.ts")).toBe(
      "../users",
    );
  });

  test("package and alias specifiers are location-independent", () => {
    expect(rewriteSpecifier("drizzle-orm", "src/a.ts", "src/b/c.ts")).toBe(
      "drizzle-orm",
    );
    expect(rewriteSpecifier("@app/users", "src/a.ts", "src/b/c.ts")).toBe(
      "@app/users",
    );
  });
});

describe("aliasMapsFromPaths / specifierResolvesTo", () => {
  const aliases = aliasMapsFromPaths({ "@app/*": ["src/*"] });

  test("resolve and toAlias round-trip", () => {
    expect(aliases.resolve("@app/users")).toBe("src/users");
    expect(aliases.toAlias("src/server/db")).toBe("@app/server/db");
    expect(aliases.resolve("unrelated")).toBeUndefined();
  });

  test("non-star patterns are ignored", () => {
    const exact = aliasMapsFromPaths({ jquery: ["vendor/jquery"] });
    expect(exact.resolve("jquery")).toBeUndefined();
  });

  test("relative specifiers resolve against the importer", () => {
    expect(specifierResolvesTo("./users", "src/auth.ts", "src/users.ts")).toBe(
      true,
    );
    expect(
      specifierResolvesTo("../users", "src/sub/x.ts", "src/users.ts"),
    ).toBe(true);
    expect(specifierResolvesTo("./other", "src/auth.ts", "src/users.ts")).toBe(
      false,
    );
  });

  test("alias specifiers resolve through the maps", () => {
    expect(
      specifierResolvesTo(
        "@app/users",
        "src/deep/x.ts",
        "src/users.ts",
        aliases,
      ),
    ).toBe(true);
    expect(
      specifierResolvesTo(
        "@app/other",
        "src/deep/x.ts",
        "src/users.ts",
        aliases,
      ),
    ).toBe(false);
  });

  test("directory imports match the index module", () => {
    expect(
      specifierResolvesTo("./utils", "src/x.ts", "src/utils/index.ts"),
    ).toBe(true);
  });
});

describe("renderImportHeader", () => {
  test("merges value and type names with inline type qualifiers", () => {
    expect(
      renderImportHeader([
        { from: "./users", names: ["findUser"], typeOnlyNames: ["User"] },
        { from: "./auth", names: [], typeOnlyNames: ["Token"] },
      ]),
    ).toBe(
      'import { findUser, type User } from "./users";\nimport type { Token } from "./auth";',
    );
  });
});

describe("addExportModifiers", () => {
  test("exports functions, consts, and interfaces, preserving JSDoc", () => {
    const source = [
      "/** doc */",
      "function helper() {}",
      "const config = 1;",
      "interface Shape { x: number }",
      "export function already() {}",
    ].join("\n");
    const result = addExportModifiers("f.ts", source, [
      "helper",
      "config",
      "Shape",
      "already",
    ]);
    expect(result.text).toContain("/** doc */\nexport function helper()");
    expect(result.text).toContain("export const config = 1;");
    expect(result.text).toContain("export interface Shape");
    // Already exported: untouched, not reported.
    expect(result.text).toContain("export function already()");
    expect(result.text).not.toContain("export export");
    expect(result.exported).toEqual(["Shape", "config", "helper"]);
  });
});

describe("namesUsedOutsideImports", () => {
  test("body usage counts; import statements do not", () => {
    const source = [
      'import { gone, kept } from "./mod";',
      "export const x = kept();",
    ].join("\n");
    const used = namesUsedOutsideImports("f.ts", source, ["gone", "kept"]);
    expect(used.has("kept")).toBe(true);
    expect(used.has("gone")).toBe(false);
  });
});

describe("importBindingNames", () => {
  test("collects default, namespace, and named bindings", () => {
    const names = importBindingNames(
      "f.ts",
      [
        'import def from "./a";',
        'import * as ns from "./b";',
        'import { x, type Y } from "./c";',
        "const local = 1;",
      ].join("\n"),
    );
    expect([...names].sort()).toEqual(["Y", "def", "ns", "x"]);
  });
});

describe("removeImportOfName", () => {
  test("sole binding: removes the whole declaration and its newline", () => {
    const result = removeImportOfName({
      fileName: "f.ts",
      sourceText: 'import { moved } from "./old";\nconst x = 1;\n',
      name: "moved",
      isModule: (specifier) => specifier === "./old",
    });
    expect(result.changed).toBe(true);
    expect(result.text).toBe("const x = 1;\n");
  });

  test("shared declaration: removes just the element", () => {
    const result = removeImportOfName({
      fileName: "f.ts",
      sourceText: 'import { a, moved } from "./old";\n',
      name: "moved",
      isModule: (specifier) => specifier === "./old",
    });
    expect(result.text).toBe('import { a } from "./old";\n');
  });

  test("non-matching modules are untouched", () => {
    const result = removeImportOfName({
      fileName: "f.ts",
      sourceText: 'import { moved } from "./elsewhere";\n',
      name: "moved",
      isModule: () => false,
    });
    expect(result.changed).toBe(false);
  });
});

describe("rewireMovedImport", () => {
  test("sole binding: repoints the specifier, preserving quote style", () => {
    const result = rewireMovedImport({
      fileName: "f.ts",
      sourceText: "import { moved } from './old';\nmoved();\n",
      movedName: "moved",
      isOldModule: (specifier) => specifier === "./old",
      newSpecifierFor: () => "./new",
    });
    expect(result.changed).toBe(true);
    expect(result.text).toContain("import { moved } from './new';");
  });

  test("shared declaration: splits the moved binding into its own import", () => {
    const result = rewireMovedImport({
      fileName: "f.ts",
      sourceText: 'import { a, moved, b } from "./old";\n',
      movedName: "moved",
      isOldModule: (specifier) => specifier === "./old",
      newSpecifierFor: () => "../new",
    });
    expect(result.text).toBe(
      'import { a, b } from "./old";\nimport { moved } from "../new";\n',
    );
  });

  test("type-only element splits into an import type", () => {
    const result = rewireMovedImport({
      fileName: "f.ts",
      sourceText: 'import { a, type Moved } from "./old";\n',
      movedName: "Moved",
      isOldModule: (specifier) => specifier === "./old",
      newSpecifierFor: () => "./new",
    });
    expect(result.text).toBe(
      'import { a } from "./old";\nimport type { Moved } from "./new";\n',
    );
  });

  test("untouched files report changed: false", () => {
    const result = rewireMovedImport({
      fileName: "f.ts",
      sourceText: 'import { other } from "./elsewhere";\n',
      movedName: "moved",
      isOldModule: () => false,
      newSpecifierFor: () => "./new",
    });
    expect(result.changed).toBe(false);
  });

  test("new specifier can depend on the matched old one (alias preservation)", () => {
    const result = rewireMovedImport({
      fileName: "src/deep/f.ts",
      sourceText: 'import { moved } from "@app/old";\n',
      movedName: "moved",
      isOldModule: (specifier) => specifier === "@app/old",
      newSpecifierFor: (oldSpecifier) =>
        oldSpecifier.startsWith("@") ? "@app/new" : "./new",
    });
    expect(result.text).toContain('from "@app/new"');
  });
});
