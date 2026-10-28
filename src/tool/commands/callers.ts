import type { SyntaxIndex } from "../index/index.ts";
import type { IncomingCall, Location, LspClient } from "../lsp/client.ts";
import { ask, enclosingSymbol, insideRootSorted, requireServerLanguage } from "../lsp/answer.ts";
import { symbolKindName } from "../lsp/symbol-kind.ts";
import { failure, notFound, prefixed, success } from "../output.ts";
import type { Command } from "./context.ts";
import { POSITION_FORMS, describePosition, lspPosition, parsePosition } from "./position.ts";

export const MAX_DEPTH = 10;
const USAGE = `usage: code-nav callers [--depth <1-${MAX_DEPTH}>] ${POSITION_FORMS}`;

interface Caller {
  location: Location;
  kind: string;
  name: string;
}

function parseDepth(args: string[]): number {
  const at = args.findIndex((a) => a === "--depth" || a.startsWith("--depth="));
  if (at < 0) return 1;
  const arg = args[at]!;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[at + 1];
  args.splice(at, arg.includes("=") ? 1 : 2);
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_DEPTH) {
    throw new Error(`--depth needs a number from 1 to ${MAX_DEPTH}`);
  }
  return Number(value);
}

function callersOf(index: SyntaxIndex, calls: IncomingCall[]): Caller[] {
  const byKey = new Map<string, Caller>();
  const add = (caller: Caller): void => {
    const key = `${caller.location.path}:${caller.location.line}:${caller.location.column}`;
    if (!byKey.has(key)) byKey.set(key, caller);
  };
  for (const call of calls) {
    const from = enclosingSymbol(index, call.location.path, call.location.line, call.location.column);
    const fallback: Caller = {
      location: call.location,
      kind: from?.kind ?? symbolKindName(call.kind),
      name: from?.name ?? call.name.split("(")[0]!.trim(),
    };
    if (from === null) {
      add(fallback);
      continue;
    }
    let ownSite = call.callSites.length === 0;
    for (const site of call.callSites) {
      const inner = enclosingSymbol(index, site.path, site.line, site.column);
      if (inner === null || inner === from || inner.start < from.start || inner.end > from.end) {
        ownSite = true;
        continue;
      }
      add({
        location: { ...site, startLine: inner.start, endLine: inner.end, line: inner.nameLine, column: inner.nameColumn },
        kind: inner.kind,
        name: inner.name,
      });
    }
    if (ownSite) add(fallback);
  }
  const located = new Map([...byKey.values()].map((c) => [`${c.location.path}:${c.location.line}:${c.location.column}`, c]));
  return insideRootSorted([...byKey.values()].map((c) => c.location)).map((l) => located.get(`${l.path}:${l.line}:${l.column}`)!);
}

async function tree(index: SyntaxIndex, client: LspClient, callers: Caller[], depth: number, level: number, expanded: Set<string>): Promise<string[]> {
  const lines: string[] = [];
  for (const caller of callers) {
    const { path, line, column } = caller.location;
    const key = `${path}:${line}:${column}`;
    const repeated = expanded.has(key);
    lines.push(`${"  ".repeat(level)}${key} ${caller.kind} ${caller.name}${repeated ? " (callers above)" : ""}`);
    if (level + 1 >= depth || repeated) continue;
    expanded.add(key);
    const next = callersOf(index, await client.incomingCalls({ path, line, column }));
    lines.push(...(await tree(index, client, next, depth, level + 1, expanded)));
  }
  return lines;
}

export const callers: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    let depth: number;
    try {
      depth = parseDepth(ctx.args);
    } catch (e) {
      return failure(`${(e as Error).message}; ${USAGE}`);
    }
    const position = parsePosition(ctx, USAGE);
    if (position.file.language === "graphql") return failure(`callers needs a C# or TypeScript position; ${position.file.path} is GraphQL`);
    requireServerLanguage("callers", position);
    const { result: lines, waited } = await ask(ctx, position, async (client) => {
      const first = callersOf(ctx.index, await client.incomingCalls(lspPosition(position)));
      return tree(ctx.index, client, first, depth, 0, new Set());
    });
    if (lines.length === 0) return prefixed(waited, notFound(`callers of ${describePosition(position)}`));
    return success([...waited, ...lines]);
  },
};
