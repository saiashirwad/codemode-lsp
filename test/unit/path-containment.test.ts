import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspApi } from "../../src/lsp-api";
import type { LspClient } from "../../src/lsp-client";
import { sampleFixtureDir, tempFixture } from "../helpers/fixture";

function apiFor(rootDir: string): LspApi {
  return new LspApi({ rootDir, client: {} as LspClient });
}

describe("LspApi path containment", () => {
  const root = sampleFixtureDir;

  test("accepts relative paths inside the workspace", () => {
    const resolvedPath = apiFor(root).resolveWorkspacePath("src/auth.ts");
    expect(resolvedPath.relPath).toBe("src/auth.ts");
    expect(resolvedPath.absPath).toBe(join(root, "src", "auth.ts"));
  });

  test("accepts absolute paths inside the workspace", () => {
    const inside = join(root, "src", "users.ts");
    const resolvedPath = apiFor(root).resolveWorkspacePath(inside);
    expect(resolvedPath.relPath).toBe("src/users.ts");
  });

  test("rejects relative paths escaping the workspace", () => {
    expect(() => apiFor(root).resolveWorkspacePath("../outside.ts")).toThrow(
      /outside the workspace root/,
    );
  });

  test("rejects absolute paths outside the workspace", () => {
    expect(() => apiFor(root).resolveWorkspacePath("/etc/passwd")).toThrow(
      /outside the workspace root/,
    );
  });

  test("rejects symlink escapes outside the workspace", () => {
    const fixture = tempFixture();
    const outside = mkdtempSync(join(tmpdir(), "codemode-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret\n");
      symlinkSync(outside, join(fixture.dir, "escape"), "dir");
      expect(() =>
        apiFor(fixture.dir).resolveWorkspacePath("escape/secret.txt"),
      ).toThrow(/outside the workspace root/);
    } finally {
      fixture.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
