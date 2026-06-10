import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Range, TextEdit } from "vscode-languageserver-protocol";
import type { LspClient } from "./lsp-client";

/**
 * Transactional write buffer (PRD § Transactional Writes).
 *
 * Nothing hits disk until {@link flush}. Each tracked file is in one of four
 * states. A fresh buffer is created per `execute` script; the LSP client (and its
 * open-document set) persists across scripts, so the buffer is responsible for
 * leaving the client's document state consistent with disk on both flush and
 * rollback.
 *
 *   clean    — opened (original stored), not yet written.
 *   modified — written; `original` holds the pre-script disk content.
 *   created  — did not exist on disk before the script; `original` is undefined.
 *   deleted  — existed, then deleteFile'd; later reads throw.
 *
 * On success: write modified/created buffers, unlink deleted files.
 * On failure: didChange modified files back to their originals (NOT close+open —
 * rapid close/open leaves tsserver stale), didClose created files, didOpen
 * deleted files back. Disk is untouched.
 */

export type FileState = "clean" | "modified" | "created" | "deleted";

interface TrackedFile {
  absPath: string;
  state: FileState;
  /** Pre-script disk content. Undefined for files that did not exist (created). */
  original: string | undefined;
  /** Current buffered content. Undefined when deleted. */
  current: string | undefined;
  /** Whether the file existed on disk when first tracked. */
  existedOnDisk: boolean;
}

export interface FlushedChange {
  absPath: string;
  kind: "modified" | "created" | "deleted";
  /** Pre-script content (disk). Empty string for created files. */
  original: string;
  /** Post-script content. Empty string for deleted files. */
  updated: string;
}

/** Thrown by readFile/etc. when a file was deleteFile'd earlier in the script. */
export class DeletedFileError extends Error {
  constructor(relPath: string) {
    super(
      `File "${relPath}" was deleted earlier in this script and can no longer be read.`,
    );
    this.name = "DeletedFileError";
  }
}

export class TransactionalBuffer {
  private readonly files = new Map<string, TrackedFile>();

  constructor(private readonly client: LspClient) {}

  /** Whether any file is in a non-clean state (something to flush/rollback). */
  isDirty(): boolean {
    for (const file of this.files.values()) {
      if (file.state !== "clean") return true;
    }
    return false;
  }

  /**
   * Current content for a tracked-or-untracked file, reflecting buffered writes.
   * Tracks the file (didOpen with disk content) on first access so subsequent
   * reads/writes share one buffer. Throws if the file was deleted this script.
   */
  getText(absPath: string, relPath: string): string {
    const tracked = this.track(absPath);
    if (tracked.state === "deleted") {
      throw new DeletedFileError(relPath);
    }
    if (tracked.current === undefined) {
      // Never existed on disk and never written this script. Don't leave a
      // phantom record behind.
      this.files.delete(absPath);
      throw new Error(
        `File "${relPath}" does not exist. Use lsp.listFiles() to discover project files.`,
      );
    }
    return tracked.current;
  }

  /** Whether a (tracked) file is currently considered deleted in the buffer. */
  isDeleted(absPath: string): boolean {
    return this.files.get(absPath)?.state === "deleted";
  }

  /**
   * Ensure a file is tracked and open in the LSP server with its disk content.
   * Idempotent. Returns the tracked record.
   */
  track(absPath: string): TrackedFile {
    const existing = this.files.get(absPath);
    if (existing) return existing;
    const existedOnDisk = existsSync(absPath);
    const original = existedOnDisk ? readFileSync(absPath, "utf8") : undefined;
    const tracked: TrackedFile = {
      absPath,
      state: "clean",
      original,
      current: original,
      existedOnDisk,
    };
    this.files.set(absPath, tracked);
    if (existedOnDisk && original !== undefined) {
      this.client.didOpen(absPath, original);
    }
    return tracked;
  }

