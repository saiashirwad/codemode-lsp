import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextEdit } from "vscode-languageserver-protocol";
import {
  applyTextEdits,
  DeletedFileError,
  TransactionalBuffer,
} from "../../src/buffer";
import type { LspClient } from "../../src/lsp-client";
import { sampleFixtureDir } from "../helpers/fixture";

/** A fake LspClient that records notifications instead of talking to a server. */
function fakeClient() {
  const open = new Set<string>();
  const events: string[] = [];
  const client = {
    didOpen(abs: string) {
      if (open.has(abs)) return;
      open.add(abs);
      events.push(`open:${abs}`);
    },
    didChangeFullText(abs: string) {
      events.push(`change:${abs}`);
      return 2;
    },
    didClose(abs: string) {
      if (!open.has(abs)) return;
      open.delete(abs);
      events.push(`close:${abs}`);
    },
    isOpen(abs: string) {
      return open.has(abs);
    },
  } as unknown as LspClient;
  return { client, events, open };
}

function tempCopy(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codemode-buffer-"));
  cpSync(sampleFixtureDir, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("applyTextEdits", () => {
  test("applies edits bottom-to-top so offsets stay valid", () => {
    const text = "aaa\nbbb\nccc\n";
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
        newText: "AAA",
      },
      {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 3 },
        },
        newText: "CCC",
      },
    ];
    expect(applyTextEdits(text, edits)).toBe("AAA\nbbb\nCCC\n");
  });

  test("rejects overlapping edits", () => {
    const text = "abcdef";
    const edits: TextEdit[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
        newText: "X",
      },
      {
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 6 },
        },
        newText: "Y",
      },
    ];
    expect(() => applyTextEdits(text, edits)).toThrow(/[Oo]verlapping/);
  });
});

