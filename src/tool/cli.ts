#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { EXIT } from "./output.ts";
import { ensureDaemon, request, status, stop } from "./daemon/lifecycle.ts";
import { runDaemon } from "./daemon/server.ts";
import { resolveRoot } from "./daemon/state.ts";
import { install } from "./install.ts";
import { doctor } from "./doctor.ts";
import { uninstall } from "./uninstall.ts";

const USAGE = [
  "usage: code-nav [--root <dir>] <command> …",
  "  find [--target file|member|symbol][--lang csharp|typescript|graphql|rust|wgsl|css|scss]… [--kind tests|migrations|generated]… <words…>",
  "  outline <path>",
  "  show <path>:<line>[:<col>] [<name>] | <path> <name> [<line>] | <name> | <Owner.name>",
  "  refs | def [--schema <path>] <path>:<line>:<col> | <path>:<line> <name> | <name> | <Owner.name>",
  "  impls | callers <path>:<line>:<col> | <path>:<line> <name> | <name> | <Owner.name>",
  "  trace [--schema <path>] <path>:<line>:<col> | <path>:<line> <name> | <Type.Property>",
  "  status | stop",
  "  install [--lang <id,…>]… [--yes] [--claude-home <dir>]",
  "  install ast-grep | rust-src | grammars",
  "  doctor",
  "  uninstall [--claude-home <dir>]",
];

const output: string[] = [];

function write(text: string): void {
  if (text !== "") output.push(text.endsWith("\n") ? text : `${text}\n`);
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "daemon") {
    await runDaemon(argv[1]!);
    return -1;
  }
  const args = [...argv];
  let rootOption: string | undefined;
  const at = args.findIndex((a) => a === "--root" || a.startsWith("--root="));
  if (at >= 0) {
    const arg = args[at]!;
    rootOption = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[at + 1];
    args.splice(at, arg.includes("=") ? 1 : 2);
    if (rootOption === undefined) {
      write("error: --root needs a directory");
      return EXIT.error;
    }
  }
  const [command] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    write(USAGE.join("\n"));
    return command === undefined ? EXIT.error : EXIT.success;
  }
  if (command === "install") return await install(args.slice(1), (text) => writeSync(1, text.endsWith("\n") ? text : `${text}\n`));
  if (command === "doctor") return doctor(args.slice(1), write);
  if (command === "uninstall") return await uninstall(args.slice(1), write);
  let root: string;
  try {
    root = resolveRoot(rootOption, process.cwd());
  } catch (e) {
    write(`error: cannot resolve the root: ${(e as Error).message}`);
    return EXIT.error;
  }
  if (command === "stop") {
    write(await stop(root));
    return EXIT.success;
  }
  if (command === "status") {
    const reply = await status(root);
    if (reply === null) {
      write(`not found: no daemon running for ${root}`);
      return EXIT.notFound;
    }
    write(reply.stdout);
    return reply.exitCode;
  }
  let notice: string | null;
  try {
    notice = await ensureDaemon(root);
  } catch (e) {
    write(`error: daemon start failed: ${(e as Error).message}`);
    return EXIT.error;
  }
  if (notice !== null) write(notice);
  try {
    const reply = await request(root, args, process.cwd());
    write(reply.stdout);
    return reply.exitCode;
  } catch (e) {
    write(`error: daemon failed during the command: ${(e as Error).message}`);
    return EXIT.error;
  }
}

const code = await main(process.argv.slice(2));
if (code >= 0) {
  if (output.length > 0) await Bun.write(Bun.stdout, output.join(""));
  process.exit(code);
}
