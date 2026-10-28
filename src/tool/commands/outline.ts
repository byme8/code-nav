import { failure, success } from "../output.ts";
import { indexedFile, type Command } from "./context.ts";

export const outline: Command = {
  needsFreshIndex: true,
  run(ctx) {
    if (ctx.args.length !== 1) return failure("usage: code-nav outline <path>");
    const file = indexedFile(ctx, ctx.args[0]!);
    return success([
      file.path,
      ...file.symbols.map((s) => `${"  ".repeat(s.depth)}${s.nameLine}-${s.end} ${s.kind} ${s.name}`),
    ]);
  },
};
