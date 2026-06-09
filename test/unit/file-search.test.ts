import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { tempFixture } from "../helpers/fixture";

describe("file listing and text search", () => {
  let fixture: { dir: string; cleanup: () => void };
  let api: LspApi;

  beforeEach(() => {
    fixture = tempFixture();
    writeFileSync(join(fixture.dir, ".gitignore"), "ignored.ts\ndist/\n");
    writeFileSync(
      join(fixture.dir, "ignored.ts"),
      "findUser should not match\n",
    );
    mkdirSync(join(fixture.dir, "node_modules"));
    writeFileSync(
      join(fixture.dir, "node_modules", "dep.ts"),
      "export const dep = 1;\n",
    );
    mkdirSync(join(fixture.dir, ".git"));
    writeFileSync(join(fixture.dir, ".git", "config"), "findUser\n");
    api = new LspApi({ rootDir: fixture.dir, client: {} as LspClient });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("glob matcher covers common TypeScript globs", () => {
    expect(globToRegExp("**/*.ts").test("src/auth.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/nested/auth.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/auth.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/auth.ts")).toBe(false);
  });

  test("listFiles respects gitignore and hard exclusions", async () => {
    const files = await api.listFiles("**/*.ts");
    expect(files).toContain("src/auth.ts");
    expect(files).toContain("src/users.ts");
    expect(files).not.toContain("ignored.ts");
    expect(files).not.toContain("node_modules/dep.ts");
  });

  test("searchText returns line, column, match, and context", async () => {
    const results = await api.searchText("findUser", "src/**/*.ts");
    expect(results.some((result) => result.file === "src/auth.ts")).toBe(true);
    expect(results.some((result) => result.file === "src/users.ts")).toBe(true);
    expect(results[0]).toHaveProperty("line");
    expect(results[0]).toHaveProperty("column");
    expect(results[0]).toHaveProperty("context");
  });

  test("searchText reports invalid regexes clearly", async () => {
    await expect(api.searchText("(")).rejects.toThrow(
      /Invalid searchText regex/,
    );
  });
});
