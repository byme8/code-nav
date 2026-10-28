# The navigation tool (`code-nav`)

A command-line tool an agent calls through the shell, backed by one warm
daemon per working tree. Syntax commands (`find`, `outline`, `show`) answer from an in-memory
index built with ast-grep and the GraphQL declaration regexes. Language-server commands (`refs`,
`def`, `impls`, `callers`) answer C#, TypeScript/TSX and Rust from csharp-ls,
typescript-language-server and rust-analyzer running warm inside the same daemon, and CSS/SCSS `refs`
and `def` from vscode-css-language-server. GraphQL `refs` and `def` answer
from an in-memory parse of the root schema and the GraphQL documents (`src/tool/graphql/`), and
`trace` combines that parse with typescript-language-server references.

The usage note agents get is `prompts/navigation-tool-note.md`.

Languages are a tool-level type (`ToolLanguage` in `src/tool/index/symbols.ts`):
`csharp | typescript | graphql` (`src/tool/language.ts`) plus `rust`, `wgsl`, `css` (`.css`) and
`scss` (`.scss`). Rust and WGSL
are checked on a pinned public repository, see §Rust demo and §WGSL demo. WGSL has syntax commands only (`find`, `outline`, `show`); there is
no WGSL language server. CSS and SCSS have the syntax commands plus `refs` and `def` (§CSS and SCSS);
Less is not supported.

## Build and run

- `bun src/tool/build.ts <outdir>` compiles `src/tool/cli.ts` into one executable,
  `<outdir>/code-nav`. On macOS the build re-signs it ad hoc (`codesign --force --sign -`):
  Bun 1.4.0's `--compile` output carries an invalid signature there and the kernel kills it on
  launch (exit 137).
- During development `bun src/tool/cli.ts <command> …` behaves the same.
- The compile step (`compileTool` in `src/tool/compile.ts`) is shared by `build.ts` and the global
  install below.
- The daemon is the same program with the hidden `daemon <root> <hash>` subcommand; nothing else
  starts it.
- Runtime dependency: the `ast-grep` CLI (0.45.3) on `PATH`, run by the daemon only.
- Grammars: `bun src/tool/grammars.ts` (network; never a test) builds the WGSL and then the SCSS
  grammar, one line per library with its size and sha256.
- WGSL grammar: `bun src/tool/grammars.ts` shallow-clones
  tree-sitter-grammars/tree-sitter-wgsl-bevy at commit `d9306a798ede627001a8e5752f775858c8edd7e4`
  (tag `v0.1.4`; WGSL plus Bevy-style `#import`/`#define_import_path`/`#ifdef`/`#ifndef`/`#else`/`#endif`)
  into a temp dir, checks `git rev-parse HEAD`, compiles `src/parser.c` and
  `src/scanner.c` with the system `clang -shared -fPIC -O2` into `data/grammars/wgsl.dylib`
  (`wgsl.so` off macOS; ignored, about 100 KB), and deletes the checkout — the grammar's source never
  enters the repository. The tool looks for the library at `CODE_NAV_WGSL_GRAMMAR` if set, else in
  `data/grammars/` of the checkout it runs from: `bun src/tool/build.ts` fixes that directory into
  the executable at build time (`--define CODE_NAV_GRAMMAR_DIR=…`). It registers the library with
  ast-grep as the custom language `wgsl` through an `sgconfig.yml` (`customLanguages.wgsl`:
  `libraryPath` absolute, `languageSymbol: tree_sitter_wgsl_bevy` because the library does not export
  the default `tree_sitter_wgsl`, `extensions: [wgsl]`; no `expandoChar`, the rules use no patterns) that
  it writes to `<os.tmpdir()>/code-nav/grammars/<first 16 hex of sha256(library path)>/` and passes
  as `ast-grep scan --config`. Only `.wgsl` files are scanned with that config, in their own
  `ast-grep scan`, so a tree without `.wgsl` files never touches the grammar.
- SCSS grammar: the same command builds it right after WGSL (`GRAMMARS` in `src/tool/grammars.ts`):
  tree-sitter-grammars/tree-sitter-scss at commit `eb69c8f55ecc17235f43358c65ec644578554f92` (tag
  `v1.0.0`) into `data/grammars/scss.dylib` (`scss.so`, `scss.dll`; about 200 KB). That repository
  is the maintained one (the original serenadeai/tree-sitter-scss has had no push since 2022); every
  later commit up to 2026-10-05 only touches CI, docs and bindings except the last, `5da5ba7`, which
  regenerates the parser with tree-sitter 0.27 (a breaking, unreleased change), so the tag is pinned.
  Path: `CODE_NAV_SCSS_GRAMMAR` if set, else `data/grammars/` as for WGSL (`scssLibraryPath()` in
  `src/tool/index/scss.ts`); custom language `scss` with `languageSymbol: tree_sitter_scss`,
  `extensions: [scss]`, its own `sgconfig.yml` under the same temp directory scheme, and only `.scss`
  files in that scan. Without the config ast-grep's built-in `Css` would claim `.scss` files too.
- CSS needs no extra grammar: `.css` files go through the main `ast-grep scan` with ast-grep's built-in
  `Css` language.

### Global install

`bun src/tool/install-global.ts [--bin-dir <dir>] [--claude-home <dir>]` (defaults `~/.local/bin`
and `~/.claude`), run from this checkout, installs the tool for every Claude Code session on the
machine; re-running it is how the installed tool is updated after a change here. In order:

- Fails up front, installing nothing, if `ast-grep` is not on `PATH`.
- Compiles with `compileTool` into `<bin-dir>/.code-nav.install-<pid>.tmp` and renames it over
  `<bin-dir>/code-nav`, never rewriting the existing executable in place (macOS kills a signed
  executable whose file was rewritten in place, exit 137). A failed build removes the temp file,
  leaves the old binary untouched and exits 1 naming the failure.
- Writes `<claude-home>/skills/code-nav/SKILL.md`: front matter (`name: code-nav`, a description
  naming the navigation tasks and the seven languages), when to prefer code-nav over `rg`/Read, then
  `prompts/navigation-tool-note.md` verbatim. Other
  skills are not touched.
- Adds `Bash(code-nav:*)` to `permissions.allow` in `<claude-home>/settings.json` by textual
  insertion, so every other byte stays as it was; a missing `permissions` or `allow` is added with
  the file's indentation, a missing file is created with only that entry. A file that is not valid
  JSON (or whose `permissions` / `allow` has the wrong type) is left unchanged, reported, and the
  command exits 1 after the other pieces.
