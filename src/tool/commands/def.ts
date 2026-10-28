import { LineTexts, ask } from "../lsp/answer.ts";
import { graphqlDefinition } from "../graphql/answer.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import { isStyleLanguage } from "../index/symbols.ts";
import { ambiguous, notFound, prefixed, success, type Reply } from "../output.ts";
import type { Command, CommandContext } from "./context.ts";
import { POSITION_FORMS, describePosition, lspPosition, parsePosition, type ResolvedPosition } from "./position.ts";
import { styleCandidates, styleDeclarationsAt, styleLabel, styleTarget } from "./style.ts";
import { angularDefinition, usesAngular } from "./angular.ts";

const USAGE = `usage: code-nav def [--schema <path>] ${POSITION_FORMS}`;

function styleDefinition(ctx: CommandContext, position: ResolvedPosition): Reply {
  const target = styleTarget(ctx, position);
  const declarations = target === null ? [] : styleDeclarationsAt(ctx, position, target);
  if (declarations.length === 0) return notFound(`definition of ${describePosition(position)}`);
  if (declarations.length > 1) return ambiguous(styleLabel(target!),styleCandidates(declarations));
  const { file, symbol } = declarations[0]!;
  return success([`${file.path}:${symbol.nameLine}:${symbol.nameColumn}  ${new LineTexts(ctx.root).text(file.path, symbol.nameLine)}`]);
}

export const def: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const { schema, rest } = takeSchemaOption(ctx.args);
    const position = parsePosition({ ...ctx, args: rest }, USAGE);
    if (position.file.language === "graphql") {
      return graphqlDefinition(ctx, position, schemaOf(ctx.root, locateRootSchema(ctx, schema)));
    }
    if (isStyleLanguage(position.file.language)) return styleDefinition(ctx, position);
    if (usesAngular(ctx, position)) {
      const answered = await angularDefinition(ctx, position);
      if (answered !== null) return answered;
    }
    const { result, waited } = await ask(ctx, position, (client) => client.definition(lspPosition(position)));
    const location = result.find((l) => l.insideRoot);
    if (location === undefined) {
      const outside = result[0] === undefined ? "" : ` inside the root (the server answered ${result[0].path})`;
      return prefixed(waited, notFound(`definition of ${describePosition(position)}${outside}`));
    }
    const texts = new LineTexts(ctx.root);
    return success([...waited, `${location.path}:${location.line}:${location.column}  ${texts.text(location.path, location.line)}`]);
  },
};
