/**
 * Whole-project type check over the transactional buffer (checkProject op).
 *
 * Field-driven (PRD § decision log): tsserver checks a file CREATED mid-script
 * in its inferred project — tsconfig "paths" aliases don't resolve there, so a
 * correct module split reports phantom "Cannot find module" errors and verify
 * gates roll back correct refactors. This module sidesteps tsserver entirely:
 * an in-process ts.createProgram whose compiler host reads through the buffer
 * overlay sees created files at their real paths under the real tsconfig, so
 * alias resolution — and everything else — behaves exactly as it will after
 * flush. No disk writes happen.
 */
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { Diagnostic } from "./lsp-api";

export interface ProjectCheckResult {
  /** True when the project has no error-severity diagnostics. */
  ok: boolean;
  /** Total number of errors across the project (diagnostics below is capped). */
  errorCount: number;
  /** Number of workspace source files in the checked program. */
  checkedFileCount: number;
  /** Diagnostics, errors first, capped at 50 — errorCount holds the true total. */
  diagnostics: Diagnostic[];
}

const DIAGNOSTIC_CAP = 50;

const TS_SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function categoryToSeverity(
  category: ts.DiagnosticCategory,
): Diagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "hint";
    default:
      return "info";
  }
}

/**
 * Run the project check. `overlay` maps absolute paths to buffered content
 * (undefined = deleted this script); reads fall through to disk for everything
 * else.
 */
export function runProjectCheck(params: {
  rootDir: string;
  overlay: Map<string, string | undefined>;
}): ProjectCheckResult {
  const { rootDir, overlay } = params;
  // Normalize overlay keys so lookups match however the compiler spells paths.
  const overlayByPath = new Map<string, string | undefined>();
  for (const [absPath, content] of overlay) {
    overlayByPath.set(resolve(absPath), content);
  }
  const overlayRead = (fileName: string): string | undefined | "absent" => {
    const key = resolve(fileName);
    return overlayByPath.has(key) ? overlayByPath.get(key) : "absent";
  };

  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists.bind(ts.sys));
  if (!configPath || !resolve(configPath).startsWith(resolve(rootDir))) {
    throw new Error(
      `checkProject(): no tsconfig.json found under the workspace root ("${rootDir}"). The project check needs the project's compiler options; per-file getDiagnostics still works without one.`,
    );
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `checkProject(): failed to read "${toPosix(relative(rootDir, configPath))}": ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    resolve(configPath, ".."),
  );

  // Created files don't exist on disk, so the config's file enumeration misses
  // them — add buffered TS-family files explicitly (the program dedupes).
  const rootNames = new Set(parsed.fileNames.map((name) => resolve(name)));
  for (const [absPath, content] of overlayByPath) {
    if (content !== undefined && TS_SOURCE_EXTENSIONS.test(absPath)) {
      rootNames.add(absPath);
    }
    if (content === undefined) rootNames.delete(absPath);
  }

  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => {
    const buffered = overlayRead(fileName);
    if (buffered !== "absent") return buffered !== undefined;
    return baseFileExists(fileName);
  };
  host.readFile = (fileName) => {
    const buffered = overlayRead(fileName);
    if (buffered !== "absent") return buffered;
    return baseReadFile(fileName);
  };

  const program = ts.createProgram([...rootNames], options, host);
  const rootResolved = resolve(rootDir);
  const inWorkspace = (fileName: string): boolean => {
    const rel = relative(rootResolved, resolve(fileName));
    return (
      !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("node_modules")
    );
  };

  const all = ts.getPreEmitDiagnostics(program);
  const converted: Diagnostic[] = [];
  for (const diagnostic of all) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    const severity = categoryToSeverity(diagnostic.category);
    if (diagnostic.file) {
      if (!inWorkspace(diagnostic.file.fileName)) continue;
      const start = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      const end = diagnostic.file.getLineAndCharacterOfPosition(
        (diagnostic.start ?? 0) + (diagnostic.length ?? 0),
      );
      converted.push({
        file: toPosix(
          relative(rootResolved, resolve(diagnostic.file.fileName)),
        ),
        range: { start, end },
        message,
        severity,
      });
    } else {
      // Project-level diagnostics (bad compiler option, missing lib).
      converted.push({
        file: toPosix(relative(rootResolved, resolve(configPath))),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        message,
        severity,
      });
    }
  }

  const errors = converted.filter((d) => d.severity === "error");
  const nonErrors = converted.filter((d) => d.severity !== "error");
  const checkedFileCount = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        inWorkspace(sourceFile.fileName) &&
        !sourceFile.fileName.includes("/node_modules/"),
    ).length;
  return {
    ok: errors.length === 0,
    errorCount: errors.length,
    checkedFileCount,
    diagnostics: [...errors, ...nonErrors].slice(0, DIAGNOSTIC_CAP),
  };
}
