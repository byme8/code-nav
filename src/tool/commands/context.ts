import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isGrammarLanguage, type SyntaxIndex } from "../index/index.ts";
import type { IndexedFile } from "../index/symbols.ts";
import { sourceLanguage } from "../index/walk.ts";
import type { ServerPool } from "../lsp/pool.ts";
import { ToolError, failure, notFound, type Reply } from "../output.ts";

export interface CommandContext {
  index: SyntaxIndex;
  root: string;
  cwd: string;
  args: string[];
  servers?: ServerPool;
  stdProblem?: string;
}

export interface Command {
  needsFreshIndex: boolean;
  run(ctx: CommandContext): Promise<Reply> | Reply;
}

export function rootRelative(root: string, arg: string): string {
  if (isAbsolute(arg)) {
    let target = arg;
    try {
      target = realpathSync(arg);
    } catch {
      target = arg;
    }
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new ToolError(failure(`path outside the root: ${arg}`));
    return rel.split(sep).join("/");
  }
  const posix = arg.split(sep).join("/");
  const rel = posix.startsWith("./") ? posix.slice(2) : posix;
  if (rel.split("/").includes("..")) throw new ToolError(failure(`path outside the root: ${arg}`));
  return rel;
}

export function looksLikePath(root: string, arg: string): boolean {
  return arg.includes("/") || arg.includes(sep) || sourceLanguage(arg) !== null || existsSync(join(root, arg));
}

export function indexedFile(ctx: CommandContext, arg: string): IndexedFile {
  const path = rootRelative(ctx.root, arg);
  const file = ctx.index.files.get(path);
  if (file !== undefined && isGrammarLanguage(file.language)) {
    const problem = ctx.index.grammarProblem(file.language);
    if (problem !== null) throw new ToolError(failure(problem));
  }
  if (file !== undefined) return file;
  if (!existsSync(join(ctx.root, path))) throw new ToolError(notFound(`file ${path}`));
  if (sourceLanguage(path) === "angular") {
    throw new ToolError(failure(`not an Angular template: ${path} (the nearest package.json above it does not declare @angular/core)`));
  }
  throw new ToolError(failure(`not a C#, TypeScript or GraphQL source file in the index: ${path}`));
}

export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