describe("TransactionalBuffer state machine", () => {
  test("clean → modified on setText, didChange sent", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      expect(buffer.isDirty()).toBe(false);
      buffer.track(abs);
      expect(events).toContain(`open:${abs}`);
      buffer.setText(abs, "export const x = 1;\n");
      expect(buffer.isDirty()).toBe(true);
      expect(events).toContain(`change:${abs}`);
      expect(buffer.getText(abs, "src/users.ts")).toContain("x = 1");
    } finally {
      fixture.cleanup();
    }
  });

  test("non-TS files are buffered but never announced to the language server", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "notes.md");
      writeFileSync(abs, "# notes\n");
      buffer.track(abs);
      buffer.setText(abs, "# notes\nedited\n");
      expect(events).toEqual([]); // no didOpen/didChange for a .md
      const changes = buffer.flush();
      expect(changes).toHaveLength(1);
      expect(readFileSync(abs, "utf8")).toContain("edited");
    } finally {
      fixture.cleanup();
    }
  });

  test("deleting and rolling back a non-TS file sends no notifications", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "notes.md");
      writeFileSync(abs, "# notes\n");
      buffer.deleteFile(abs, "notes.md");
      buffer.rollback();
      expect(events).toEqual([]);
      expect(readFileSync(abs, "utf8")).toBe("# notes\n"); // disk untouched
    } finally {
      fixture.cleanup();
    }
  });

  test("peekText returns buffered content without tracking unknown files", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      expect(buffer.peekText(abs)).toBeUndefined(); // untracked → caller reads disk
      expect(events).toEqual([]); // peek must not open anything
      buffer.setText(abs, "export const x = 1;\n");
      expect(buffer.peekText(abs)).toBe("export const x = 1;\n");
    } finally {
      fixture.cleanup();
    }
  });

  test("created file: writeFile on a new path → didOpen, flush writes it", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/new-file.ts");
      buffer.writeFile(abs, "export const created = true;\n");
      const changes = buffer.flush();
      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("created");
      expect(readFileSync(abs, "utf8")).toContain("created = true");
    } finally {
      fixture.cleanup();
    }
  });

  test("deleted file: deleteFile → didClose, later read throws", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      buffer.deleteFile(abs);
      expect(buffer.isDeleted(abs)).toBe(true);
      expect(events).toContain(`close:${abs}`);
      expect(() => buffer.getText(abs, "src/users.ts")).toThrow(
        DeletedFileError,
      );
      expect(() => buffer.getText(abs, "src/users.ts")).toThrow(
        /deleted earlier in this script/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("created → deleted in one script: flush leaves no trace", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/ephemeral.ts");
      buffer.writeFile(abs, "x");
      buffer.deleteFile(abs);
      // A created-then-deleted file that never existed on disk leaves no change
      // entry at all: nothing to write, nothing to unlink.
      expect(buffer.flush()).toEqual([]);
      expect(buffer.isDirty()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("flush writes modified content and reports the change", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      const original = readFileSync(abs, "utf8");
      buffer.setText(abs, `${original}\n// appended\n`);
      const changes = buffer.flush();
      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("modified");
      expect(changes[0]?.original).toBe(original);
      expect(readFileSync(abs, "utf8")).toContain("// appended");
    } finally {
      fixture.cleanup();
    }
  });

  test("rollback didChanges a modified file back to its original (no close/open)", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      const original = readFileSync(abs, "utf8");
      buffer.setText(abs, "garbage");
      buffer.rollback();
      // The last change event restores the original; the doc was never closed.
      expect(events.filter((e) => e === `close:${abs}`)).toHaveLength(0);
      expect(
        events.filter((e) => e.startsWith("change:")).length,
      ).toBeGreaterThanOrEqual(2);
      // Disk untouched by rollback.
      expect(readFileSync(abs, "utf8")).toBe(original);
    } finally {
      fixture.cleanup();
    }
  });

  test("rollback closes a created file (it was never on disk)", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/created.ts");
      buffer.writeFile(abs, "x");
      buffer.rollback();
      expect(events).toContain(`close:${abs}`);
    } finally {
      fixture.cleanup();
    }
  });

  test("rollback re-opens a deleted file at its original content", () => {
    const fixture = tempCopy();
    try {
      const { client, events } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/users.ts");
      buffer.deleteFile(abs);
      events.length = 0;
      buffer.rollback();
      expect(events).toContain(`open:${abs}`);
    } finally {
      fixture.cleanup();
    }
  });

  test("partial flush failure names written and not-written files", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const good = join(fixture.dir, "src/users.ts");
      // A path whose parent is a file → writeFileSync fails (ENOTDIR), but only
      // after the good file is written, exercising the partial-failure report.
      const blockerFile = join(fixture.dir, "src/blocker.ts");
      writeFileSync(blockerFile, "x");
      const bad = join(blockerFile, "child.ts");
      buffer.setText(good, "export const ok = 1;\n");
      buffer.writeFile(bad, "y");
      expect(() => buffer.flush()).toThrow(/Failed to flush/);
      // The good file did make it to disk (written before the failure).
      expect(readFileSync(good, "utf8")).toContain("ok = 1");
      // After a partial flush failure everything is reconciled to clean, so the
      // runner's subsequent rollback() cannot diverge written files from disk
      // (PRD § Partial flush failure: LSP state stays consistent with disk).
      expect(buffer.isDirty()).toBe(false);
      buffer.rollback();
      expect(readFileSync(good, "utf8")).toContain("ok = 1");
      expect(buffer.getText(good, "src/users.ts")).toContain("ok = 1");
    } finally {
      fixture.cleanup();
    }
  });

  test("reading a file that never existed throws a not-found error, not DeletedFileError", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/missing.ts");
      expect(() => buffer.getText(abs, "src/missing.ts")).toThrow(
        /does not exist/,
      );
      expect(() => buffer.getText(abs, "src/missing.ts")).not.toThrow(
        DeletedFileError,
      );
      // No phantom record: the file can still be created afterwards.
      buffer.writeFile(abs, "export const x = 1;\n");
      expect(buffer.getText(abs, "src/missing.ts")).toContain("x = 1");
    } finally {
      fixture.cleanup();
    }
  });

  test("deleteFile on a file that never existed throws a not-found error", () => {
    const fixture = tempCopy();
    try {
      const { client } = fakeClient();
      const buffer = new TransactionalBuffer(client);
      const abs = join(fixture.dir, "src/missing.ts");
      expect(() => buffer.deleteFile(abs, "src/missing.ts")).toThrow(
        /does not exist/,
      );
      expect(buffer.isDirty()).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