- Stops every code-nav daemon recorded under `<os.tmpdir()>/code-nav/*/daemon.json` (`stop` per
  recorded root, as `code-nav stop` does), so the next call starts the new binary.
- Prints one line per piece: `binary: <path> (version <TOOL_VERSION>, commit <sha>)`,
  `skill: <path>`, `permission: … added | already present | not added …`, `daemons: <n> stopped`,
  and `optional dependencies: all present` or the missing ones (csharp-ls,
  typescript-language-server, rust-analyzer, vscode-css-language-server, the WGSL and SCSS grammar
  libraries); a missing one only means
  that language's commands answer `error: …`.

Running it twice leaves the same files and reports the permission as already present.
`test/install-global.test.ts` runs it against temp directories with `TMPDIR` pointed at a temp
directory, so it only ever sees and stops the daemon it started.

## Root and state

- Root: `--root <dir>` (anywhere on the command line), else `CODE_NAV_ROOT`, else the nearest
  ancestor of the working directory holding `.git`, else the working directory; symlinks resolved.
- State dir: `<os.tmpdir()>/code-nav/<first 16 hex of sha256(root)>/` holding `daemon.sock` (Unix
  socket), `daemon.json` (`{ pid, root, version, startedAt, servers }`, where `servers` lists every
  running language server as `{ name, pid, command, workspace }` — from the moment its process is
  spawned, before `initialize` answers — and is rewritten whenever one starts or stops), `daemon.log`, one log per language server (`csharp-ls.log`,
  `typescript-language-server-<workspace>.log`, `rust-analyzer[-<workspace>].log`,
  `vscode-css-language-server.log`) and, while a CLI is starting the daemon,
  `start.lock`.
- Protocol: one connection per request; the CLI writes `{ argv, cwd }` as JSON and half-closes, the
  daemon answers `{ exitCode, stdout }` and closes. The CLI prints `stdout` and exits with
  `exitCode`. Commands are answered one at a time, in arrival order. The health ping and `status`
  are answered at once, outside that queue, so a daemon busy with a slow command (a C# command
  waiting for the solution load) still answers the next CLI's ping and is not taken for
  unresponsive; they re-arm the idle timer only while no command is queued or running.

## Daemon lifecycle

| Situation | Behaviour |
|---|---|
| First command in a tree | The CLI spawns the daemon detached (its own session and process group), waits until it answers a ping, and prints `daemon started in <s> s (<n> files indexed)` as the first line of that command's output |
| Later commands | Answered by the running daemon; no extra line |
| Socket missing or refusing, daemon PID dead, no ping reply within 10 s, or a different tool version | If `daemon.json`'s PID is alive and `ps` shows a code-nav daemon for this root hash, its process group gets SIGKILL; a new daemon starts; the command's first line is `daemon restarted (<reason>)` |
| No request for 30 minutes (`CODE_NAV_IDLE_MS` overrides) | The daemon exits and removes its state dir |
| `code-nav stop` | The daemon answers `daemon stopped`, exits and removes its state dir; the CLI waits for the PID to end (SIGKILL to the group after 5 s). Unresponsive daemon: killed by PID group, `daemon <pid> killed (<reason>)`. None: `no daemon running`. Always exit 0 |
| `code-nav status` | Never starts a daemon. Prints PID, root, version, files indexed, uptime, idle limit and the last freshness scan; `not found: no daemon running for <root>` (exit 1) when there is none |
| Two working trees | Two state dirs, two daemons; each walks only its own root |
| An exception while answering | `error: <message>`, exit 3; the daemon keeps running |

A daemon removes the state dir only while `daemon.json` still names its own PID, so a replaced
daemon never deletes its successor's state. ast-grep runs are in the daemon's process group. Each
language server leads its own process group (the LSP client's rule, `language-servers.md`), so it
can be stopped with its helpers (tsserver, the MSBuild build host) without the daemon: on `stop`
and idle exit the daemon sends `shutdown` to every initialized server, waits at most 1.5 s, then
SIGKILLs each spawned server's group — including one still answering `initialize`, which the pool
tracks from spawn (`LspClientOptions.onSpawn`) — and it SIGKILLs them on any other process exit; a
config-change restart SIGKILLs such a server at once. Whoever kills a daemon from
outside — the CLI replacing a crashed, unresponsive or other-version daemon, `stop` after the
5 s wait, the tests — also SIGKILLs the groups of the servers `daemon.json` lists, after checking
with `ps` that each PID still runs that server's command (`killDaemonTree` in
`src/tool/daemon/lifecycle.ts`).

## Language servers

`src/tool/lsp/pool.ts` owns the servers of one daemon.

