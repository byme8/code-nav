import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_KINDS } from "../index/angular.ts";
import type { Located } from "../index/index.ts";
import type { Position } from "../lsp/client.ts";
import { isStyleLanguage, type IndexedFile, type ToolLanguage } from "../index/symbols.ts";
import { ToolError, ambiguous, failure, notFound } from "../output.ts";
import { compareBytes, indexedFile, looksLikePath, type CommandContext } from "./context.ts";

export interface ResolvedPosition {
  file: IndexedFile;
  line: number;
  column: number;
  name: string;
}

export const POSITION_FORMS = "<path>:<line>:<col> | <path>:<line> <name> | <name> | <Owner.name>";

const IDENTIFIER_CHARS = "\\p{L}\\p{N}_$";
const STYLE_IDENTIFIER_CHARS = "\\p{L}\\p{N}_$%\\-";
const TEMPLATE_IDENTIFIER_CHARS = "\\p{L}\\p{N}_$\\-";

function identifierChars(language: ToolLanguage | null): string {
  if (language === "angular") return TEMPLATE_IDENTIFIER_CHARS;
  return language !== null && isStyleLanguage(language) ? STYLE_IDENTIFIER_CHARS : IDENTIFIER_CHARS;
}

export function isTemplateSymbol({ file, symbol }: Located): boolean {
  return (file.language === "angular" || file.language === "typescript") && TEMPLATE_KINDS.has(symbol.kind);
}

export function fileLines(root: string, path: string): string[] {
  return readFileSync(join(root, path), "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierSpan(lineText: string, column: number, language: ToolLanguage | null): { chars: string[]; from: number; to: number } {
  const identifier = new RegExp(`[${identifierChars(language)}]`, "u");
  const chars = Array.from(lineText);
  let from = column - 1;
  let to = column - 1;
  while (from > 0 && identifier.test(chars[from - 1]!)) from--;
  while (to < chars.length && identifier.test(chars[to]!)) to++;
  return { chars, from, to };
}

export function identifierAt(lineText: string, column: number, language: ToolLanguage | null = null): string {
  const { chars, from, to } = identifierSpan(lineText, column, language);
  return chars.slice(from, to).join("");
}

export function charBeforeIdentifier(lineText: string, column: number, language: ToolLanguage | null): string {
  const { chars, from } = identifierSpan(lineText, column, language);
  return chars[from - 1] ?? "";
}

function parseNumber(text: string, what: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new ToolError(failure(`not a ${what}: ${text}`));
  return Number(text);
}

function lineOf(ctx: CommandContext, file: IndexedFile, line: number): string {
  const lines = fileLines(ctx.root, file.path);
  if (line > lines.length) throw new ToolError(notFound(`line ${line} in ${file.path} (${lines.length} lines)`));
  return lines[line - 1]!;
}

export function declarationsNamed(ctx: CommandContext, name: string, owner: string | null): Located[] {
  const found = ctx.index.symbolsNamed(name, owner).filter((l) => !isTemplateSymbol(l));
  const types = new Set(found.filter((l) => l.symbol.kind !== "constructor").map((l) => `${l.file.path}\0${l.symbol.name}`));
  return found.filter((l) => !(l.symbol.kind === "constructor" && l.symbol.container === name && types.has(`${l.file.path}\0${name}`)));
}

export function styleDeclarationsNamed(ctx: CommandContext, input: string): Located[] | null {
  const found = ctx.index.symbolsNamed(input, null).filter((l) => isStyleLanguage(l.file.language));
  return found.length > 0 ? found : null;
}

function byDeclaration(ctx: CommandContext, input: string): ResolvedPosition {
  const parts = input.split(".");
  const name = parts.at(-1)!;
  const owner = parts.length > 1 ? parts.at(-2)! : null;
  const found = styleDeclarationsNamed(ctx, input) ?? declarationsNamed(ctx, name, owner);
  if (found.length === 0) throw new ToolError(notFound(`declaration of ${input}`));
  if (found.length > 1) {
    const sorted = [...found].sort(
      (a, b) => compareBytes(a.file.path, b.file.path) || a.symbol.nameLine - b.symbol.nameLine || a.symbol.nameColumn - b.symbol.nameColumn,
    );
    throw new ToolError(
      ambiguous(
        input,
        sorted.map(({ file, symbol }) => `${file.path}:${symbol.nameLine}:${symbol.nameColumn} ${symbol.kind} ${symbol.name}`),
      ),
    );
  }
  const { file, symbol } = found[0]!;
  return { file, line: symbol.nameLine, column: symbol.nameColumn, name: symbol.name };
}

export function parsePosition(ctx: CommandContext, usage: string): ResolvedPosition {
  const [first, second, ...rest] = ctx.args;
  if (first === undefined || rest.length > 0) throw new ToolError(failure(usage));
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(first);
  if (match !== null && looksLikePath(ctx.root, match[1]!)) {
    const file = indexedFile(ctx, match[1]!);
    const line = parseNumber(match[2]!, "line number");
    const text = lineOf(ctx, file, line);
    if (match[3] !== undefined) {
      if (second !== undefined) throw new ToolError(failure(usage));
      const column = parseNumber(match[3], "column");
      const width = Array.from(text).length;
      if (column > width + 1) throw new ToolError(notFound(`column ${column} on ${file.path}:${line} (${width} characters)`));
      return { file, line, column, name: identifierAt(text, column, file.language) };
    }
    if (second === undefined) throw new ToolError(failure(usage));
    const chars = identifierChars(file.language);
    const at = new RegExp(`(?<![${chars}])${escapeRegex(second)}(?![${chars}])`, "u").exec(text);
    if (at === null) throw new ToolError(notFound(`${second} on ${file.path}:${line}`));
    return { file, line, column: Array.from(text.slice(0, at.index)).length + 1, name: second };
  }
  if (second !== undefined || looksLikePath(ctx.root, first)) throw new ToolError(failure(usage));
  return byDeclaration(ctx, first);
}

export function lspPosition(position: ResolvedPosition): Position {
  return { path: position.file.path, line: position.line, column: position.column };
}

export function describePosition(position: ResolvedPosition): string {
  return `${position.name === "" ? "position" : position.name} at ${position.file.path}:${position.line}:${position.column}`;
}
