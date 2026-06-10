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

  test("a bare directory name lists everything under it (DWIM)", async () => {
    const viaName = await api.listFiles("src");
    const viaGlob = await api.listFiles("src/**");
    expect(viaName).toEqual(viaGlob);
    expect(viaName).toContain("src/auth.ts");
    expect(await api.listFiles("src/")).toEqual(viaGlob);
    expect(await api.listFiles("./src")).toEqual(viaGlob);
  });

  test('"", ".", and an in-root absolute path mean the whole workspace', async () => {
    const all = await api.listFiles();
    expect(await api.listFiles(".")).toEqual(all);
    expect(await api.listFiles("")).toEqual(all);
    expect(await api.listFiles(fixture.dir)).toEqual(all);
    expect(await api.listFiles(join(fixture.dir, "src"))).toEqual(
      await api.listFiles("src/**"),
    );
  });

  test("a non-string glob throws instead of silently matching nothing", async () => {
    await expect(
      api.listFiles({ maxResults: 5 } as unknown as string),
    ).rejects.toThrow(/glob.*must be strings/i);
    await expect(
      api.searchText("findUser", { maxResults: 5 } as unknown as string),
    ).rejects.toThrow(/glob STRING.*no options object/s);
  });

  test("an absolute glob outside the root throws a containment error", async () => {
    await expect(api.listFiles("/etc")).rejects.toThrow(
      /outside the workspace root/,
    );
  });

  test("searchText scans do not open files in the language server", async () => {
    // Field report: a whole-project searchText during a transaction didOpen'd
    // every scanned file (lockfiles, markdown, …) into tsserver, which then
    // "diagnosed" them — 53k garbage errors on a real repo.
    const opened: string[] = [];
    const recordingClient = {
      ensureAlive: async () => {},
      didOpen: (abs: string) => {
        opened.push(abs);
      },
      isOpen: () => false,
    } as unknown as LspClient;
    const trackedApi = new LspApi({
      rootDir: fixture.dir,
      client: recordingClient,
    });
    trackedApi.beginTransaction();
    const results = await trackedApi.searchText("findUser");
    expect(results.length).toBeGreaterThan(0);
    expect(opened).toEqual([]);
    trackedApi.endTransaction();
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
