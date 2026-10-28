# Language servers

How the navigation tool talks to csharp-ls, typescript-language-server, rust-analyzer and the Angular language server
(`src/tool/lsp/`).

## Client — `src/tool/lsp/client.ts`

`LspClient.start({ command, cwd, corpusRoot, workspaceRoot?, initializationOptions?, experimentalCapabilities?, configuration?, requestTimeoutMs?, log?, env?, onNotification? })`
spawns the server over stdio, sends `initialize` with `rootUri` and one workspace folder at
`workspaceRoot` (default `corpusRoot`), then `initialized`. `experimentalCapabilities` becomes the
client's `capabilities.experimental`; both it and `configuration` are unset for csharp-ls and
typescript-language-server. The typed API:

| Method | LSP request |
|---|---|
| `open(path)` | `textDocument/didOpen` (once per file; every position request opens its file first) |
| `definition(pos)` | `textDocument/definition` |
| `references(pos, includeDeclaration = false)` | `textDocument/references` |
| `implementation(pos)` | `textDocument/implementation` |
| `documentSymbol(path)` | `textDocument/documentSymbol`, hierarchical results flattened with their container name |
| `workspaceSymbol(query)` | `workspace/symbol`; each result's container name, location from its range (a `WorkspaceSymbol` without a range lands on line 1, column 1). typescript-language-server answers only once a document of the project is open |
| `incomingCalls(pos)` | `textDocument/prepareCallHierarchy` then `callHierarchy/incomingCalls` per item |
| `reload(path)` | `textDocument/didChange` with the full text when the file is open; always drops the cached line text |
| `forget(path)` | `textDocument/didClose` when open; drops the cached line text |
| `watchedFilesChanged(changes)` | `workspace/didChangeWatchedFiles` (`created` / `changed` / `deleted`) |
| `shutdown()` | `shutdown` + `exit`, then kills whatever is left |
| `kill()` | `SIGKILL` to the server's process group |

Server-to-client requests are answered so servers do not stall: `workspace/configuration` gets,
per item, `configuration[item.section]` or `null`, `workspace/workspaceFolders` the root, everything else (`client/registerCapability`,
`window/workDoneProgress/create`) `null`. `window/logMessage`, `window/showMessage` and stderr go
to the optional log file.

### Positions and locations

Inputs and outputs use the tool's Location form, never raw LSP positions:

- A `Position` is `{ path, line, column }`: path relative to the tree root (or absolute), 1-based
  line, 1-based column counted in characters (Unicode code points).
- LSP positions are 0-based and count UTF-16 code units. The client reads the line text and
  converts both ways, so a column after an emoji or any astral character is still right.
- A returned `Location` is `{ path, startLine, endLine, line, column, insideRoot }`.
  `startLine`/`endLine` are the 1-based inclusive lines of the range (an LSP end at character 0 of
  a later line ends on the line before). `line`/`column` are the start of the selection range
  (the declared name for `LocationLink` and document symbols). `path` is root-relative with
  `/` separators when `insideRoot`, otherwise the absolute path or the raw non-file URI (for
  example decompiled metadata).

### Lifetime and process ownership

Every server is spawned `detached`, so it leads its own process group; `kill()` signals the whole
group (`-pid`). That also stops helpers a server starts itself, such as Roslyn's MSBuild build host
under csharp-ls. A request that exceeds its timeout kills the server and rejects with
`LspTimeoutError`. `shutdown()` always ends with a group kill, so nothing the client started can
outlive it.

### Root paths

The client resolves `corpusRoot` and `workspaceRoot` with `realpath`. On macOS `os.tmpdir()` is
under `/var/folders/...`, a symlink to `/private/var/folders/...`; csharp-ls works with the real
path and silently returns no definition for documents opened under the `/var` spelling.

## csharp-ls and typescript-language-server

| Language | Command | cwd / workspace root | Notes |
|---|---|---|---|
| C# | `~/.dotnet/tools/csharp-ls --solution <file>.slnx` | the solution's directory | csharp-ls 0.28.0 loads a `.slnx` solution directly |
| TypeScript / TSX | `typescript-language-server --stdio` (4.4.0, from PATH) | the `tsconfig.json` directory | Locations are still reported relative to the tree root |

Both need a restored tree (`npm ci`, `dotnet restore`). Discovery and overrides are
`navigation-tool.md` §Language servers.

Behaviour that matters for timing and correctness:

- **csharp-ls** answers `initialize` within a second but loads the solution in the background;
  until then `definition` returns an empty list. The load starts only with the first request that
  needs the workspace; a server that gets none never loads. It ends with the `window/logMessage`
  `Finished loading solution "<path>"` (the client passes every notification to `onNotification`). While loading it logs MSBuild workspace
  diagnostics marked `[Failure]` for NuGet audit warnings (known-vulnerable packages); the projects
  still load and resolve, including across projects.
- **typescript-language-server** first answers from a partial-semantic tsserver while the full
  project loads. During that window it may return an empty list or the local import binding
  instead of the declaration in the other module. A correct answer is therefore the first answer
  that equals the expected location, not the first non-empty one.

## rust-analyzer

