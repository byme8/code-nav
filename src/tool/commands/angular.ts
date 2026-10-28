import { angularConfigPath, angularLibraryPath, selectorElements, templateReferenceRuleText, type TemplateTargetKind } from "../index/angular.ts";
import { scanBatch, scanBatches } from "../index/astgrep.ts";
import type { Located } from "../index/index.ts";
import { referenceRules, ruleText } from "../index/rules.ts";
import type { IndexedFile, ToolSymbol } from "../index/symbols.ts";
import { LineTexts, ask, groupedLines, lspReferences } from "../lsp/answer.ts";
import { ServerUnavailable } from "../lsp/pool.ts";
import { ambiguous, notFound, prefixed, success, type Reply } from "../output.ts";
import { compareBytes, type CommandContext } from "./context.ts";
import { declarationsNamed, describePosition, fileLines, lspPosition, type ResolvedPosition } from "./position.ts";

type Spot = { path: string; line: number; column: number };

interface TemplateTarget {
  kind: Exclude<TemplateTargetKind, "identifier">;
  name: string;
}

export function usesAngular(ctx: CommandContext, position: ResolvedPosition): boolean {
  if (position.file.language === "angular") return true;
  if (position.file.language !== "typescript") return false;
  return inInlineTemplate(position) || (ctx.servers !== undefined && ctx.servers.hasAngular(position.file.path));
}

export function wantsAngularReferences(ctx: CommandContext, position: ResolvedPosition): boolean {
  return usesAngular(ctx, position) || (position.file.language === "typescript" && targetAt(ctx, position) !== null);
}

function inInlineTemplate(position: ResolvedPosition): boolean {
  return position.file.symbols.some((s) => s.kind === "template" && s.nameLine < position.line && position.line <= s.end);
}

function isTemplatePosition(position: ResolvedPosition): boolean {
  return position.file.language === "angular" || inInlineTemplate(position);
}

function prefixOf(ctx: CommandContext, position: ResolvedPosition): string {
  const text = Array.from(fileLines(ctx.root, position.file.path)[position.line - 1] ?? "");
  let from = position.column - 1;
  while (from > 0 && /[\p{L}\p{N}_$-]/u.test(text[from - 1]!)) from--;
  return text.slice(0, from).join("");
}

function classSymbol(file: IndexedFile, name: string) {
  return file.symbols.find((s) => s.kind === "class" && s.name === name) ?? null;
}

function targetAt(ctx: CommandContext, position: ResolvedPosition): TemplateTarget | null {
  const { file, name } = position;
  if (name === "") return null;
  if (isTemplatePosition(position)) {
    const before = prefixOf(ctx, position);
    if (/(?<!\|)\|\s*$/.test(before)) return { kind: "pipe", name };
    if (/<\/?$/.test(before)) return { kind: "element", name };
    return null;
  }
  for (const s of file.symbols) {
    if (s.kind !== "selector" && s.kind !== "pipe") continue;
    const onClass = s.container === name;
    const onTransform = s.kind === "pipe" && name === "transform" && classOwning(file, position) === s.container;
    if (!onName(s, position) && !onClass && !onTransform) continue;
    if (s.kind === "pipe") return { kind: "pipe", name: s.name };
    const tag = selectorElements(s.name)[0];
    if (tag !== undefined) return { kind: "element", name: tag };
  }
  return null;
}

function onName(symbol: ToolSymbol, position: ResolvedPosition): boolean {
  return symbol.nameLine === position.line && position.column >= symbol.nameColumn && position.column <= symbol.nameColumn + Array.from(symbol.name).length;
}

function samePlace(a: Spot, b: Spot | ResolvedPosition): boolean {
  const path = "file" in b ? b.file.path : b.path;
  return a.path === path && a.line === b.line && a.column === b.column;
}

function classOwning(file: IndexedFile, position: ResolvedPosition): string | null {
  const owner = file.symbols.find((s) => s.kind === "class" && s.start <= position.line && position.line <= s.end);
  return owner?.name ?? null;
}

function declarationsOf(ctx: CommandContext, target: TemplateTarget): Located[] {
  const found: Located[] = [];
  for (const file of ctx.index.filesOf(new Set(["typescript"]))) {
    for (const symbol of file.symbols) {
      const match = target.kind === "pipe" ? symbol.kind === "pipe" && symbol.name === target.name : symbol.kind === "selector" && selectorElements(symbol.name).includes(target.name);
      if (match) found.push({ file, symbol });
    }
  }
  return found.sort((a, b) => compareBytes(a.file.path, b.file.path) || a.symbol.nameLine - b.symbol.nameLine);
}

