# code-nav — the navigation tool on your PATH

Run `code-nav <command> …` through Bash from the repository root. Paths are root-relative; lines
and columns are 1-based, columns in characters. The first command starts a background daemon and
prints `daemon started in <s> s (<n> files indexed)` first; a command that waits for a language
server may print `waited <s> s for <server>` first. Later commands are fast.

Commands (`<pos>` is `<path>:<line>:<col>`, or `<path>:<line> <name>`, or a bare `<name>` /
`<Owner.name>` looked up among declarations):

- `find [--target file|member] [--lang csharp|typescript|graphql|rust|wgsl|css|scss] [--kind K] <words…>`
  — symbol search by declared names, never file contents. `--target file` (default) ranks files by
  their path and their top-level types/declarations: `<path>  <score>  <matched terms>`. Use
  `--target member` when looking for a method, property, field or nested type:
  `<path>:<line>:<col> <kind> <Owner.name>  <score>  <terms>`. Prints the top 10, then
  `… <N> more`. Tests, EF migrations and generated files score half; when you are looking for one
  of those, pass `--kind tests|migrations|generated` (repeatable or comma-separated).
- `outline <path>` — the path, then `<start>-<end> <kind> <name>` per symbol in source order,
  members indented under their type; `start` is the name's line.
- `show <path> <name> [<line>]`, `show <path>:<line>`, `show <name>` — one symbol:
  `<path>:<start>-<end> <kind> <name>`, then its lines verbatim (the whole declaration).
- `refs <pos>` — every reference, per file a `<path>` line then `  <line>:<col>  <text>`.
- `def <pos>` — the definition, `<path>:<line>:<col>  <text>`; overloads resolved.
- `impls <pos>` — implementing types or overriding members, `<path>:<line>:<col> <kind> <name>`.
- `callers <pos>` — direct callers, `<path>:<line>:<col> <kind> <name>` (the calling method).
- `trace <pos>` — from a C# property or field through GraphQL to React:
  `<role> <path>:<line>:<col>  <text>` per link, roles in order csharp-property, schema-field,
  document-selection, generated-ts-member, service-hook, component.

C# and TypeScript `refs`/`def`/`impls`/`callers` come from csharp-ls and
typescript-language-server, Rust's from rust-analyzer; GraphQL `refs`/`def` from the schema and
documents; `find`, `outline` and `show` from syntax trees. WGSL has only `find`/`outline`/`show`
and answers `error:` for the rest. CSS and SCSS outline rules (named by their selector), custom
properties, `$variables`, mixins, functions, `%placeholders` and keyframes; their `refs`/`def` come
from vscode-css-language-server and stay inside the position's own file (the answer says so), so
search other files with `rg`; `impls`/`callers` answer `error:`. Rust standard-library items resolve only after
`code-nav install rust-src` (one-time download into the user cache). The tool answers from the
current files on every call.

Exit status: 0 answer; 1 `not found: …`; 2 `ambiguous: …` followed by one candidate per line
(pick one and call again with its position); 3 `error: …` (for example a language server that is
not available). Output is never truncated: prefer one precise command over broad ones.
