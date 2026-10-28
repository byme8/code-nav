# code-nav

A code-navigation command-line tool for coding agents: one warm daemon per working tree answers
file/symbol search, outlines and single-symbol reads from syntax trees, and references,
definitions, implementations and callers from language servers, for C#, TypeScript/TSX, GraphQL,
Rust and WGSL.

## Commands

- Typecheck: `bunx tsc --noEmit`
- Tests: `bun test`
- Navigation tool: `bun src/tool/build.ts <outdir>` builds `<outdir>/code-nav`; `bun src/tool/cli.ts [--root <dir>] find|outline|show|refs|def|impls|callers|trace|status|stop …` runs it from source — see `docs/navigation-tool.md`.
- Global install / update: `bun src/tool/install-global.ts [--bin-dir <dir>] [--claude-home <dir>]` (defaults `~/.local/bin`, `~/.claude`) builds `code-nav` into the bin dir by rename, writes the `code-nav` Claude Code skill from `prompts/navigation-tool-note.md`, adds `Bash(code-nav:*)` to `settings.json` and stops running daemons; re-run it after a change — see `docs/navigation-tool.md` §Global install.
- Rust std source: `bun src/tool/cli.ts install rust-src` (network, user-level: `~/.cache/code-nav`, `CODE_NAV_CACHE` overrides) installs the rust-src component for the installed rustc and fetches the library's crates into the CARGO_HOME in effect; rust-analyzer then gets it as `cargo.sysrootSrc` — see `docs/navigation-tool.md` §`install rust-src`.
- Rust demo: `bun src/demo/prepare.ts <dest under the OS temp dir>` (network, one-time) clones vello at the pinned commit and fetches its crates into `data/cargo-home`; run the tool there with `CARGO_HOME=data/cargo-home` — see `docs/navigation-tool.md` §Rust demo.
- WGSL grammar: `bun src/tool/grammars.ts` (network, one-time) fetches tree-sitter-wgsl-bevy at the pinned commit and compiles it with `clang` into `data/grammars/wgsl.dylib`; the tool's WGSL commands need it (`CODE_NAV_WGSL_GRAMMAR` overrides the path), and so does `test/tool-wgsl.test.ts` — see `docs/navigation-tool.md` §Build and run.

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
  warm-up behaviour, and how the tool launches and configures rust-analyzer.
