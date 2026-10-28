import type { SyntaxIndex } from "../index/index.ts";
import type { Location } from "./client.ts";
import type { LspClient } from "./client.ts";
import type { ToolSymbol } from "../index/symbols.ts";
import { ToolError, failure } from "../output.ts";
import { compareBytes, type CommandContext } from "../commands/context.ts";
import { fileLines, type ResolvedPosition } from "../commands/position.ts";
import type { Acquired, ServerLanguage, ServerPool } from "./pool.ts";

const REPORTED_WAIT_MS = 1_000;

export function serversOf(ctx: CommandContext): ServerPool {
  if (ctx.servers === undefined) throw new ToolError(failure("language servers run only inside the daemon"));
  return ctx.servers;
}

export function requireServerLanguage(command: string, position: ResolvedPosition): ServerLanguage {
  const language = position.file.language;
  if (language === "csharp" || language === "typescript" || language === "rust") return language;
  if (language === "wgsl") {
    throw new ToolError(failure(`no language server for wgsl: ${position.file.path} is WGSL, which has syntax commands only (find, outline, show)`));
  }
  throw new ToolError(failure(`${command} needs a C# or TypeScript position; ${position.file.path} is GraphQL`));
}

export async function ask<T>(
  ctx: CommandContext,
  position: ResolvedPosition,
  request: (client: LspClient) => Promise<T>,
): Promise<{ result: T; waited: string[] }> {
  const language = requireServerLanguage("this command", position);
  const { result, acquired } = await serversOf(ctx).run(language, position.file.path, request);
  if (acquired.stdProblem !== null) ctx.stdProblem = acquired.stdProblem;
  return { result, waited: waitedLines(acquired) };
}

export function waitedLines(acquired: Acquired): string[] {
  return acquired.waitedMs > REPORTED_WAIT_MS ? [`waited ${(acquired.waitedMs / 1000).toFixed(1)} s for ${acquired.name}`] : [];
}

export class LineTexts {
  private readonly files = new Map<string, string[]>();

  constructor(private readonly root: string) {}

  text(path: string, line: number): string {
    let lines = this.files.get(path);
    if (lines === undefined) {
      try {
        lines = fileLines(this.root, path);
      } catch {
        lines = [];
      }
      this.files.set(path, lines);
    }
    return (lines[line - 1] ?? "").trim();
  }
}

export function insideRootSorted(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const l of locations) {
    if (!l.insideRoot) continue;
    const key = `${l.path}:${l.line}:${l.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out.sort((a, b) => compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column);
}

export async function lspReferences(ctx: CommandContext, position: ResolvedPosition): Promise<{ locations: Location[]; waited: string[] }> {
  const { result, waited } = await ask(ctx, position, (client) =>
    client.references({ path: position.file.path, line: position.line, column: position.column }, false),
  );
  return { locations: insideRootSorted(result), waited };
}

export function groupedLines(locations: { path: string; line: number; column: number }[], texts: LineTexts): string[] {
  const lines: string[] = [];
  let current: string | null = null;
  for (const l of locations) {
    if (l.path !== current) {
      lines.push(l.path);
      current = l.path;
    }
    lines.push(`  ${l.line}:${l.column}  ${texts.text(l.path, l.line)}`);
  }
  return lines;
}

export function symbolLines(
  index: SyntaxIndex,
  locations: { location: Location; fallbackKind: string; fallbackName: string }[],
): string[] {
  return locations.map(({ location: l, fallbackKind, fallbackName }) => {
    const symbol = enclosingSymbol(index, l.path, l.line, l.column);
    return `${l.path}:${l.line}:${l.column} ${symbol?.kind ?? fallbackKind} ${symbol?.name ?? fallbackName}`;
  });
}

export function enclosingSymbol(index: SyntaxIndex, path: string, line: number, column: number): ToolSymbol | null {
  const symbols = index.files.get(path)?.symbols ?? [];
  const named = symbols.find((s) => s.nameLine === line && s.nameColumn === column);
  if (named !== undefined) return named;
  let best: ToolSymbol | null = null;
  for (const s of symbols) {
    if (s.start > line || s.end < line) continue;
    if (best === null || s.end - s.start < best.end - best.start) best = s;
  }
  return best;
}
