# API Surface Review

Three perspectives (power user, minimalist, LLM behavior expert) reviewed the current API. This is the consolidated output.

## Current API (keeping all)

**Read:**

- `lsp.readFile(file)` — read file contents
- `lsp.getSymbolBody(file, symbolPath)` — source of a specific symbol
- `lsp.findSymbol(query)` — workspace-wide symbol search
- `lsp.findReferences(file, symbolPath)` — all references to a symbol
- `lsp.getSymbols(file)` — document symbol tree
- `lsp.goToDefinition(file, symbolPath)` — jump to definition

**Write:**

- `lsp.renameSymbol(file, symbolPath, newName)` — rename across codebase
- `lsp.replaceSymbolBody(file, symbolPath, newText)` — replace full declaration
- `lsp.insertBeforeSymbol(file, symbolPath, text)` — insert before
- `lsp.insertAfterSymbol(file, symbolPath, text)` — insert after

## Must-add (unanimous)

| API                              | Rationale                                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lsp.writeFile(file, content)`   | Can't create new files. Blocks extract-module, scaffold, any generative workflow. Also serves as escape hatch for non-symbol edits (read → JS manipulate → write back). |
| `lsp.searchText(pattern, glob?)` | `findSymbol` only finds named symbols. Can't find string literals, import patterns, TODOs, config values, or regex patterns inside function bodies.                     |
| `lsp.listFiles(glob?)`           | LLM can't discover project structure without this. Guesses file paths blind.                                                                                            |
| `lsp.getDiagnostics(file?)`      | No feedback loop after writes. LLM can't know if changes introduced type errors. Enables write-check-fix loop in a single script.                                       |

## Should-add (strong agreement)

| API                                        | Rationale                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lsp.deleteFile(file)`                     | Needed for dead code removal. Rare but impossible without it. Could defer to v2.                                                                                        |
| `lsp.deleteSymbol(file, symbolPath)`       | Clean removal including JSDoc, decorators, trailing whitespace. LSP knows exact bounds. Workaround exists (readFile + string manipulation + writeFile) but error-prone. |
| `lsp.getImplementations(file, symbolPath)` | Distinct from findReferences — returns only concrete implementations of interfaces/abstract methods, not call sites. Important for interface refactoring.               |

## Skip (unanimous)

- **Line-level operations** — readFile + JS + writeFile covers it
- **String find-replace API** — JS does this natively (`content.replace(...)`)
- **Shell command execution** — out of scope, different tool
- **Type hierarchy** — goToDefinition + findReferences covers most cases
- **Call hierarchy** — defer

## Design decisions for return types and error handling

### `getSymbols` must return the exact `path` to use in other calls

This eliminates the #1 LLM failure mode: guessing symbol paths.

```ts
interface SymbolInfo {
  name: string;
  path: string; // exact string to pass to other lsp.* calls
  kind: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  signature?: string; // one-line signature, avoids needing getSymbolBody just to understand the symbol
  children?: SymbolInfo[];
}
```

### Error messages must target LLMs, not humans

Instead of `"Symbol not found"`, return:

```
Symbol "AuthService.login" not found in "src/auth.ts".
Available top-level symbols: AuthService, UserRole, createAuthMiddleware.
AuthService has children: validate, validateToken, refreshSession, logout.
```

LLM reads this, self-corrects in the same script. Saves an entire retry round-trip.

### Write operations should auto-return diagnostics

```ts
interface WriteResult {
  file: string;
  diagnostics: Diagnostic[];
}
```

LLM knows immediately if it broke something without a separate `getDiagnostics` call.

### `findReferences` must include context lines

```ts
interface Reference {
  file: string;
  line: number;
  context: string; // the actual line of code containing the reference
  symbolPath: string;
}
```

Without context, LLM has to readFile every referenced file. With it, decisions can be made immediately.

### Auto-await the last expression

If the script's last expression is a Promise, auto-await it at the VM level. Prevents a silent footgun where the LLM forgets `await` on the last line and gets `[object Promise]` instead of the value.

### `readFile` should return line-numbered content

LLMs are familiar with `cat -n` format from training data. Line numbers help them reference specific locations for edits.

## Proposed final API (v1)

**Read (8):**

- `lsp.readFile(file)`
- `lsp.getSymbolBody(file, symbolPath)`
- `lsp.findSymbol(query)`
- `lsp.findReferences(file, symbolPath)`
- `lsp.getSymbols(file)`
- `lsp.goToDefinition(file, symbolPath)`
- `lsp.searchText(pattern, glob?)`
- `lsp.listFiles(glob?)`

**Write (6):**

- `lsp.renameSymbol(file, symbolPath, newName)`
- `lsp.replaceSymbolBody(file, symbolPath, newText)`
- `lsp.insertBeforeSymbol(file, symbolPath, text)`
- `lsp.insertAfterSymbol(file, symbolPath, text)`
- `lsp.writeFile(file, content)`
- `lsp.deleteFile(file)`

**Diagnostics (1):**

- `lsp.getDiagnostics(file?)`

**Total: 15 functions.** Up from 10, each addition justified by a concrete workflow gap.
