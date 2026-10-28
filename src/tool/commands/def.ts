import { LineTexts, ask } from "../lsp/answer.ts";
import { graphqlDefinition } from "../graphql/answer.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import { notFound, prefixed, success } from "../output.ts";
import type { Command } from "./context.ts";
import { POSITION_FORMS, describePosition, lspPosition, parsePosition } from "./position.ts";

const USAGE = `usage: code-nav def [--schema <path>] ${POSITION_FORMS}`;

export const def: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const { schema, rest } = takeSchemaOption(ctx.args);
    const position = parsePosition({ ...ctx, args: rest }, USAGE);
    if (position.file.language === "graphql") {
      return graphqlDefinition(ctx, position, schemaOf(ctx.root, locateRootSchema(ctx, schema)));
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