Started by the tool's pool (`src/tool/lsp/pool.ts`, `navigation-tool.md` §Language
servers). Installed by Homebrew (`/opt/homebrew/bin/rust-analyzer`,
2026-10-11 build, commit `2ad81e72b7`), next to Homebrew Rust 1.90 (no rustup; a partial `rust-src`).

- Command: `rust-analyzer` with no arguments (stdio), cwd and workspace root = the Cargo workspace
  directory, one process per workspace.
- Settings, sent as `initializationOptions` and again as the answer to its
  `workspace/configuration` request for section `rust-analyzer` (its LSP-extensions doc: the
  options carry the `rust-analyzer` section because the server cannot ask for configuration during
  `initialize`, and it asks for the section afterwards; answering with the same settings keeps a
  later `null` from replacing them). Keys per the configuration reference of
  this build:
  - `cargo.buildScripts.enable: false` — no `build.rs` runs.
  - `procMacro.enable: false` — no proc-macro server, no proc-macro builds.
  - `checkOnSave: false` — no `cargo check` (flycheck).
  - `linkedProjects: [<abs>/Cargo.toml]` — exactly the slot's manifest, no project discovery.
  - `cargo.sysrootSrc: <library dir>` — only when `CODE_NAV_RUST_SRC` is set or
    `code-nav install rust-src` has installed the source for the current rustc; otherwise absent,
    and rust-analyzer uses `{cargo.sysroot}/lib/rustlib/src/rust/library` (`cargo.sysroot`
    defaults to `"discover"`, i.e. `rustc --print sysroot`). Read at server start only.
  Nothing third-party is compiled or run; the only cargo calls are `cargo metadata` (workspace and
  sysroot) and `rustc --print` queries.
- Environment: `CARGO_NET_OFFLINE=true` on top of the daemon's environment, so `cargo metadata`
  never downloads. Dependencies not already in `CARGO_HOME` make it fall back to `--no-deps`
  (logged as a warning); navigation inside the workspace still works. The same holds for the
  sysroot's own metadata query (the library workspace): until its dependencies are in
  `CARGO_HOME` (`code-nav install rust-src`) it falls back to `--no-deps` and the serverStatus
  message says `Failed to read Cargo metadata with dependencies for sysroot`.
- Readiness: the client advertises `experimental.serverStatusNotification: true`; rust-analyzer
  then sends `experimental/serverStatus { health, quiescent, message }`, and the first one with
  `quiescent: true` marks the server loaded. On this toolchain health is `warning` (rust-analyzer
  supports toolchains ≥ 1.94 only); answers inside the workspace are still correct.
- Standard library: without a complete `rust-src` and the library's dependencies in `CARGO_HOME`,
  `std`, `core` and `alloc` load partly or not at all, so definitions into them and types that flow
  through them do not resolve; `navigation-tool.md` §Language servers and §`install rust-src`.

## Angular language server

npm `@angular/language-server` 21.2.25 (bundles `@angular/language-service` 21.2.25 and TypeScript
5.9.3; source: angular/angular `vscode-ng-language-service/server`). Started by the pool beside
typescript-language-server (`navigation-tool.md` §Angular).

- Command: `node <package>/index.js --stdio --tsProbeLocations <project dir>,<package dir>
  --ngProbeLocations <project dir>,<package dir>`; cwd and workspace root = the project (TypeScript
  root) directory. Both probe lists are required: they are where the server looks for `typescript`
  and `@angular/language-service`. No `initializationOptions`, no configuration; the server sends no
  requests to the client.
- Capabilities used: `definition`, `references`. It has no `documentSymbol`, `workspace/symbol`,
  `implementation` or call hierarchy, so `impls`/`callers` stay on typescript-language-server.
- Readiness: a project loads when a file is opened; the server then sends `angular/projectLoadingStart`
  and `angular/projectLoadingFinish` (tsserver's ProjectLoadingStart/FinishEvent). On the test app
  the finish came about 5 s after start, first correct answers 5.7–8.8 s, warm answers 2–44 ms; about
  1.5 GB RSS for one `node` process with no children; `shutdown` plus the group kill leaves nothing.
- `.html` documents open with languageId `html` (`LANGUAGE_IDS` in `client.ts`). Open them under the
  realpath'd root: with `/var` vs `/private/var` spellings mixed the answers were empty.
- Definition is answered only in an Angular context (`isInAngularContext`): on a plain TypeScript
  position it returns an empty list by design, so the tool falls back to typescript-language-server.
- References include the declaration even with `includeDeclaration: false`; the tool drops the asked
  position and, from a template, the server's own definition location.
- Pipes: references on a pipe class miss its `| name` template usages, and references on `transform`
  return every pipe's `transform` across Angular itself (1604 locations on the test app). The tool
  never asks references on `transform` and adds a syntax scan of `| name` instead.

## No server for CSS and SCSS

CSS and SCSS have no language server: vscode-css-language-server resolves references and definitions
only inside the asked document (vscode-css-languageservice v6.3.10 `src/services/cssNavigation.ts`),
so the tool answers their `refs`/`def` from the syntax index across all files instead
(`navigation-tool.md` §CSS and SCSS).
