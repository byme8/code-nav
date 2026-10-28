# code-nav — the navigation tool on your PATH

Run `code-nav <command> …` through Bash from the repository root. Paths are root-relative; lines
and columns are 1-based, columns in characters. The first command starts a background daemon and
prints `daemon started in <s> s (<n> files indexed)` first. Language servers start on the first
command that needs them, so the first `refs`/`def`/`impls`/`callers` per language may print
`waited <s> s for <server>` first. Later commands are fast.

Commands (`<pos>` is `<path>:<line>:<col>`, or `<path>:<line> <name>`, or a bare `<name>` /
`<Owner.name>` looked up among declarations):

- `find [--target file|member|symbol] [--lang csharp|typescript|graphql|rust|wgsl|css|scss|angular] [--kind K] <words…>`
  — symbol search by declared names, never file contents. Words may be plain (`listing details`) or
  an exact identifier (`ListingDetailsComponent`); a unit declaring that exact name ranks first.
  `--target file` (default) ranks files by their path and their top-level types/declarations:
  `<path>  <score>  <matched terms>`. `--target symbol` ranks every declaration (top-level classes,
  functions and constants as well as members) and is the quickest way from a name to its position:
  `<path>:<line>:<col> <kind> <Owner.name>  <score>  <terms>`. `--target member` is the same but only
  methods, properties, fields and nested types. Prints the top 10, then
  `… <N> more`. Tests, EF migrations and generated files score half; when you are looking for one
  of those, pass `--kind tests|migrations|generated` (repeatable or comma-separated).
- `outline <path>` — the path, then `<start>-<end> <kind> <name>` per symbol in source order,
  members indented under their type; `start` is the name's line.
- `show <path> <name> [<line>]`, `show <path> <Owner.name>`, `show <path>:<line>`, `show <name>`,
  `show <Owner.name>` — one symbol: `<path>:<start>-<end> <kind> <name>`, then its lines verbatim
  (the whole declaration). Read a declaration with `show` instead of reading the file.
  `show <path>:<from>-<to>` prints just those lines (`<path>:<from>-<to>`, then the lines) — use
  it for a class header or a call site instead of showing the whole enclosing declaration.
- `refs <pos>` — every reference, per file a `<path>` line then `  <line>:<col>  <text>`; the
  declaration itself is not listed (use `def` or `find --target symbol` for it).
- `def <pos>` — the definition, `<path>:<line>:<col>  <text>`; overloads resolved. With a column,
  point it at the identifier itself (in CSS/SCSS anywhere inside `var(--x)` also works).
- `impls <pos>` — implementing types or overriding members, `<path>:<line>:<col> <kind> <name>`.
- `callers [--depth N] <pos>` — direct callers, `<path>:<line>:<col> <kind> <name>` (the calling
  method, or the field whose initializer makes the call). `--depth N` (1–10) also lists the
  callers' callers up to N levels, each level indented two spaces — one call for a whole chain; a
  caller already expanded earlier ends with ` (callers above)`.
- `trace <pos>` — from a C# property or field through GraphQL to React:
  `<role> <path>:<line>:<col>  <text>` per link, roles in order csharp-property, schema-field,
  document-selection, generated-ts-member, service-hook, component.

C# and TypeScript `refs`/`def`/`impls`/`callers` come from csharp-ls and
typescript-language-server, Rust's from rust-analyzer; GraphQL `refs`/`def` from the schema and
documents; `find`, `outline` and `show` from syntax trees. WGSL has only `find`/`outline`/`show`
and answers `error:` for the rest. CSS and SCSS outline rules (named by their selector), custom
properties, `$variables`, mixins, functions, `%placeholders` and keyframes; their `refs`/`def` come
from syntax trees across all CSS and SCSS files, matched by name (class-name `refs` list every
selector and use of the class), and `impls`/`callers` answer `error:`. Angular templates (`.html` in a
project depending on `@angular/core`, and inline `template:` strings) outline custom elements, `@if`/
`@for`/`@switch`/`@defer` blocks, `@let`, `#refs` and element bindings; `refs`/`def` from a template or
a component `.ts` go to the Angular language server, so references include template usages
(`<app-x>` tags, `{{ prop() }}`, `| pipeName`). For a pipe ask `refs` on the pipe class or a
`| name` usage. Without the server, template `refs`/`def` fall back to syntax with a `note:`. Rust standard-library items resolve only after
`code-nav install rust-src` (one-time download into the user cache). The tool answers from the
current files on every call.

Exit status: 0 answer; 1 `not found: …`; 2 `ambiguous: …` followed by one candidate per line
(pick one and call again with its position); 3 `error: …` (for example a language server that is
not available; `code-nav doctor` shows which languages this machine can serve). Output is never truncated: prefer one precise command over broad ones.

code-nav searches declared names only. For text that is not a declared name — a CSS value or
function such as `gradient(`, a color literal, a header or storage-key string, a route path, an
event name — use `rg` scoped to a directory, then `show`/`def` on what it finds. Several
code-nav commands can run in one Bash call (`code-nav outline a.ts; code-nav show a.ts Foo.bar`).
