import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..", "..");

/** Absolute path to the committed sample fixture project (read-only tests). */
export const sampleFixtureDir = join(projectRoot, "test", "fixtures", "sample");

/** Path to the locally installed typescript-language-server binary (hermetic, no global install). */
export const lspBin = join(
  projectRoot,
  "node_modules",
  ".bin",
  "typescript-language-server",
);

/**
 * Copy the sample fixture to a temp directory for tests that write to disk.
 * Returns the temp path and a cleanup function.
 */
export function tempFixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codemode-fixture-"));
  cpSync(sampleFixtureDir, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
