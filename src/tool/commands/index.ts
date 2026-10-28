import { EXIT, ToolError, failure, type Reply } from "../output.ts";
import { stdNote } from "../rust-src.ts";
import type { Command, CommandContext } from "./context.ts";
import { callers } from "./callers.ts";
import { def } from "./def.ts";
import { find } from "./find.ts";
import { impls } from "./impls.ts";
import { outline } from "./outline.ts";
import { refs } from "./refs.ts";
import { show } from "./show.ts";
import { trace } from "./trace.ts";

export const COMMANDS: Readonly<Record<string, Command>> = { find, outline, show, refs, def, impls, callers, trace };

export async function runCommand(name: string, ctx: CommandContext): Promise<Reply> {
  const command = COMMANDS[name];
  if (command === undefined) return failure(`unknown command: ${name}`);
  let reply: Reply;
  try {
    reply = await command.run(ctx);
  } catch (e) {
    if (e instanceof ToolError) return e.reply;
    return failure((e as Error).message ?? String(e));
  }
  return reply.exitCode === EXIT.notFound && ctx.stdProblem !== undefined && ctx.servers?.claimStdNote() === true
    ? withStdNote(reply, ctx.stdProblem)
    : reply;
}

function withStdNote(reply: Reply, problem: string): Reply {
  const lines = reply.stdout.split("\n");
  const at = lines.findIndex((l) => !l.startsWith("waited "));
  lines.splice(at, 0, stdNote(problem));
  return { ...reply, stdout: lines.join("\n") };
}
