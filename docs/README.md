# Documentation

| Document | Covers |
|---|---|
| [navigation-tool.md](navigation-tool.md) | The `code-nav` tool: build, root and state dir, the per-tree daemon's lifecycle (start-up line, restart detection, idle and `stop`), the freshness scan and its measured cost, the syntax index (C#, TypeScript, GraphQL and Rust), the Rust demo on vello, Angular templates (grammar, kinds, server discovery, routing, readiness, syntax fallbacks), and each command's input forms, output format, exit statuses and the `find` ranking with `--kind` |
| [language-servers.md](language-servers.md) | The stdio LSP client (typed API, UTF-16 to character-column conversion, process-group kill), how csharp-ls and typescript-language-server behave while warming up, how the tool launches and configures rust-analyzer, the Angular language server's launch command, readiness and limits (definition only in Angular context, pipe and `transform` references), and why CSS and SCSS have no server |