function classPosition(declaration: Located): ResolvedPosition | null {
  const owner = declaration.symbol.container === null ? null : classSymbol(declaration.file, declaration.symbol.container);
  return owner === null ? null : { file: declaration.file, line: owner.nameLine, column: owner.nameColumn, name: owner.name };
}

function templatePaths(ctx: CommandContext): string[] {
  return [
    ...ctx.index.filesOf(new Set(["angular"])).map((f) => f.path),
    ...ctx.index.filesOf(new Set(["typescript"])).filter((f) => f.symbols.some((s) => s.kind === "template")).map((f) => f.path),
  ];
}

async function templateScan(ctx: CommandContext, kind: TemplateTargetKind, name: string, notes: string[]): Promise<Spot[]> {
  const problem = ctx.index.grammarProblem("angular");
  if (problem !== null) {
    notes.push(`note: ${problem}; templates not scanned`);
    return [];
  }
  const rules = templateReferenceRuleText(kind, name);
  const config = angularConfigPath(angularLibraryPath());
  const out: Spot[] = [];
  for (const batch of scanBatches(templatePaths(ctx), rules)) {
    for (const [path, matches] of await scanBatch(ctx.root, batch, rules, config)) {
      for (const m of matches) out.push({ path, line: m.range.start.line + 1, column: m.charCount.leading + 1 });
    }
  }
  return out;
}

async function typescriptScan(ctx: CommandContext, declaration: Located, name: string): Promise<Spot[]> {
  const rules = ruleText(referenceRules("typescript", name));
  const out: Spot[] = [];
  for (const batch of scanBatches(ctx.index.filesOf(new Set(["typescript"])).map((f) => f.path), rules)) {
    for (const [path, matches] of await scanBatch(ctx.root, batch, rules)) {
      for (const m of matches) {
        const spot = { path, line: m.range.start.line + 1, column: m.charCount.leading + 1 };
        if (path === declaration.file.path && spot.line === declaration.symbol.nameLine && spot.column === declaration.symbol.nameColumn) continue;
        out.push(spot);
      }
    }
  }
  return out;
}