  /**
   * Replace a tracked file's content and send `didChange`. Promotes clean→modified
   * (or keeps created/modified). Used by all in-place write ops.
   */
  setText(absPath: string, text: string): void {
    const tracked = this.track(absPath);
    if (tracked.state === "deleted") {
      // Writing to a file deleted earlier resurrects it as created/modified.
      tracked.state = tracked.existedOnDisk ? "modified" : "created";
      tracked.current = text;
      this.client.didOpen(absPath, text);
      this.client.didChangeFullText(absPath, text);
      return;
    }
    tracked.current = text;
    if (tracked.state === "clean") {
      tracked.state = tracked.existedOnDisk ? "modified" : "created";
    }
    if (!this.client.isOpen(absPath)) {
      this.client.didOpen(absPath, text);
    } else {
      this.client.didChangeFullText(absPath, text);
    }
  }

  /**
   * Create or overwrite a file with `content`. New files become *created* and are
   * didOpen'd; existing files become *modified* and didChange'd.
   */
  writeFile(absPath: string, content: string): void {
    this.setText(absPath, content);
  }

  /** Mark a file deleted: didClose, buffer state → deleted. */
  deleteFile(absPath: string, relPath: string = absPath): void {
    const tracked = this.track(absPath);
    if (!tracked.existedOnDisk && tracked.state === "clean") {
      // Never on disk and never created this script — nothing to delete.
      this.files.delete(absPath);
      throw new Error(
        `Cannot delete "${relPath}": the file does not exist. Use lsp.listFiles() to discover project files.`,
      );
    }
    const wasCreatedThisScript = !tracked.existedOnDisk;
    this.client.didClose(absPath);
    if (wasCreatedThisScript) {
      // Created then deleted in the same script and never on disk: it leaves no
      // trace, so drop tracking entirely rather than flushing a phantom deletion.
      this.files.delete(absPath);
      return;
    }
    tracked.current = undefined;
    tracked.state = "deleted";
  }

  /**
   * Apply a set of LSP TextEdits to one file's buffered content, then didChange.
   * Edits are sorted bottom-to-top so earlier offsets stay valid. Used by rename
   * fan-out and the symbol-range write ops.
   */
  applyEdits(absPath: string, edits: TextEdit[]): void {
    const tracked = this.track(absPath);
    if (tracked.current === undefined) {
      throw new Error(`Cannot apply edits to a deleted file: ${absPath}`);
    }
    tracked.current = applyTextEdits(tracked.current, edits);
    if (tracked.state === "clean") {
      tracked.state = tracked.existedOnDisk ? "modified" : "created";
    }
    if (!this.client.isOpen(absPath)) {
      this.client.didOpen(absPath, tracked.current);
    } else {
      this.client.didChangeFullText(absPath, tracked.current);
    }
  }

  /** All currently-dirty files' absolute paths. */
  dirtyPaths(): string[] {
    const paths: string[] = [];
    for (const [absPath, file] of this.files) {
      if (file.state !== "clean") paths.push(absPath);
    }
    return paths;
  }

  /**
   * Flush all buffered changes to disk. Returns the list of changes for diffing.
   * On a partial failure (permission/disk full) it throws an error naming exactly
   * which files were and weren't written, after restoring the unwritten files'
   * LSP buffers to their pre-script content so the server state matches disk.
   * All records are marked clean afterwards, so a subsequent {@link rollback}
   * (the runner calls it on any script failure) cannot diverge the written files
   * from what is now on disk.
   */
  flush(): FlushedChange[] {
    const changes: FlushedChange[] = [];
    const written: string[] = [];
    const pending = [...this.files.entries()].filter(
      ([, file]) => file.state !== "clean",
    );

    for (const [absPath, file] of pending) {
      try {
        if (file.state === "deleted") {
          if (file.existedOnDisk) unlinkSync(absPath);
          changes.push({
            absPath,
            kind: "deleted",
            original: file.original ?? "",
            updated: "",
          });
        } else if (file.state === "created") {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, file.current ?? "", "utf8");
          changes.push({
            absPath,
            kind: "created",
            original: "",
            updated: file.current ?? "",
          });
        } else {
          writeFileSync(absPath, file.current ?? "", "utf8");
          changes.push({
            absPath,
            kind: "modified",
            original: file.original ?? "",
            updated: file.current ?? "",
          });
        }
        written.push(absPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notWritten = pending
          .map(([path]) => path)
          .filter((path) => !written.includes(path));
        this.reconcileAfterPartialFlush(pending, written);
        throw new Error(
          `Failed to flush changes to disk while writing "${absPath}": ${message}.\n` +
            `Written: ${written.length > 0 ? written.join(", ") : "(none)"}.\n` +
            `Not written: ${notWritten.join(", ")}.\n` +
            "The written files are on disk; the unwritten files were restored to " +
            "their pre-script content. Re-read the written files before retrying.",
        );
      }
    }
    return changes;
  }

