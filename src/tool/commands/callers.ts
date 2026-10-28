import { ask, insideRootSorted, rejectStyleLanguage, symbolLines } from "../lsp/answer.ts";
import { symbolKindName } from "../lsp/symbol-kind.ts";
import { failure, notFound, prefixed, success } from "../output.ts";
import type { Command } from "./context.ts";
import { POSITION_FORMS, describePosition, lspPosition, parsePosition } from "./position.ts";

const USAGE = `usage: code-nav callers ${POSITION_FORMS}`;

export const callers: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const position = parsePosition(ctx, USAGE);
    if (position.file.language === "graphql") return failure(`callers needs a C# or TypeScript position; ${position.file.path} is GraphQL`);
    rejectStyleLanguage("callers", position);
    const { result, waited } = await ask(ctx, position, (client) => client.incomingCalls(lspPosition(position)));
    const fallback = new Map(result.map((c) => [`${c.location.path}:${c.location.line}:${c.location.column}`, c]));
    const locations = insideRootSorted(result.map((c) => c.location));
    if (locations.length === 0) return prefixed(waited, notFound(`callers of ${describePosition(position)}`));
    const lines = symbolLines(
      ctx.index,
      locations.map((location) => {
        const call = fallback.get(`${location.path}:${location.line}:${location.column}`)!;
        return { location, fallbackKind: symbolKindName(call.kind), fallbackName: call.name.split("(")[0]!.trim() };
      }),
    );
    return success([...waited, ...lines]);
  },
};