function sorted(spots: Spot[]): Spot[] {
  const seen = new Set<string>();
  return spots
    .filter((s) => {
      const key = `${s.path}:${s.line}:${s.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column);
}

function answer(ctx: CommandContext, position: ResolvedPosition, lines: string[], spots: Spot[]): Reply {
  if (spots.length === 0) return prefixed(lines, notFound(`references to ${describePosition(position)}`));
  return success([...lines, ...groupedLines(sorted(spots), new LineTexts(ctx.root))]);
}

function unavailableNote(e: ServerUnavailable, what: string): string {
  return `note: ${e.server} not available (${e.reason}); ${what}`;
}

async function serverReferences(
  ctx: CommandContext,
  position: ResolvedPosition,
  lines: string[],
  templates = "without template usages",
): Promise<Spot[] | ServerUnavailable> {
  const kinds = ["angular", "typescript"] as const;
  let first: ServerUnavailable | null = null;
  for (const kind of kinds) {
    try {
      const found = await lspReferences(ctx, position, kind);
      lines.push(...found.waited);
      if (first !== null) lines.push(unavailableNote(first, `references from typescript-language-server, ${templates}`));
      return found.locations;
    } catch (e) {
      if (!(e instanceof ServerUnavailable)) throw e;
      first ??= e;
    }
  }
  return first!;
}

async function pipeReferences(ctx: CommandContext, position: ResolvedPosition, target: TemplateTarget): Promise<Reply> {
  const declarations = declarationsOf(ctx, target);
  if (declarations.length > 1) return ambiguous(target.name, declarations.map(({ file, symbol }) => `${file.path}:${symbol.nameLine}:${symbol.nameColumn} pipe ${symbol.name}`));
  const lines: string[] = [];
  const spots: Spot[] = [];
  const pipeClass = declarations[0] === undefined ? null : classPosition(declarations[0]);
  if (pipeClass !== null) {
    const found = await serverReferences(ctx, pipeClass, lines, "template usages from syntax");
    if (found instanceof ServerUnavailable) {
      lines.push(unavailableNote(found, `syntax references of ${pipeClass.name}`));
      spots.push(...(await typescriptScan(ctx, { file: pipeClass.file, symbol: classSymbol(pipeClass.file, pipeClass.name)! }, pipeClass.name)));
    } else {
      spots.push(...found.filter((l) => !samePlace(l, pipeClass)));
    }
  }
  spots.push(...(await templateScan(ctx, "pipe", target.name, lines)));
  return answer(ctx, position, lines, spots);
}

async function syntaxTemplateReferences(ctx: CommandContext, position: ResolvedPosition, e: ServerUnavailable): Promise<Reply> {
  const lines: string[] = [];
  const target = targetAt(ctx, position);
  if (target !== null) {
    lines.push(unavailableNote(e, `syntax references of ${target.kind === "element" ? `<${target.name}>` : `| ${target.name}`}`));
    return answer(ctx, position, lines, await templateScan(ctx, target.kind, target.name, lines));
  }
  const declarations = declarationsNamed(ctx, position.name, null).filter((l) => l.file.language === "typescript");
  if (position.name === "" || declarations.length !== 1) return e.reply;
  lines.push(unavailableNote(e, "syntax references of a unique name"));
  const spots = [...(await typescriptScan(ctx, declarations[0]!, position.name)), ...(await templateScan(ctx, "identifier", position.name, lines))];
  return answer(ctx, position, lines, spots);
}

export async function angularReferences(ctx: CommandContext, position: ResolvedPosition): Promise<Reply> {
  const target = targetAt(ctx, position);
  if (target?.kind === "pipe") return pipeReferences(ctx, position, target);
  if (isTemplatePosition(position)) {
    try {
      const found = await lspReferences(ctx, position, "angular");
      const { result } = await ask(ctx, position, (client) => client.definition(lspPosition(position)), "angular");
      const declared = result.filter((l) => l.insideRoot);
      return answer(ctx, position, found.waited, found.locations.filter((l) => !declared.some((d) => samePlace(l, d))));
    } catch (e) {
      if (e instanceof ServerUnavailable) return syntaxTemplateReferences(ctx, position, e);
      throw e;
    }
  }
  const lines: string[] = [];
  const selector = position.file.symbols.find((s) => s.kind === "selector" && onName(s, position));
  const asked = selector?.container == null ? position : (classPosition({ file: position.file, symbol: selector }) ?? position);
  const found = await serverReferences(ctx, asked, lines, target?.kind === "element" ? "element usages from syntax" : undefined);
  if (found instanceof ServerUnavailable) throw found;
  const spots: Spot[] = found.filter((l) => !samePlace(l, asked));
  if (lines.some((l) => l.startsWith("note:")) && target?.kind === "element") spots.push(...(await templateScan(ctx, "element", target.name, lines)));
  return answer(ctx, position, lines, spots);
}

function definitionLine(ctx: CommandContext, spot: Spot): string {
  return `${spot.path}:${spot.line}:${spot.column}  ${new LineTexts(ctx.root).text(spot.path, spot.line)}`;
}

function syntaxDefinition(ctx: CommandContext, position: ResolvedPosition, notes: string[]): Reply {
  const target = targetAt(ctx, position);
  let candidates: ResolvedPosition[];
  if (target !== null) {
    candidates = declarationsOf(ctx, target).flatMap((d) => classPosition(d) ?? []);
  } else {
    candidates = declarationsNamed(ctx, position.name, null)
      .filter((l) => l.file.language === "typescript")
      .map(({ file, symbol }) => ({ file, line: symbol.nameLine, column: symbol.nameColumn, name: symbol.name }));
  }
  if (candidates.length === 0) return prefixed(notes, notFound(`definition of ${describePosition(position)}`));
  if (candidates.length > 1) {
    return prefixed(notes, ambiguous(position.name, candidates.map((c) => `${c.file.path}:${c.line}:${c.column} ${c.name}`)));
  }
  const only = candidates[0]!;
  return success([...notes, definitionLine(ctx, { path: only.file.path, line: only.line, column: only.column })]);
}

export async function angularDefinition(ctx: CommandContext, position: ResolvedPosition): Promise<Reply | null> {
  const template = isTemplatePosition(position);
  const notes: string[] = [];
  try {
    const { result, waited } = await ask(ctx, position, (client) => client.definition(lspPosition(position)), "angular");
    notes.push(...waited);
    const location = result.find((l) => l.insideRoot);
    if (location !== undefined) return success([...notes, definitionLine(ctx, location)]);
    if (!template) return null;
    notes.push("note: angular-language-server found no definition; syntax answer");
  } catch (e) {
    if (!(e instanceof ServerUnavailable)) throw e;
    if (!template) return null;
    notes.push(unavailableNote(e, "syntax answer"));
  }
  return syntaxDefinition(ctx, position, notes);
}
