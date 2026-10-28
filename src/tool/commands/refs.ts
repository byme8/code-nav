import { scanBatch } from "../index/astgrep.ts";
import { referenceRules, ruleText } from "../index/rules.ts";
import { rustReferenceRuleText } from "../index/rust.ts";
import { LineTexts, groupedLines, lspReferences, requireServerLanguage } from "../lsp/answer.ts";
import { ServerUnavailable } from "../lsp/pool.ts";
import { graphqlReferences } from "../graphql/answer.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import { notFound, prefixed, success, type Reply } from "../output.ts";
import { compareBytes, type Command, type CommandContext } from "./context.ts";
import { POSITION_FORMS, declarationsNamed, describePosition, parsePosition, type ResolvedPosition } from "./position.ts";

const USAGE = `usage: code-nav refs [--schema <path>] ${POSITION_FORMS}`;
const SCAN_BATCH = 400;

async function syntaxReferences(ctx: CommandContext, position: ResolvedPosition, unavailable: ServerUnavailable): Promise<Reply> {
  const language = requireServerLanguage("refs", position);
  const declarations = position.name === "" ? [] : declarationsNamed(ctx, position.name, null).filter((l) => l.file.language === language);
  if (declarations.length !== 1) return unavailable.reply;
  const declaration = declarations[0]!;
  const rules = language === "rust" ? rustReferenceRuleText(position.name) : ruleText(referenceRules(language, position.name));
  const paths = ctx.index.filesOf(new Set([language])).map((f) => f.path);
  const locations: { path: string; line: number; column: number }[] = [];
  for (let i = 0; i < paths.length; i += SCAN_BATCH) {
    for (const [path, matches] of await scanBatch(ctx.root, paths.slice(i, i + SCAN_BATCH), rules)) {
      for (const m of matches) {
        const line = m.range.start.line + 1;
        const column = m.charCount.leading + 1;
        if (path === declaration.file.path && line === declaration.symbol.nameLine && column === declaration.symbol.nameColumn) continue;
        locations.push({ path, line, column });
      }
    }
  }
  locations.sort((a, b) => compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column);
  const note = `note: ${unavailable.server} not available; syntax references of a unique name`;
  if (locations.length === 0) return prefixed([note], notFound(`references to ${describePosition(position)}`));
  return success([note, ...groupedLines(locations, new LineTexts(ctx.root))]);
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
    if (found.locations.length === 0) return prefixed(found.waited, notFound(`references to ${describePosition(position)}`));
    return success([...found.waited, ...groupedLines(found.locations, new LineTexts(ctx.root))]);
  },
};
