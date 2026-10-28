import { scanBatch, scanBatches } from "../index/astgrep.ts";
import { styleReferenceRuleText } from "../index/css.ts";
import type { Located } from "../index/index.ts";
import { referenceRules, ruleText } from "../index/rules.ts";
import { rustReferenceRuleText } from "../index/rust.ts";
import { scssConfigPath, scssLibraryPath } from "../index/scss.ts";
import { isStyleLanguage } from "../index/symbols.ts";
import { LineTexts, groupedLines, lspReferences, requireServerLanguage } from "../lsp/answer.ts";
import { ServerUnavailable } from "../lsp/pool.ts";
import { graphqlReferences } from "../graphql/answer.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import { ambiguous, notFound, prefixed, success, type Reply } from "../output.ts";
import { compareBytes, type Command, type CommandContext } from "./context.ts";
import { POSITION_FORMS, declarationsNamed, describePosition, parsePosition, type ResolvedPosition } from "./position.ts";
import { styleCandidates, styleDeclarationsAt, styleLabel, styleTarget } from "./style.ts";
import { angularReferences, wantsAngularReferences } from "./angular.ts";

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

async function styleReferences(ctx: CommandContext, position: ResolvedPosition): Promise<Reply> {
  const target = styleTarget(ctx, position);
  if (target === null) return notFound(`declaration of ${describePosition(position)}`);
  let declaration: Located | null = null;
  if (target.kind !== "class") {
    const declarations = styleDeclarationsAt(ctx, position, target);
    if (declarations.length === 0) return notFound(`declaration of ${describePosition(position)}`);
    if (declarations.length > 1) return ambiguous(target.name, styleCandidates(declarations));
    declaration = declarations[0]!;
  }
  const notes = target.kind === "class" ? [`note: textual matches of the class name ${styleLabel(target)}`] : [];
  const scans: Scan[] = [];
  if (target.kind === "custom-property" || target.kind === "keyframes" || target.kind === "class") {
    scans.push({ rules: styleReferenceRuleText("Css", target.kind, target.name), paths: ctx.index.filesOf(new Set(["css"])).map((f) => f.path), config: null });
  }
  const scssFiles = ctx.index.filesOf(new Set(["scss"])).map((f) => f.path);
  const scssProblem = ctx.index.grammarProblem("scss");
  if (scssProblem === null) {
    scans.push({ rules: styleReferenceRuleText("scss", target.kind, target.name), paths: scssFiles, config: scssConfigPath(scssLibraryPath()) });
  } else if (scssFiles.length > 0) {
    notes.push(`note: ${scssProblem}; SCSS files not scanned`);
  }
  const locations = await scanLocations(ctx, scans, declaration);
  if (locations.length === 0) return prefixed(notes, notFound(`references to ${describePosition(position)}`));
  return success([...notes, ...groupedLines(locations, new LineTexts(ctx.root))]);
}

async function syntaxReferences(ctx: CommandContext, position: ResolvedPosition, unavailable: ServerUnavailable): Promise<Reply> {
  const language = requireServerLanguage("refs", position);
  if (language === "angular") return unavailable.reply;
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
    if (isStyleLanguage(position.file.language)) return styleReferences(ctx, position);
    let found;
    try {
      if (wantsAngularReferences(ctx, position)) return await angularReferences(ctx, position);
      found = await lspReferences(ctx, position);
    } catch (e) {
      if (e instanceof ServerUnavailable) return syntaxReferences(ctx, position, e);
      throw e;
    }
    if (found.locations.length === 0) return prefixed(found.waited, notFound(`references to ${describePosition(position)}`));
    return success([...found.waited, ...groupedLines(found.locations, new LineTexts(ctx.root))]);
  },
};
