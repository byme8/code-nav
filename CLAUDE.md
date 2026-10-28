# code-nav

A code-navigation command-line tool for coding agents: one warm daemon per working tree answers
file/symbol search, outlines and single-symbol reads from syntax trees, and references,
definitions, implementations and callers from language servers, for C#, TypeScript/TSX, Angular
templates, GraphQL, Rust, WGSL, CSS and SCSS.

## Commands

- Typecheck: `bunx tsc --noEmit`
- Tests: `bun test`
- Navigation tool: `bun src/tool/build.ts <outdir>` builds `<outdir>/code-nav`; `bun src/tool/cli.ts [--root <dir>] find|outline|show|refs|def|impls|callers|trace|status|stop …` runs it from source — see `docs/navigation-tool.md`.
- Global install / update: `bun src/tool/install-global.ts [--bin-dir <dir>] [--claude-home <dir>]` (defaults `~/.local/bin`, `~/.claude`) builds `code-nav` into the bin dir by rename, writes the `code-nav` Claude Code skill from `prompts/navigation-tool-note.md`, adds `Bash(code-nav:*)` to `settings.json` and stops running daemons; re-run it after a change — see `docs/navigation-tool.md` §Global install.
- Doctor: `bun src/tool/cli.ts doctor` (no daemon, no tree) prints `ok`/`missing` per dependency (ast-grep, then per language: language servers, `dotnet`, `cargo`, rust-src, grammars) with install hints and a `<language>: ready | syntax only | unavailable` line each; exit 1 only without a usable ast-grep — see `docs/navigation-tool.md` §`doctor`.
- Rust std source: `bun src/tool/cli.ts install rust-src` (network, user-level: `~/.cache/code-nav`, `CODE_NAV_CACHE` overrides) installs the rust-src component for the installed rustc and fetches the library's crates into the CARGO_HOME in effect; rust-analyzer then gets it as `cargo.sysrootSrc` — see `docs/navigation-tool.md` §`install rust-src`.
- Rust demo: `bun src/demo/prepare.ts <dest under the OS temp dir>` (network, one-time) clones vello at the pinned commit and fetches its crates into `data/cargo-home`; run the tool there with `CARGO_HOME=data/cargo-home` — see `docs/navigation-tool.md` §Rust demo.
- WGSL, SCSS and Angular grammars: `bun src/tool/grammars.ts` (network, one-time) fetches tree-sitter-wgsl-bevy, tree-sitter-scss and tree-sitter-angular at their pinned commits and compiles them with `clang` into `data/grammars/wgsl.dylib`, `scss.dylib` and `angular.dylib`; the tool's WGSL, SCSS and Angular template syntax commands need them (`CODE_NAV_WGSL_GRAMMAR` / `CODE_NAV_SCSS_GRAMMAR` / `CODE_NAV_ANGULAR_GRAMMAR` override the paths), and `test/tool-wgsl.test.ts` needs the WGSL one — see `docs/navigation-tool.md` §Build and run. CSS uses ast-grep's built-in grammar; CSS and SCSS have no language server — `refs`/`def` come from the syntax index.
- Angular language server: `npm i -g @angular/language-server` (or `CODE_NAV_ANGULAR_LS=<package dir or index.js>`), run with `node`; one per TypeScript root resolving `@angular/core`, about 1.5 GB each — see `docs/navigation-tool.md` §Angular.

Everything is TypeScript run with `bun`; no shell script files, and no dependencies beyond
`typescript` and `@types/bun`.

## Layout

- `src/tool/` — the tool; `src/demo/` — the Rust demo preparation; `test/` — tests.
- `data/` — ignored; Cargo home and compiled grammars.
- Build logs and throwaway files go to the OS temp directory, never inside this repository.

## Docs

- `docs/README.md` — index of the documentation.
- `docs/navigation-tool.md` — the `code-nav` tool: daemon per working tree, state dir, freshness
  scan, syntax index, language-server pool (start, readiness, freshness, unavailable servers),
  commands with their input forms, output formats, exit statuses and `find` ranking.
- `docs/language-servers.md` — the LSP client library, csharp-ls and typescript-language-server
  warm-up behaviour, how the tool launches and configures rust-analyzer, the Angular language
  server (launch, readiness, limits), and why CSS and SCSS have no server.
