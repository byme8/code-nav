# code-nav

A code-navigation CLI for coding agents (and people). One warm daemon per working tree answers:

- **from syntax trees** (ast-grep): file and symbol search (`find`), file outlines (`outline`), single-symbol reads (`show`);
- **from language servers**: references (`refs`), definitions (`def`), implementations (`impls`), callers (`callers`);
- **GraphQL ↔ C# ↔ TypeScript**: `trace` follows a C# property through the GraphQL schema, documents, generated hooks and React components.

Languages: C#, TypeScript/TSX, Angular templates, GraphQL, CSS, SCSS, Rust, WGSL. Each language works on its own — install only what you need.

## Install

Requires [Bun](https://bun.sh) (tested with 1.4) and [ast-grep](https://ast-grep.github.io) on `PATH`.

```sh
bun add -g github:byme8/code-nav
code-nav install // or code-nav doctor
```

`bun add -g` links `code-nav` into Bun's global bin directory (`~/.bun/bin`, on Windows `%USERPROFILE%\.bun\bin`); make sure it is on `PATH`. There is no build step: the command runs the TypeScript source with Bun.

Update with the same `bun add -g github:byme8/code-nav`, then `code-nav stop` in trees with a running daemon (a daemon of an older version is restarted automatically on the next command).

## Check what works: `code-nav doctor`

`doctor` needs no daemon and no project. It prints one `ok` / `missing` line per dependency with an install hint, and one summary line per language:

```
ok ast-grep /opt/homebrew/bin/ast-grep (ast-grep 0.45.3)
ok csharp-ls /Users/me/.dotnet/tools/csharp-ls
ok dotnet /usr/local/share/dotnet/dotnet
C#: ready
ok typescript-language-server /opt/homebrew/bin/typescript-language-server
TypeScript: ready
…
CSS: ready
ok scss-grammar /Users/me/.bun/install/global/node_modules/code-nav/prebuilt/darwin/scss.dylib
SCSS: ready
…
ok angular-grammar /Users/me/.bun/install/global/node_modules/code-nav/prebuilt/darwin/angular.dylib
ok node /opt/homebrew/bin/node (24.11.0)
missing @angular/language-server: @angular/language-server not in /opt/homebrew/lib/node_modules; npm i -g @angular/language-server
Angular: syntax only (@angular/language-server missing)
```

`ready` — every command works; `syntax only` — `find` / `outline` / `show` work, language-server commands answer `error:`; `unavailable` — nothing for that language. Exit status is 1 only when ast-grep is missing.

## Dependencies per language

| Language | Syntax commands need | Language-server commands need |
|---|---|---|
| all | `ast-grep` | — |
| C# | — | `csharp-ls`, `dotnet` (and a restored solution: `dotnet restore`) |
| TypeScript / TSX | — | `typescript-language-server` + `typescript` (and `npm ci` in the project) |
| GraphQL | — | `trace` needs `typescript-language-server`; `refs` / `def` need nothing else |
| CSS | — | — (no language server; `refs` / `def` from syntax trees) |
| SCSS | the SCSS grammar (shipped, below) | — (no language server; `refs` / `def` from syntax trees) |
| Rust | — | `rust-analyzer`, `cargo`; std navigation needs `code-nav install rust-src` |
| WGSL | the WGSL grammar (shipped, below) | — (no language server) |
| Angular templates | the Angular grammar (shipped, below) | `@angular/language-server` + `node` (and `npm ci` in the project); without it `refs` / `def` fall back to syntax |

Install commands:

| Tool | macOS | Linux | Windows |
|---|---|---|---|
| ast-grep | `brew install ast-grep` | `cargo install ast-grep --locked` | `cargo install ast-grep --locked` or `scoop install ast-grep` (the native `ast-grep.exe`; the npm `.cmd` shim is not supported) |
| csharp-ls | `dotnet tool install -g csharp-ls` | same | same |
| typescript-language-server | `npm i -g typescript-language-server typescript` | same | same |
| rust-analyzer | `rustup component add rust-analyzer` or `brew install rust-analyzer` | `rustup component add rust-analyzer` | `rustup component add rust-analyzer` |
| Angular language server | `npm i -g @angular/language-server` (Node `^20.19 \|\| ^22.12 \|\| >=24`) | same | same |

The Angular server is found at `CODE_NAV_ANGULAR_LS`, else in `npm root -g`; it runs once per Angular project and takes about 1.5 GB of memory.

### Grammars (WGSL, SCSS, Angular)

WGSL, SCSS and Angular templates use tree-sitter grammars. Prebuilt libraries ship in the package's `prebuilt/` for macOS (universal arm64 + x86_64), Linux x64 / arm64 (glibc 2.17+) and Windows x64 / arm64, so nothing is compiled on install.

On another platform, or to rebuild from source (needs `git` and `clang` on `PATH`, network once):

```sh
code-nav install grammars
```

It writes the package's `data/grammars/`, which takes precedence over `prebuilt/`; `CODE_NAV_WGSL_GRAMMAR` / `CODE_NAV_SCSS_GRAMMAR` / `CODE_NAV_ANGULAR_GRAMMAR` point at a library elsewhere. Maintainers regenerate `prebuilt/` with `bun src/tool/grammars.ts --prebuilt` (clang for macOS, `zig` for Linux and Windows).

### Overrides

| Variable | Effect |
|---|---|
| `CODE_NAV_CSHARP_LS`, `CODE_NAV_TYPESCRIPT_LS`, `CODE_NAV_RUST_ANALYZER` | Path of the language-server executable |
| `CODE_NAV_ANGULAR_LS` | `@angular/language-server` package directory or its `index.js` |
| `CODE_NAV_WGSL_GRAMMAR`, `CODE_NAV_SCSS_GRAMMAR`, `CODE_NAV_ANGULAR_GRAMMAR` | Path of the compiled grammar |
| `CODE_NAV_ROOT` | Tree root (default: the nearest directory with `.git`, else the current directory) |
| `CODE_NAV_IDLE_MS` | Daemon idle timeout (default 30 min) |
| `CODE_NAV_CACHE` | Cache dir for `install rust-src` (default `~/.cache/code-nav`) |

## Use

Run commands anywhere inside a project; the first one starts the daemon for that tree (`daemon started in 2.1 s (2849 files indexed)`), later ones answer from memory. Paths are relative to the tree root; lines and columns are 1-based.

```sh
code-nav find price calculator               # ranked files for a description
code-nav find --target member --lang csharp exchange rate
code-nav outline src/Services/PriceCalculator.cs
code-nav show PriceCalculator.Compute         # one symbol's text
code-nav show src/Services/PriceCalculator.cs:42
code-nav refs src/Services/PriceCalculator.cs:42:17
code-nav def src/web/app/price-tag.tsx:12:9
code-nav impls IPriceCalculator
code-nav callers PriceCalculator.Compute
code-nav trace Invoice.TotalAmount            # C# property → schema → documents → hooks → components
code-nav status                               # daemon, index and language servers
code-nav stop
```

`outline` output:

```
src/backend/Shop.Services/Pricing/PriceCalculator.cs
5-28 class PriceCalculator
  7-7 field _rate
  9-12 constructor PriceCalculator
```

Exit status: 0 answer, 1 `not found: …`, 2 `ambiguous: …` (candidates follow), 3 `error: …`. A language server still loading makes the first answer wait; when the wait exceeds 1 s the first line says `waited <s> s for <server>`.

## Use from Claude Code

Give the agent the command and a short usage note: allow `Bash(code-nav:*)` in `~/.claude/settings.json` and add a skill whose body is [`prompts/navigation-tool-note.md`](prompts/navigation-tool-note.md). From a checkout, `bun src/tool/install-global.ts` does all of that at once (compiled binary into `~/.local/bin`, the `code-nav` skill into `~/.claude/skills/`, the permission into `settings.json`).

## Develop

```sh
bun install
bunx tsc --noEmit
bun test
bun src/tool/cli.ts <command> …               # run from source
bun src/tool/build.ts <outdir>                # compiled single binary
```

Design and behaviour in detail: [`docs/navigation-tool.md`](docs/navigation-tool.md), [`docs/language-servers.md`](docs/language-servers.md).