  /**
   * After a partial flush failure, bring LSP state back in line with disk:
   * written files already match disk (mark them clean, their buffered content is
   * the new original); unwritten files are restored to their pre-script content
   * exactly as {@link rollback} would. Everything ends clean so the runner's
   * rollback is a no-op.
   */
  private reconcileAfterPartialFlush(
    pending: Array<[string, TrackedFile]>,
    written: string[],
  ): void {
    for (const [absPath, file] of pending) {
      if (written.includes(absPath)) {
        file.original = file.current;
        file.state = "clean";
        continue;
      }
      try {
        if (file.state === "modified") {
          if (file.original !== undefined && this.client.isOpen(absPath)) {
            this.client.didChangeFullText(absPath, file.original);
          }
        } else if (file.state === "created") {
          this.client.didClose(absPath);
        } else if (file.state === "deleted") {
          if (file.original !== undefined && !this.client.isOpen(absPath)) {
            this.client.didOpen(absPath, file.original);
          }
        }
      } catch {
        // Best-effort, same rationale as rollback().
      }
      file.current = file.original;
      file.state = "clean";
    }
  }

  /**
   * Roll back the LSP server's document state to match untouched disk. Disk itself
   * is never modified here (no flush happened). modified files didChange back to
   * their originals; created files didClose; deleted files didOpen back.
   */
  rollback(): void {
    for (const [absPath, file] of this.files) {
      try {
        if (file.state === "modified") {
          if (file.original !== undefined && this.client.isOpen(absPath)) {
            this.client.didChangeFullText(absPath, file.original);
          }
        } else if (file.state === "created") {
          this.client.didClose(absPath);
        } else if (file.state === "deleted") {
          if (file.original !== undefined && !this.client.isOpen(absPath)) {
            this.client.didOpen(absPath, file.original);
          }
        }
      } catch {
        // Best-effort: the server may have died, in which case a respawn re-opens
        // documents on demand. Rollback must never throw over disk consistency
        // (disk was never touched).
      }
    }
  }
}

/**
 * Apply LSP TextEdits to a string. Edits are applied from the highest offset to
 * the lowest so earlier replacements don't shift later ranges. Throws on
 * overlapping edits (which LSP forbids) rather than silently corrupting.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const withOffsets = edits.map((edit) => ({
    start: offsetAt(text, edit.range.start.line, edit.range.start.character),
    end: offsetAt(text, edit.range.end.line, edit.range.end.character),
    newText: edit.newText,
  }));
  withOffsets.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of withOffsets) {
    if (edit.end > lastStart) {
      throw new Error("Overlapping text edits cannot be applied.");
    }
    result =
      result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    lastStart = edit.start;
  }
  return result;
}

/** Convert a (line, character) position into a string offset (LF/CRLF aware). */
export function offsetAt(
  text: string,
  line: number,
  character: number,
): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < line && offset < text.length) {
    const char = text[offset];
    if (char === "\r" && text[offset + 1] === "\n") {
      offset += 2;
      currentLine += 1;
    } else if (char === "\n" || char === "\r") {
      offset += 1;
      currentLine += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(offset + character, text.length);
}

/** Re-export the Range type for ops that build edits inline. */
export type { Range };
