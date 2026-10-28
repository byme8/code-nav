import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Located } from "../index/index.ts";
import type { IndexedFile, ToolSymbol } from "../index/symbols.ts";
import { ToolError, ambiguous, failure, notFound, success, symbolHeader, type Reply } from "../output.ts";
import { compareBytes, indexedFile, looksLikePath, type Command, type CommandContext } from "./context.ts";
import { styleDeclarationsNamed } from "./position.ts";

const USAGE = "usage: code-nav show <path>:<line>[:<col>] [<name>] | <path> <name> [<line>] | <name> | <Owner.name>";

function parseLine(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new ToolError(failure(`not a line number: ${text}`));
  return Number(text);
}

function containing(file: IndexedFile, line: number, name: string | null): ToolSymbol | null {
  let best: ToolSymbol | null = null;
  for (const s of file.symbols) {
    if (s.start > line || s.end < line || (name !== null && s.name !== name)) continue;
    if (best === null || s.end - s.start < best.end - best.start) best = s;
  }
  return best;
}

function print(ctx: CommandContext, { file, symbol }: Located): Reply {
  const lines = readFileSync(join(ctx.root, file.path), "utf8").split("\n");
  const text = lines.slice(symbol.start - 1, symbol.end).map((l) => l.replace(/\r$/, ""));
  return success([symbolHeader(file.path, symbol.start, symbol.end, symbol.kind, symbol.name), ...text]);
}

function oneOf(ctx: CommandContext, what: string, found: Located[]): Reply {
  if (found.length === 0) return notFound(what);
  if (found.length === 1) return print(ctx, found[0]!);
  const sorted = [...found].sort((a, b) => compareBytes(a.file.path, b.file.path) || a.symbol.start - b.symbol.start);
  return ambiguous(
    what,
    sorted.map(({ file, symbol }) => symbolHeader(file.path, symbol.start, symbol.end, symbol.kind, symbol.name)),
  );
}

function atLine(ctx: CommandContext, file: IndexedFile, line: number, name: string | null): Reply {
  const symbol = containing(file, line, name);
  const what = name === null ? `symbol at ${file.path}:${line}` : `${name} at ${file.path}:${line}`;
  return symbol === null ? notFound(what) : print(ctx, { file, symbol });
}

export const show: Command = {
  needsFreshIndex: true,
  run(ctx) {
    const [first, second, third, ...rest] = ctx.args;
    if (first === undefined || rest.length > 0) return failure(USAGE);
    const position = /^(.+?):(\d+)(?::(\d+))?$/.exec(first);
    if (position !== null && looksLikePath(ctx.root, position[1]!)) {
      if (third !== undefined) return failure(USAGE);
      return atLine(ctx, indexedFile(ctx, position[1]!), parseLine(position[2]!), second ?? null);
    }
    if (looksLikePath(ctx.root, first)) {
      if (second === undefined) return failure(USAGE);
      const file = indexedFile(ctx, first);
      if (third !== undefined) return atLine(ctx, file, parseLine(third), second);
      return oneOf(
        ctx,
        `${second} in ${file.path}`,
        file.symbols.filter((s) => s.name === second).map((symbol) => ({ file, symbol })),
      );
    }
    if (second !== undefined) return failure(USAGE);
    const parts = first.split(".");
    return oneOf(ctx, first, styleDeclarationsNamed(ctx, first) ?? ctx.index.symbolsNamed(parts.at(-1)!, parts.at(-2) ?? null));
  },
};
