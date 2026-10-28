import { ask, insideRootSorted, symbolLines } from "../lsp/answer.ts";
import { failure, notFound, prefixed, success } from "../output.ts";
import type { Command } from "./context.ts";
import { POSITION_FORMS, describePosition, fileLines, identifierAt, lspPosition, parsePosition } from "./position.ts";

const USAGE = `usage: code-nav impls ${POSITION_FORMS}`;

export const impls: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const position = parsePosition(ctx, USAGE);
    if (position.file.language === "graphql") return failure(`impls needs a C# or TypeScript position; ${position.file.path} is GraphQL`);
    const { result, waited } = await ask(ctx, position, (client) => client.implementation(lspPosition(position)));
    const locations = insideRootSorted(result);
    if (locations.length === 0) return prefixed(waited, notFound(`implementations of ${describePosition(position)}`));
    const lines = symbolLines(
      ctx.index,
      locations.map((location) => ({
        location,
        fallbackKind: "symbol",
        fallbackName: identifierAt(fileLines(ctx.root, location.path)[location.line - 1] ?? "", location.column),
      })),
    );
    return success([...waited, ...lines]);
  },
};
