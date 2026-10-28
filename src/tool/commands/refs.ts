import { scanBatch, scanBatches } from "../index/astgrep.ts";
import { styleReferenceRuleText, type StyleReferenceKind } from "../index/css.ts";
import type { Located } from "../index/index.ts";
import { referenceRules, ruleText } from "../index/rules.ts";
import { rustReferenceRuleText } from "../index/rust.ts";
import { scssConfigPath, scssLibraryPath } from "../index/scss.ts";
import { isStyleLanguage } from "../index/symbols.ts";
import { LineTexts, groupedLines, lspReferences, requireServerLanguage, styleScopeNote } from "../lsp/answer.ts";
import { ServerUnavailable } from "../lsp/pool.ts";
import { graphqlReferences } from "../graphql/answer.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import { notFound, prefixed, success, type Reply } from "../output.ts";
import { compareBytes, type Command, type CommandContext } from "./context.ts";
import { POSITION_FORMS, charBeforeIdentifier, declarationsNamed, describePosition, fileLines, parsePosition, type ResolvedPosition } from "./position.ts";

type Location = { path: string; line: number; column: number };

const USAGE = `usage: code-nav refs [--schema <path>] ${POSITION_FORMS}`;

interface Scan {
  rules: string;
  paths: string[];
  config: string | null;
}

async function scanLocations(ctx: CommandContext, scans: Scan[], declaration: Located | null): Promise<Location[]> {
  const locations: Location[] = [];
  for (const { rules, paths, config } of scans) {
    for (const batch of scanBatches(paths, rules)) {
      for (const [path, matches] of await scanBatch(ctx.root, batch, rules, config)) {
        for (const m of matches) {
          const line = m.range.start.line + 1;
          const column = m.charCount.leading + 1;
          if (path === declaration?.file.path && line === declaration.symbol.nameLine && column === declaration.symbol.nameColumn) continue;
          locations.push({ path, line, column });
        }
      }
    }
  }
  return locations.sort((a, b) => compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column);
}

function syntaxAnswer(ctx: CommandContext, position: ResolvedPosition, note: string, locations: Location[]): Reply {
  if (locations.length === 0) return prefixed([note], notFound(`references to ${describePosition(position)}`));
  return success([note, ...groupedLines(locations, new LineTexts(ctx.root))]);
}

function styleReferenceKind(ctx: CommandContext, position: ResolvedPosition): StyleReferenceKind | null {
  const name = position.name;
  if (name.startsWith("--")) return "custom-property";
  if (name.startsWith("$")) return "variable";
  if (name.startsWith("%")) return "placeholder";
  const lineText = fileLines(ctx.root, position.file.path)[position.line - 1] ?? "";
  if (charBeforeIdentifier(lineText, position.column, position.file.language) === ".") return "class";
  const kinds = new Set(declarationsNamed(ctx, name, null).filter((l) => isStyleLanguage(l.file.language)).map((l) => l.symbol.kind));
  for (const kind of ["mixin", "function", "keyframes"] as const) if (kinds.has(kind)) return kind;
  return null;
}

async function styleSyntaxReferences(ctx: CommandContext, position: ResolvedPosition, unavailable: ServerUnavailable): Promise<Reply> {
  const kind = position.name === "" ? null : styleReferenceKind(ctx, position);
  if (kind === null) return unavailable.reply;
  let declaration: Located | null = null;
  if (kind !== "class") {
    const declarations = declarationsNamed(ctx, position.name, null).filter(
      (l) => isStyleLanguage(l.file.language) && l.symbol.kind === kind,
    );
    if (declarations.length !== 1) return unavailable.reply;
    declaration = declarations[0]!;
  }
  const scans: Scan[] = [];
  if (kind === "custom-property" || kind === "keyframes" || kind === "class") {
    scans.push({ rules: styleReferenceRuleText("Css", kind, position.name), paths: ctx.index.filesOf(new Set(["css"])).map((f) => f.path), config: null });
  }
  if (ctx.index.grammarProblem("scss") === null) {
    scans.push({
      rules: styleReferenceRuleText("scss", kind, position.name),
      paths: ctx.index.filesOf(new Set(["scss"])).map((f) => f.path),
      config: scssConfigPath(scssLibraryPath()),
    });
  }
  const what = kind === "class" ? "a class name" : "a unique name";
  return syntaxAnswer(ctx, position, `note: ${unavailable.server} not available; syntax references of ${what}`, await scanLocations(ctx, scans, declaration));
}

function withoutStyleDeclarations<T extends Location>(ctx: CommandContext, name: string, locations: T[]): T[] {
  const declared = new Set(
    declarationsNamed(ctx, name, null)
      .filter((l) => isStyleLanguage(l.file.language))
      .map((l) => `${l.file.path}:${l.symbol.nameLine}:${l.symbol.nameColumn}`),
  );
  return locations.filter((l) => !declared.has(`${l.path}:${l.line}:${l.column}`));
}

async function syntaxReferences(ctx: CommandContext, position: ResolvedPosition, unavailable: ServerUnavailable): Promise<Reply> {
  const language = requireServerLanguage("refs", position);
  if (isStyleLanguage(language)) return styleSyntaxReferences(ctx, position, unavailable);
  const declarations = position.name === "" ? [] : declarationsNamed(ctx, position.name, null).filter((l) => l.file.language === language);
  if (declarations.length !== 1) return unavailable.reply;
  const rules = language === "rust" ? rustReferenceRuleText(position.name) : ruleText(referenceRules(language, position.name));
  const paths = ctx.index.filesOf(new Set([language])).map((f) => f.path);
  const locations = await scanLocations(ctx, [{ rules, paths, config: null }], declarations[0]!);
  return syntaxAnswer(ctx, position, `note: ${unavailable.server} not available; syntax references of a unique name`, locations);
}

export const refs: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const { schema, rest } = takeSchemaOption(ctx.args);
    const position = parsePosition({ ...ctx, args: rest }, USAGE);
    if (position.file.language === "graphql") {
      return graphqlReferences(ctx, position, schemaOf(ctx.root, locateRootSchema(ctx, schema)));
    }
    let found;
    try {
      found = await lspReferences(ctx, position);
    } catch (e) {
      if (e instanceof ServerUnavailable) return syntaxReferences(ctx, position, e);
      throw e;
    }
    if (isStyleLanguage(position.file.language)) found.locations = withoutStyleDeclarations(ctx, position.name, found.locations);
    const notes = [...found.waited, ...styleScopeNote(position, "references")];
    if (found.locations.length === 0) return prefixed(notes, notFound(`references to ${describePosition(position)}`));
    return success([...notes, ...groupedLines(found.locations, new LineTexts(ctx.root))]);
  },
};
