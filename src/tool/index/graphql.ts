import { blockEnd, outlineDeclarations, type NumberedLine } from "./declarations.ts";
import { isContainerKind, type ToolSymbol } from "./symbols.ts";

export function parseGraphql(path: string, text: string): ToolSymbol[] {
  const lines: NumberedLine[] = text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t }));
  const out: ToolSymbol[] = [];
  let container: string | null = null;
  for (const d of outlineDeclarations("graphql", path, lines)) {
    const header = !(d.kind === "field" || d.kind === "enum-value");
    if (header) container = isContainerKind("graphql", d.kind) ? d.name : null;
    const window = header ? lines.slice(d.line - 1) : lines.slice(d.line - 1, d.line + 499);
    const end = blockEnd(window, !header) ?? d.line;
    out.push({
      kind: d.kind,
      name: d.name,
      start: d.line,
      end,
      nameLine: d.line,
      nameColumn: d.column,
      container: header ? null : container,
      depth: header ? 0 : container === null ? 0 : 1,
    });
  }
  return out;
}
