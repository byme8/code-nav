import type { StyleReferenceKind } from "../index/css.ts";
import { escapeRegex } from "../index/declarations.ts";
import type { Located } from "../index/index.ts";
import { isStyleLanguage } from "../index/symbols.ts";
import { compareBytes, type CommandContext } from "./context.ts";
import { charBeforeIdentifier, declarationsNamed, fileLines, type ResolvedPosition } from "./position.ts";

export interface StyleTarget {
  kind: StyleReferenceKind;
  name: string;
}

const CLASS_SELECTOR = /^\.([\p{L}\p{N}_-]+)$/u;

export function styleTarget(ctx: CommandContext, position: ResolvedPosition): StyleTarget | null {
  const name = position.name;
  if (name === "") return null;
  if (name.startsWith("--")) return { kind: "custom-property", name };
  if (name.startsWith("$")) return { kind: "variable", name };
  if (name.startsWith("%")) return { kind: "placeholder", name };
  const selector = CLASS_SELECTOR.exec(name);
  if (selector !== null) return { kind: "class", name: selector[1]! };
  const lineText = fileLines(ctx.root, position.file.path)[position.line - 1] ?? "";
  if (charBeforeIdentifier(lineText, position.column, position.file.language) === ".") return { kind: "class", name };
  const kinds = new Set(declarationsNamed(ctx, name, null).filter((l) => isStyleLanguage(l.file.language)).map((l) => l.symbol.kind));
  for (const kind of ["mixin", "function", "keyframes"] as const) if (kinds.has(kind)) return { kind, name };
  return null;
}

function declaresClass(selector: string, name: string): boolean {
  return new RegExp(`\\.${escapeRegex(name)}(?![\\p{L}\\p{N}_-])`, "u").test(selector);
}

export function styleDeclarationsAt(ctx: CommandContext, position: ResolvedPosition, target: StyleTarget): Located[] {
  const found = styleDeclarations(ctx, target);
  const at = found.filter(
    ({ file, symbol }) => file.path === position.file.path && symbol.nameLine === position.line && symbol.nameColumn <= position.column,
  );
  return at.length === 1 ? at : found;
}

export function styleDeclarations(ctx: CommandContext, target: StyleTarget): Located[] {
  const found: Located[] = [];
  for (const file of ctx.index.filesOf(new Set(["css", "scss"]))) {
    for (const symbol of file.symbols) {
      const match =
        target.kind === "class" ? symbol.kind === "rule" && declaresClass(symbol.name, target.name) : symbol.kind === target.kind && symbol.name === target.name;
      if (match) found.push({ file, symbol });
    }
  }
  return found.sort(
    (a, b) => compareBytes(a.file.path, b.file.path) || a.symbol.nameLine - b.symbol.nameLine || a.symbol.nameColumn - b.symbol.nameColumn,
  );
}

export function styleLabel(target: StyleTarget): string {
  return target.kind === "class" ? `.${target.name}` : target.name;
}

export function styleCandidates(declarations: Located[]): string[] {
  return declarations.map(({ file, symbol }) => `${file.path}:${symbol.nameLine}:${symbol.nameColumn} ${symbol.kind} ${symbol.name}`);
}