- Discovery, from the index's configuration paths: csharp-ls on the tree's shallowest `.slnx` (else
  `.sln`; ties by path), run in that file's directory with `--solution <file>`; one
  typescript-language-server per directory holding a `tsconfig.json` that is not inside another
  such directory (a nested `e2e/tsconfig.json` under a web app's directory is left to that
  app's tsserver). A TypeScript file goes to the server
  with the longest workspace prefix of its path. One rust-analyzer per Cargo workspace root: every
  `Cargo.toml` maps to its nearest ancestor-or-self `Cargo.toml` holding a `[workspace]` table, else
  to its own directory, and each distinct directory is one slot (vello: one, the root). A `.rs` file
  goes to the slot with the longest workspace prefix of its path; none above it →
  `rust-analyzer not available: no Cargo.toml above <path>`. A tree without any `Cargo.toml` has no
  rust-analyzer slot at all, so `status` of a C#/TypeScript tree is unchanged. One
  vscode-css-language-server for the whole tree (workspace = the root), serving `.css` and `.scss`
  alike (language ids `css`/`scss` in `didOpen`); its slot exists once the index holds a `.css` or
  `.scss` file, or is created by the first CSS/SCSS position when such a file appears later (there
  are no CSS configuration files to trigger a re-discovery). Locations are
  reported relative to the tree root.
- Start: every server starts in the background once the daemon listens; a command that needs one
  waits for it. Executables are `~/.dotnet/tools/csharp-ls`, `typescript-language-server`,
  `rust-analyzer` and `vscode-css-language-server` (npm `vscode-langservers-extracted`) from `PATH`,
  overridable by `CODE_NAV_CSHARP_LS` / `CODE_NAV_TYPESCRIPT_LS` / `CODE_NAV_RUST_ANALYZER` /
  `CODE_NAV_CSS_LS` (the tests' missing and slow servers). How rust-analyzer is configured
  (no build scripts, proc macros or check, cargo offline) is `language-servers.md` §rust-analyzer;
  vscode-css-language-server is `language-servers.md` §vscode-css-language-server.
- Readiness, vscode-css-language-server: ready once `initialize` has answered; it parses each document
  on request, there is no workspace load.
- Readiness, csharp-ls: csharp-ls 0.28.0 loads the solution lazily — it waits after `initialized`
  until the first request that needs the workspace (an idle server never logs `Loading solution`;
  observed: a command waited 600 s). The pool therefore sends one `workspace/symbol` right after
  start and treats the server as ready on the `window/logMessage` `Finished loading solution`
  (exit or 600 s without it: not available). On a ~2,800-file .NET + React tree the load takes
  about 5 s, and the first request after it another 15–20 s while Roslyn compiles (first C#
  command 23.5 s in total including a 2.2 s daemon start; later ones 2–6 s).
- Readiness, typescript-language-server: started with `tsserver.useSyntaxServer: "never"`, so there
  is only the semantic tsserver and a request waits for the project load instead of being answered
  by the partial-semantic server (which can return the local import binding, `language-servers.md`).
  Ready once `initialize` has answered.
- Readiness, rust-analyzer: the client advertises `experimental.serverStatusNotification`, and the
  server is ready on the first `experimental/serverStatus` with `quiescent: true` (workspace loaded,
  no pending background work). Exit or 600 s without it: not available; quiescent with
  `health: "error"` (the workspace failed to load): not available with the status message.
  `health: "warning"` is ready and logged in `daemon.log` — the Homebrew toolchain always warns
  (rust-analyzer wants toolchain ≥ 1.94, Homebrew Rust is 1.90).
  Fixture crate: first answer 1.4 s after start; vello (260 `.rs` files): 4.5 s after a 0.8 s
  daemon start.
- Rust standard library: rust-analyzer loads `std`/`core`/`alloc` as a Cargo workspace — the
  library sources plus their own crates.io dependencies (`hashbrown`, `cfg-if`, …), resolved by
  `cargo metadata` offline from `CARGO_HOME`. When that fails, std is loaded without dependency
  edges (or not at all): `def` of `Box` is `not found`, and anything whose type flows through std
  is unresolved (a method call on the closure argument of `iter().map(|s| …)`, calls inside
  `vec![…]`). Homebrew Rust 1.90 ships a partial `rust-src` (no `sysroot`, `test`, `unwind`,
  `stdarch` …) and nothing fetches the library's dependencies, so out of the box std misses.
  `code-nav install rust-src` (§`install rust-src`) fixes both. Where the source comes from:
  `CODE_NAV_RUST_SRC` (a `library` directory) if set, else
  `<cache>/rust-src/<rustc version>/rust-src/lib/rustlib/src/rust/library` if it holds a
  `Cargo.toml` (version from `rustc --version`, `RUSTC` honoured, run in the workspace directory),
  else the toolchain's own sysroot; a chosen path goes to rust-analyzer as `cargo.sysrootSrc`
  (`language-servers.md` §rust-analyzer) and into `daemon.log`. The source is read at each
  rust-analyzer start, so a running daemon picks a new install up after `code-nav stop` (or a
  restart on a Cargo change).
- Std offer note: rust-analyzer's first quiescent `experimental/serverStatus` message is the
  signal. It names the sysroot problem verbatim: `Failed to read Cargo metadata with dependencies
  for sysroot` (the library's dependencies are not in `CARGO_HOME`) or `can't load standard
  library` / `can't find standard library sources` / `is missing a \`core\` library` (no source).
  A per-answer signal (a `def` that lands nowhere) is not usable: a miss into std and a miss for
  any other reason look the same, and with a partial source `def` of `iter()` does land in the
  library. When the slot's status carries one of those messages, the first `refs`/`def`/`impls`/
  `callers` answer of that daemon that asked rust-analyzer and exits 1 gets the line
  `note: std not available to rust-analyzer (<problem>); run \`code-nav install rust-src\`` after
  any `waited` line; `<problem>` is `standard-library source not installed` or `the standard
  library's crate dependencies are not in CARGO_HOME <path>`. Later misses carry no note.
- A command's wait for a server, when over 1 s, is its first line: `waited <s> s for <server>`.
- Not available: a missing executable, a failed `initialize`, a solution load that never finishes,
  or a second crash (an unexpected exit; the first one restarts the server in the background, and a
  request it interrupted is retried once on the new server). `def`, `impls` and `callers` then exit
  3 with `error: <server> not available: <reason>`; `refs` as described below; `find`, `outline`
  and `show` keep working. A tree without a solution or `tsconfig.json` has that server not
  available from the start. A configuration change retries an unavailable server. Rust follows the
  same rules: `def` with rust-analyzer missing exits 3 with
  `error: rust-analyzer not available: executable not found: <command>`, and `outline` still answers.
- WGSL has no language server: `refs`, `def`, `impls` and `callers` on a `.wgsl` position exit 3
  with `error: no language server for wgsl: <path> is WGSL, which has syntax commands only (find,
  outline, show)` — no syntax fallback, not even for `refs`. The pool has no WGSL slot and `status`
  lists none.
- CSS/SCSS: `impls` and `callers` exit 3 with `error: impls is not supported for css: <path> is CSS,
  where vscode-css-language-server answers refs and def only` (`callers`, `scss`/`SCSS` likewise),
  without starting the server. `refs` with the server missing falls back to the syntax scan of
  §CSS and SCSS; `def` exits 3 as for the other servers.
- `status` adds one line per server: `server <name> <workspace> pid <pid> ready|starting` or
  `server <name> <workspace> not available: <reason>`.

## Freshness

Before every `find`, `outline` and `show` the daemon walks the root (skipping `.git`,
`node_modules`, `bin`, `obj`), stats every source file (`.cs`, `.ts`, `.tsx`, `.mts`, `.cts`,
`.graphql`, `.gql`, `.rs`, `.wgsl`, `.css`, `.scss`) and project configuration file (`*.csproj *.sln *.slnx Directory.*.props
Directory.*.targets global.json nuget.config` for C#; `package.json package-lock.json
tsconfig*.json` for TypeScript; `Cargo.toml Cargo.lock` for Rust), and compares mtime, size and inode with its snapshot. Created and
changed source files are re-parsed (one ast-grep run over just those files; GraphQL in memory),
deleted ones dropped; a rename is a delete plus a create. The scan runs before `refs`, `def`,
`impls`, `callers` and `trace` too, and every scan (whatever the command) is forwarded to the language
servers before the answer:

- A configuration change restarts the owning server(s) (C#: csharp-ls; TypeScript: every
  typescript-language-server, after re-discovering the `tsconfig.json` roots; Rust: every
  rust-analyzer, after re-discovering the Cargo workspace roots) before the answer. rust-analyzer's
  `cargo metadata` writes a missing `Cargo.lock`, which then counts as a configuration change on
  the next scan and restarts it once; the test fixture therefore ships its `Cargo.lock`.
- Otherwise each server gets the source files of its language under its workspace: deleted →
  `didClose` when open; changed → `didChange` with the full text when open; and one
  `workspace/didChangeWatchedFiles` with every created, changed and deleted file. A created or
  changed TypeScript file that is not open is opened (`didOpen` from disk): typescript-language-server
  4.4.0 ignores `didChangeWatchedFiles`, and tsserver's own file watchers fire late, so an open
  document is the only way the next answer sees the edit. Rust files are handled the same way
  (opened when not open), so the next answer never depends on rust-analyzer's own watcher; so are
  `.css`/`.scss` files for vscode-css-language-server, which answers from open documents only. Checked
  on the fixture crate: a created `src/extra.rs` calling `total_area`, plus `pub mod extra;` added
  to `lib.rs`, was in the very next `refs total_area`, without a restart.
- csharp-ls created/deleted file pickup, checked on a .NET solution: a new `.cs` file calling an
  existing static method was in the very next `callers`
  and `refs` answers, the caller vanished after the file was deleted, and an edit removing a call
  from an unopened handler removed that caller — all through `didChangeWatchedFiles`, no restart.
  So a created or deleted `.cs` file does not restart csharp-ls.

Measured on a tree of 2,871 walked paths (2,849 source files): the walk and compare
takes 25–32 ms per command, under the 150 ms limit, so no file watcher is used. The first index
build (start-up) took 2.9 s.

## Syntax index

Per file: language, stamp, and symbols `{ kind, name, start, end, nameLine, nameColumn, container }`.

- C#, TypeScript, TSX: one `ast-grep scan --json=stream` with the outline rule set from
  `src/tool/index/rules.ts` (rule id = kind) plus a declaration
  rule over the read-symbol declaration kinds (C# also `field_declaration` and record parameters;
  TS top-level `lexical_declaration` / `variable_declaration`). Each name is paired with the
  smallest declaration node containing it: `start`/`end` are that node's lines, `nameLine` and
  `nameColumn` (1-based characters) the name's.
- GraphQL: the declaration regexes (`src/tool/index/declarations.ts`) over the file
  text; `end` is the block end rule (a header's closing `}`, a field's own line or the line closing
  its argument list).
- Rust: the same `ast-grep scan`, with tool-owned rules in `src/tool/index/rust.ts` over
  ast-grep's built-in Rust grammar. Kinds: `function` (a `fn`
  at file or `mod` level), `method` (a `fn` or signature in an `impl` or `trait` body), `struct`,
  `enum`, `trait`, `impl` (named `impl <Trait> for <Type>` or `impl <Type>`, whitespace collapsed;
  its name position is the `impl` keyword), `module`, `const` and `type` (also associated ones
  inside `impl`/`trait`, including `type Item;`), `static`, `macro` (`macro_rules!`). Items inside
  function bodies are not listed. The declaration rule covers the same item nodes.
- WGSL: a separate `ast-grep scan` with tool-owned rules in `src/tool/index/wgsl.ts` over the
  custom language (§Build and run). Kinds: `fn`, `struct` with its members as `field` (container:
  the struct), `var` printed with its address space (`var<storage>`, `var<workgroup>`, `var<uniform>`;
  plain `var` for a handle such as a texture; the access mode is dropped), `const`, `override`,
  `alias`. Despite the Bevy fork, the pinned grammar's WGSL is the older dialect: it has no `const`
  or `alias` keyword (it knows module-scope `let` and `type X = …`), so a `const`/`alias` declaration
  parses as an `ERROR` node starting with the identifier `const`/`alias`, and the rules take the
  identifier right after it as the name, the `ERROR` node as the declaration range. A `type X = …`
  alias is also listed as `alias`; a module-scope `let` (no longer valid WGSL) is not listed, because
  error recovery turns function-local `let`s after a syntax the grammar does not know into top-level
  ones. "Top level" is the file or a declaration-level `#ifdef`/`#ifndef`/`#else` branch (at any
  nesting, but not one inside a fn or struct).
- WGSL with a shader preprocessor: the grammar parses the directives as nodes (`preproc_import`,
  `define_import_path`, `preproc_ifdef` with `preproc_else`, at declaration, struct-member and
  statement level); the tool does not preprocess. Directives are never listed as symbols. Every
  branch's declarations are listed, so a name declared in both `#ifdef a` and `#ifdef b` appears twice
  (each at its own line); struct members inside an `#ifdef` are fields of the struct. Syntax the
  grammar does not know (`switch x {` without parentheses, `case A, default`) can make tree-sitter's
  recovery cut a function short or swallow the declarations after it (§WGSL demo).
- WGSL grammar missing (or failing to load): every `.wgsl` file stays in the index without symbols,
  and `outline`/`show <path> …` of a `.wgsl` file and `find --lang wgsl` exit 3 with
  `error: WGSL grammar not available: <library> not found (build it with \`bun src/tool/grammars.ts\`,
  or set CODE_NAV_WGSL_GRAMMAR)` (a library that does not load: `WGSL grammar not usable: <library>:
  <ast-grep error> (rebuild it with …)`). `find` without `--lang` ranks the other languages as
  usual and, when the tree has `.wgsl` files, prints `note: <that message>; WGSL files not ranked`
  first. Every other language keeps working. Once the library appears, the next command's freshness
  pass parses the waiting files.
- CSS: the main `ast-grep scan` with tool-owned rules in `src/tool/index/css.ts` over ast-grep's
  built-in `Css`. Kinds: `rule` (a rule set; name = its selector list, whitespace collapsed, so
  `.button,\n.button--primary` is `.button, .button--primary`; name position = the selector start),
  `custom-property` (a `--x` declaration at any level, `:root` or a rule), `keyframes` (the
  keyframes name), `media` and `supports` (name = the condition text, `(max-width: 600px)`; name
  position = the `@` keyword), `font-face` (name = the `font-family` value unquoted, else
  `font-face`), `import` (name = the imported URL or string). Nested rules (CSS nesting, `&`
  selectors) are listed under their parent. Range: the whole rule set / statement / declaration.
- SCSS: a separate `ast-grep scan` with the same rules over the custom language `scss`
  (§Build and run), plus `variable` (a `$x: …` declaration at any level, name with the `$`),
  `mixin`, `function`, `placeholder` (a rule whose selector is a lone `%x`; name with the `%`),
  `use` and `forward` (named like `import`). Known grammar gaps (pinned commit): a Sass map value
  `(key: $v, …)` is a parse error, so variables used inside it are not seen by the reference scan; and
  `@extend %x;` swallows the declaration after it into the extend statement (that declaration's
  `var(--y)` is then not a reference). Neither breaks the outline.
- SCSS grammar missing (or failing to load): as for WGSL, with `SCSS grammar not available: …` /
  `SCSS grammar not usable: …`, `CODE_NAV_SCSS_GRAMMAR`, and `note: …; SCSS files not ranked`.
- `container` is the nearest enclosing type (C# class, record, struct, interface, enum; TS class;
  GraphQL type, input, enum; Rust `impl`, `trait`, `module`; WGSL struct; CSS `rule`, `media`,
  `supports`; SCSS those plus `placeholder`, `mixin`, `function`). A Rust item inside an `impl` gets the
  impl's self type as container (`impl Shape for Circle` → `Circle`, generics and path dropped), so
  `Circle.area` names the method and `find --target member` labels it `Circle.area`.
- `find` units for Rust: file level (`--target file`) are `struct enum trait function module type
  const static macro`, except associated consts and types; members (`--target member`) are
  `method` plus those associated consts and types. `impl` blocks are outline-only.
- `find` units for WGSL: file level are `fn struct var const override alias` (a `var` of any
  address space); members are struct `field`s, labelled `Struct.field`.
- `find` units for CSS: file level and members are both `rule custom-property keyframes font-face`
  at any depth (SCSS adds `variable mixin function placeholder`); `media`, `supports` and imports
  never count. The term rule splits selectors and names at their punctuation, so `.button--primary`
  gives `button`, `primary`, `--brand-color` gives `brand`, `color`, `$base-gap` gives `bas`, `gap`.
  A member is labelled `<container>.<name>` like any other (`:root.--brand-color`).

## Commands, input forms and output

Paths are root-relative or absolute inside the root; printed paths are root-relative with `/`.
Exit status: 0 success; 1 `not found: <what>`; 2 `ambiguous: <what>` then one candidate per line;
3 `error: <what>`. The status word starts the first line (after a start-up line, if any).

### `find [--target file|member] [--lang L]… [--kind K]… <words…>`

Symbol search: the words are matched against declared names at one of two targets, chosen only by
`--target` (default `file`), never guessed from the words. Any other `--target` value exits 3.

- `--target file`: one line per file, best first: `<path>  <score>  <matched terms>`.
- `--target member`: one line per member declaration (C# method, constructor, property, field and
  nested type — class record struct interface enum declared inside another type; TS class method;
  GraphQL field), best first:
  `<path>:<line>:<col> <kind> <Owner.name>  <score>  <matched terms>` (just `<name>` when the
  member has no containing type).

Score with two decimals, terms comma-separated in query order. The top 10 are printed; when more
units score above 0, a final line `… <N> more`. Nothing above 0:
`not found: no file or symbol name matches <words>`, exit 1.

Ranking (fixed before the first development run; units and places amended after it):

1. Query terms: the words through `findKeywords` (the stop-word list in
   `src/tool/index/declarations.ts`), then the term rule below, deduplicated.
2. Term rule: split at non-alphanumerics and camelCase / PascalCase / digit boundaries, lower-case,
   then stem. A fixed irregular list maps whole words first and ends the rule: `children→child`,
   `people→person`, `indices→index`, `matrices→matrix`, `statuses→status`, `status→status`.
   Otherwise: `ies→y`, `sses→ss`, a trailing `s` (not `ss`) dropped, then `ing` or `ed` dropped,
   then a trailing `e` dropped; a step applies only when at least 3 letters remain (`pricing`,
   `prices`, `price` → `pric`).
3. A unit's terms, each at its best place:
   - file: 3 in the file name, 2 in a file-level declaration name, 1 in a directory segment.
     File-level declarations: C# top-level class record struct interface enum (a type nested in another
     type is a member unit instead); TS/TSX
     function component class type interface enum constant; GraphQL type input enum interface and
     query mutation subscription fragment. Member names never count.
   - member: 3 in its own name, 2 in its containing type's name, 1 in a segment of its file's path.
4. Score = Σ over matched distinct query terms of ln(N / df) × place, where N is the number of
   units (files or members) of the unit's language and df those whose terms include the term.
5. Kinds: `tests` (a directory segment `test`, `tests`, `__tests__` in any case, or ending
   `.Tests`, `.IntegrationTests`, `.UnitTests`; a file `*.test.ts(x)` or `*.spec.ts(x)`),
   `migrations` (a `Migrations` directory, `*.Designer.cs`, `*ModelSnapshot.cs`), `generated`
   (`isGeneratedPath`). A file of any kind (and every member in it) scores × 0.5 unless `--kind` names one of its kinds
   (repeatable or comma-separated). Only the option switches this, never the query words.
6. `--lang csharp|typescript|graphql|rust|wgsl|css|scss` (repeatable or comma-separated) limits the units;
   default all. Each language is ranked over its own units, so a tree without `.rs`, `.wgsl`,
   `.css` or `.scss` files ranks exactly as before those languages existed. (A language with a single file scores 0 for
   every term, ln(1/1), so it never ranks.)
7. Ties by path in byte order, then by line.

### `outline <path>`

The path, then `<start>-<end> <kind> <name>` per symbol in source order, indented two spaces per
enclosing type. `start` is the name's line; `end` is the declaration's last line. Kinds: C#
`class record struct interface enum constructor method property field`; TypeScript
`function component class method type interface enum constant`; GraphQL
`type input enum field enum-value query mutation subscription fragment`; Rust, WGSL, CSS and SCSS kinds as in §Syntax index (an impl prints as
`impl impl Shape for Circle`: kind, then name; a WGSL global as `var<storage> lights`). A file with no symbols prints only its path.

### `show`

| Input | Answer |
|---|---|
| `show <path>:<line>[:<col>] [<name>]` | The smallest symbol whose declaration contains the line (named `<name>` when given) |
| `show <path> <name> [<line>]` | With a line: as above. Without: the symbol of that name in the file |
| `show <name>` / `show <Owner.name>` | Every indexed symbol of that name (whose container is `Owner`) |

One symbol: `<path>:<start>-<end> <kind> <name>`, then the file's lines `start..end` verbatim.
`start..end` is the whole declaration node, attributes included (GraphQL: the header or field line to its block end). Several: exit 2,
`ambiguous: <input>` and one `<path>:<start>-<end> <kind> <name>` per candidate, by path then line.
None: exit 1.

### Positions (`refs`, `def`, `impls`, `callers`)

`src/tool/commands/position.ts`:

| Input | Position |
|---|---|
| `<path>:<line>:<col>` | That character (1-based line and column, columns in characters) |
| `<path>:<line> <name>` | The first whole-word `<name>` on that line |
| `<name>` / `<Owner.name>` | The name of the one indexed declaration of that name (whose container is `Owner`). A constructor is dropped when its own type is also a candidate. Several: exit 2, `ambiguous: <input>`, then `<path>:<line>:<col> <kind> <name>` per declaration, by path then position. None: exit 1 `not found: declaration of <input>` |

In a `.css`/`.scss` file a name also takes `-` and `%` (besides letters, digits, `_` and `$`), so a
position inside `var(--brand-color)` names `--brand-color` and one inside `$base-gap` names `$base-gap`.
A bare `<name>` is first looked up as a whole among CSS/SCSS symbols (so `.card` or `--brand-color`
is not split at `.`); only when none is named so does the `<Owner.name>` rule apply. `show <name>`
does the same.

A line past the file's end or a column past the line's end exits 1. On a GraphQL position `refs`
and `def` answer by the GraphQL rules below; `impls` and `callers` exit 3 (`… needs a C# or
TypeScript position` — wording kept from before Rust, which they also accept).

Every answer below may start with `waited <s> s for <server>`. An empty answer exits 1
(`not found: references to <name> at <path>:<line>:<col>`, likewise `definition of`,
`implementations of`, `callers of`). Only locations inside the root are printed; line text comes
from the daemon's read of the file, trimmed.

### `refs <position>`

`references(position, includeDeclaration = false)`. Per file a `<path>` line, then
`  <line>:<col>  <line text>` per location; files by path in byte order, locations by position.

Server not available: when the index holds exactly one declaration of the position's name in that
language (constructors as above), the answer is every identifier occurrence of the name in that
language's indexed files — the ast-grep `reference` rule from `src/tool/index/rules.ts`;
for Rust the tool's own rule over `identifier type_identifier field_identifier
shorthand_field_identifier` (`rustReferenceRuleText` in `src/tool/index/rust.ts`) — minus the declaration's own name, with the first line `note: <server> not available; syntax
references of a unique name`, then the same grouping. Otherwise exit 3 naming the server. CSS and
SCSS have their own rules, §CSS and SCSS.

### `def <position>`

`definition(position)`; the first location inside the root, printed as
`<path>:<line>:<col>  <line text>` (the declared name's position). Overloads are resolved by the
server. Only outside the root: exit 1, naming where the server pointed.

### `impls <position>`

`implementation(position)`; one `<path>:<line>:<col> <kind> <name>` per location, by path and
position. Kind and name are the index symbol whose name is at that position, else the smallest
symbol containing the line (`symbol <identifier>` when the index has none).

### `callers <position>`

`incomingCalls(position)`; per caller its selection start, `<path>:<line>:<col> <kind> <name>`,
kind and name from the index as for `impls` (when the index has none: the LSP kind and the
server's name cut at `(`).

### CSS and SCSS

`refs` and `def` ask vscode-css-language-server. Its references and definitions never leave the
document of the position: `findReferences` is `findDocumentHighlights` mapped to the document's
URI and `findDefinition` looks the symbol up in that document's own stylesheet
(vscode-css-languageservice v6.3.10, `src/services/cssNavigation.ts`), and the server passes them
through unchanged. So:

- every CSS/SCSS `refs` answer and every `def` that finds nothing carries
  `note: vscode-css-language-server resolves references|definitions inside <path> only` after any
  `waited` line;
- the server's references include the declaration itself (they are highlights); `refs` drops every
  location that is the name position of an index symbol of that name, as `includeDeclaration = false`
  would;
- `def` from a use in another file (`var(--brand-color)` in `layout.css`, `@include button-base` in a
  file that `@import`s the mixin) is `not found`.

`refs` with the server not available scans the indexed `.css` files (built-in `Css`) and `.scss`
files (the `scss` grammar, skipped when it is not available) with one rule per name class, chosen
from the name (`styleReferenceKind` in `src/tool/commands/refs.ts`, rules `styleReferenceRuleText` in
`src/tool/index/css.ts`):

| Name | References | Needs |
|---|---|---|
| `--x` | `property_name`, `plain_value` or `identifier` `--x` (declarations and `var(--x)`), CSS and SCSS | exactly one `custom-property` `--x` |
| `$x` | SCSS `variable` or `property_name` `$x` (also `ns.$x`) | exactly one `variable` `$x` |
| `%x` | SCSS `placeholder` `%x` (`@extend %x`) | exactly one `placeholder` `%x` |
| preceded by `.` | `class_name` inside a `class_selector`, CSS and SCSS | nothing (classes have no declaration) |
| a `mixin` name | the name of an `@include` | exactly one `mixin` |
| a `function` name | a `function_name` (any call) | exactly one `function` |
| a `keyframes` name | a `plain_value` in an `animation`/`animation-name` declaration, CSS and SCSS | exactly one `keyframes` |

The declaration's own name is dropped; the first line is `note: vscode-css-language-server not
available; syntax references of a unique name` (`… of a class name`). Anything else answers the
server's `error: … not available`.

### GraphQL: root schema, documents and the selection parent type

`src/tool/graphql/`. `refs`, `def` and `trace` take `--schema <path>` anywhere on the command line.

- Root schema: `--schema <path>` (an indexed `.graphql` file, else exit 1); else the schema named by
  the tree's GraphQL codegen configs — every indexed `codegen.ts` / `.mts` / `.cts` whose first
  `schema: '<path>.graphql'` resolves (relative to the config's directory) to an indexed GraphQL
  file; else the indexed `.graphql` files declaring `type Query`. Exactly one candidate is the root
  schema; several exit 2 (`ambiguous: root GraphQL schema (…); pass --schema <path>`, one path per
  line); none exits 1. When a backend copy of the schema also declares `type Query`, the codegen
  rule is what decides; the test fixture has no codegen config and one `schema.graphql`.
- Schema parse (over the whole file in memory): lines between `"""` delimiters are skipped; a column-0 `type|interface|input <T>` header
  (also after `extend`) opens `T`'s block, any other column-0 line closes it; inside, a field is
  `^\s+<f>\s*[:(]` and its named type is the first name after `:` (after the `)` that closes a
  multi-line argument list), `[`, `]`, `!` removed. Re-parsed when the file's stamp changes.
- Documents: every indexed `.graphql` file except the root schema and files declaring a type,
  input or enum (other schema copies).
- Document parse: a GraphQL tokenizer (strings, block strings and `#` comments skipped) and a
  brace-nesting parser, so one-line selections
  (`price { amount currencyId }`) and multi-line argument lists resolve too. The parent-type rule:
  an operation starts at `Query` / `Mutation` / `Subscription`, `fragment … on T`
  and `... on T` at `T`, a field `f` (alias `a: f` → `f`) at `f`'s named type in the current type's
  block of the root schema; an unknown field makes everything below it unresolved. Each selection
  keeps its field, line, column (on the field name, not the alias), parent type and the definition
  (operation or fragment) holding it; each definition keeps the fragments it spreads.

### GraphQL `def <position>`

The position is a field selection in a document (on its name or its alias). The answer is that
field inside its parent type's block of the root schema, `<schema>:<line>:<col>  <line text>`,
column on the name. Not found (exit 1): a position in the root schema, a position that is not a
field selection, a parent type that does not resolve or does not declare the field.

### GraphQL `refs <position>`

The position is a field line of a schema file (its type and name), or a field selection in a
document (resolved to its schema field as for `def`). The answer is every document selection of
that field whose parent type is that type, grouped as for `refs`: per document `<path>`, then
`  <line>:<col>  <line text>`. No such selection: exit 1.

### `trace [--schema <path>] <position> | <Type.Property>`

The position must be a C# property or field (record parameters included) with a containing type
`C`; anything else exits 3. `f` = the camelCase rule (`camelCase` in `src/tool/index/declarations.ts`) of its name. Steps 1–4
read only the index and file texts; steps 5–6 ask typescript-language-server.

1. `csharp-property`: the input position.
2. `schema-field`: the `f` field of type or interface `C` in the root schema; when the schema has
   no type or interface `C`, every type/interface field named `f`. None: exit 1
   `not found: schema field <f> of <C> in <schema>`.
3. `document-selection`: every document selection of `f` whose parent type is a step-2 type.
4. `generated-ts-member`: per selecting document `X.graphql`, every whole-word `f` in `X.gql.ts`
   beside it (when indexed); and in every generated (`isGeneratedPath`) TypeScript file other than
   a `.gql.ts` holding `export type C = `, the first `f` member line of that type's block.
5. `service-hook`: operations are the operation holding each step-3 selection — for a selection
   inside a fragment, every operation (in any document) spreading that fragment, directly or through
   other fragments. Per operation `O` in `X.graphql`, each `X.gql.ts` line
   `^export function use<O>(Query|LazyQuery|SuspenseQuery|Mutation|Subscription)\b`: `references`
   on the hook name; each location outside generated files maps to the outermost top-level
   function or constant of the index containing it whose name starts with `use` and whose name line
   starts with `export`. The link is that hook's name.
6. `component`: `references` on each step-4 `.gql.ts` occurrence; each `.tsx` location maps to the
   outermost index symbol containing it, kept when it is a component, function, constant or class
   whose name starts with `A-Z`. The link is its name.

Output: one line per link, `<role> <path>:<line>:<col>  <line text>`, roles in the `TRACE_ROLES`
order (`src/tool/language.ts`), then by path in byte order, line and column, duplicates dropped; nothing else except a
leading `waited <s> s for typescript-language-server` when the wait exceeded 1 s. A role with no
link is absent. typescript-language-server not available: exit 3
`error: typescript-language-server not available: <reason>`, with no chain printed — never a
partial chain. About 3 s with a warm daemon on a ~2,800-file tree.

### Rust demo

The check for Rust is the tool on linebender/vello v0.9.0, commit
`875f324f21da93019cae9e8e61d4abfd69893206` (260 `.rs` files, one Cargo workspace).
`bun src/demo/prepare.ts <dest>` (one-time, network; never a test) refuses a `<dest>` outside the OS
temp directory or not empty, runs `git clone --depth 1 --revision=<commit>`, checks
`git rev-parse HEAD`, then `cargo fetch --locked` with `CARGO_HOME=data/cargo-home` (ignored,
about 800 MB; never `~/.cargo`). Run the tool in `<dest>` with that same `CARGO_HOME` so
rust-analyzer's `cargo metadata` finds the fetched crates offline.

Results (2026-10-14, rust-analyzer 2026-10-11 build): `outline glifo/src/atlas/commands.rs` lists
the same 27 items, at the same lines, as an `rg` for item keywords; `impls DrawSink` gives the
three `impl DrawSink for …` blocks `rg` finds; `refs DrawSink` gives all 16 code occurrences `rg -w`
finds outside doc comments (the declaration excluded); `def` from an `impl DrawSink for` line and
from an `impl DrawSink` parameter both land on `glifo/src/interface.rs:15:11`; `callers` of
`replay_atlas_commands` gives its two callers. First rust-analyzer answer: 4.5 s after a 0.8 s
daemon start.

Standard library (2026-10-14, `code-nav install rust-src` run once with
`CARGO_HOME=data/cargo-home`, so the std dependencies sit next to vello's crates). Before: the
first miss, `def vello_encoding/src/resolve.rs:137 info_size` (a call on the closure argument of
`draw_tags.iter().map(|tag| tag.info_size())`), is `not found` with the offer note; `def` of `new`
in `Vec::new()` (`vello/src/wgpu_engine.rs:158`) and of that `iter` are `not found` with no
server location. After: `info_size` lands on `vello_encoding/src/draw.rs:48:18`, `refs` of it gives
both call sites, and `Vec::new` / `iter` answer `not found … inside the root (the server answered
<cache>/rust-src/1.90.0/…/library/alloc/src/vec/mod.rs` / `…/core/src/slice/mod.rs)`; the sysroot
warning is gone from the health message and no note is printed. On the fixture crate the std
dependencies alone (Homebrew's partial source, `CARGO_HOME=data/cargo-home`) already resolve the
`iter().map` call; the installed source alone (empty `CARGO_HOME`) does not.

### `install rust-src`

`code-nav install rust-src` (`src/tool/install.ts`) runs in the CLI process only — no daemon,
`--root` ignored — and is the one network command of the tool; nothing runs it implicitly.

- Cache: `CODE_NAV_CACHE` if set, else `$XDG_CACHE_HOME/code-nav`, else `~/.cache/code-nav` — a
  per-user directory outside every tree. Tests set `CODE_NAV_CACHE` (and `CODE_NAV_RUST_SRC=""`)
  so neither the real cache nor a real install changes their answers.
- Version: `rustc --version` (`RUSTC` honoured); a pre-release (`-nightly`, `-beta.N`) is refused.
- Download: `<dist>/rust-src-<version>.tar.xz` and its `.sha256` from the Rust distribution server,
  `<dist>` = `CODE_NAV_RUST_DIST` (tests: a `file://` URL), default
  `https://static.rust-lang.org/dist`. The hash is computed while streaming into
  `<cache>/rust-src/.partial-<pid>/`; a mismatch exits 3 with `error: sha256 mismatch …` and the
  partial dir (download included) is deleted.
- Extract: the system `tar -xf` into the partial dir; the component's top directory
  `rust-src-<version>/` (layout `rust-src/lib/rustlib/src/rust/library/` with the library workspace
  `Cargo.toml` and `Cargo.lock`) is renamed to `<cache>/rust-src/<version>/`. The rename is the
  commit point: a failure or SIGINT/SIGTERM leaves no version dir, and partial dirs of dead PIDs
  are removed by the next install. 1.90.0: 41 MB installed.
- An existing version dir is reported (`rust-src <version> already installed at <dir>`) and not
  touched; one without the library `Cargo.toml` is an error asking to remove it.
- Std dependencies: `cargo fetch --locked --manifest-path <library>/Cargo.toml` with
  `RUSTC_BOOTSTRAP=1` (the manifest uses `cargo-features`) into the CARGO_HOME in effect — the
  output names it and whether it came from `CARGO_HOME`. When the source was already installed, a
  `cargo metadata --offline --locked` first checks whether that CARGO_HOME already has them and
  skips the fetch if so; the dependencies are per CARGO_HOME, so rerun the command with each
  CARGO_HOME you use. A failed fetch is reported (`std dependencies: fetch failed (…); the source
  install stands, but std internals may stay unresolved`) and the command still exits 0.
- Output: the rustc line, the cache, the download with its size and verified sha256, the install
  dir and its size, the dependency step, and the `cargo.sysrootSrc` path rust-analyzer gets from its
  next start. Exit 0, or 3 with `error: …`; any other target exits 3 with
  `error: usage: code-nav install rust-src`.

### WGSL demo

The same vello checkout (§Rust demo) holds 33 shaders under `vello_shaders/shader/` that use the
`#import`/`#ifdef` preprocessor. Results (2026-10-14, grammar commit `d9306a7`, tree-sitter-wgsl-bevy),
compared with an `rg` for lines starting `fn struct var const override alias` (name and line must
match the outline's):

- `outline vello_shaders/shader/fine.wgsl`: all 66 declarations listed at the right lines, 1 extra —
  including the consts and `var`s inside the `#ifdef msaa`/`msaa8`/`msaa16` blocks (55–73, each
  branch's `MASK_WIDTH` etc. once per branch) and the fns after `fill_path_ms`, whose
  `#ifdef` lines inside the body no longer stretch it (`146-500 fn fill_path_ms`). Extra: `1387 var i`,
  a `for (var i …)` in `main` that recovery after a `switch tag {` the grammar does not know put at
  the top level; the same recovery ends `main` at 1380 instead of 1398 and `pixel_format` at 843
  instead of 848.
- Over all 33 shaders: 487 declarations, 468 found, 19 lost, 5 extra. Lost: 17 in
  `shared/blend.wgsl` (the 14 `COMPOSE_*` consts and the fns `blend_compose`, `unpremultiply`,
  `blend_mix_compose` — recovery from `blend_mix`'s `switch mode {` without parentheses swallows
  lines 149–318) and 2 in `draw_leaf.wgsl` (`two_point_to_unit_line`, `from_poly2`, after `main`'s
  `switch tag_word {`). Extra: function-local `var`s (fine.wgsl 1, flatten.wgsl 4: `arc0`, `arc1`,
  `other0`, `other1` in a `switch` case). Every loss comes from WGSL syntax the grammar lacks, none
  from preprocessor lines.
- `find --lang wgsl path tiling` ranks `path_tiling.wgsl` and `path_tiling_setup.wgsl` first;
  `def vello_shaders/shader/fine.wgsl:1112:20` →
  `error: no language server for wgsl: vello_shaders/shader/fine.wgsl is WGSL, …`.

### Plug-in points for later commands

`src/tool/lsp/answer.ts`: `lspReferences(ctx, position)` (references inside the root, sorted, with
the wait line), `enclosingSymbol(index, path, line, column)` (index symbol at or around a
location), `groupedLines`, `LineTexts`, `ask(ctx, position, client => …)` for any other request.
`parsePosition(ctx, usage)` turns the command's arguments into a position.
`src/tool/graphql/`: `takeSchemaOption(args)`, `locateRootSchema(ctx, option)`, `schemaOf(root,
file)`, `parseDocuments(ctx, schema)`, `selectionAt`, `selectionsOf`, `operationsUsing`.
