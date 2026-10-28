import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { compareBytes, rootRelative, type CommandContext } from "../commands/context.ts";
import type { IndexedFile } from "../index/symbols.ts";
import { ToolError, ambiguous, failure, notFound } from "../output.ts";

export interface SchemaField {
  type: string;
  name: string;
  line: number;
  column: number;
  text: string;
  returns: string | null;
}

export interface SchemaType {
  name: string;
  kind: "type" | "interface" | "input";
  fields: Map<string, SchemaField>;
}

export interface Schema {
  path: string;
  types: Map<string, SchemaType>;
  fields: SchemaField[];
}

const HEADER = /^(?:extend\s+)?(type|interface|input)\s+([A-Za-z_]\w*)/;
const FIELD = /^(\s+)([A-Za-z_]\w*)\s*[:(]/;
const RETURN_AFTER_ARGUMENTS = /\)\s*:(.*)$/;
const NAMED_TYPE = /^[\s[\]!]*([A-Za-z_]\w*)/;
const CODEGEN_FILE = /(?:^|\/)codegen\.(?:ts|mts|cts)$/;
const CODEGEN_SCHEMA = /\bschema\s*:\s*['"`]([^'"`]+\.(?:graphql|gql))['"`]/;

function returnType(lines: string[], index: number, text: string): string | null {
  const open = text.indexOf("(");
  const colon = text.indexOf(":");
  let after: string | null = null;
  if (open >= 0 && (colon < 0 || open < colon)) {
    for (let i = index; i < lines.length; i++) {
      const m = RETURN_AFTER_ARGUMENTS.exec(lines[i]!);
      if (m !== null) {
        after = m[1]!;
        break;
      }
    }
  } else if (colon >= 0) after = text.slice(colon + 1);
  return after === null ? null : (NAMED_TYPE.exec(after)?.[1] ?? null);
}

export function parseSchema(path: string, source: string): Schema {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, ""));
  const types = new Map<string, SchemaType>();
  const fields: SchemaField[] = [];
  let current: SchemaType | null = null;
  let inDescription = false;
  lines.forEach((text, index) => {
    const quotes = text.split('"""').length - 1;
    if (inDescription) {
      if (quotes % 2 === 1) inDescription = false;
      return;
    }
    if (quotes % 2 === 1) {
      inDescription = true;
      return;
    }
    if (/^\S/.test(text)) {
      if (text.startsWith("#")) return;
      const header = HEADER.exec(text);
      if (header === null) {
        current = null;
        return;
      }
      const name = header[2]!;
      current = types.get(name) ?? { name, kind: header[1] as SchemaType["kind"], fields: new Map() };
      types.set(name, current);
      return;
    }
    if (current === null) return;
    const m = FIELD.exec(text);
    if (m === null) return;
    const field: SchemaField = {
      type: current.name,
      name: m[2]!,
      line: index + 1,
      column: Array.from(m[1]!).length + 1,
      text,
      returns: returnType(lines, index, text),
    };
    if (!current.fields.has(field.name)) current.fields.set(field.name, field);
    fields.push(field);
  });
  return { path, types, fields };
}

const parsed = new Map<string, { key: string; schema: Schema }>();

export function schemaOf(root: string, file: IndexedFile): Schema {
  const key = `${file.stamp.mtimeMs}|${file.stamp.size}|${file.stamp.ino}`;
  const cached = parsed.get(`${root}\0${file.path}`);
  if (cached !== undefined && cached.key === key) return cached.schema;
  const schema = parseSchema(file.path, readFileSync(join(root, file.path), "utf8"));
  parsed.set(`${root}\0${file.path}`, { key, schema });
  return schema;
}

export function takeSchemaOption(args: string[]): { schema: string | null; rest: string[] } {
  const rest = [...args];
  const at = rest.findIndex((a) => a === "--schema" || a.startsWith("--schema="));
  if (at < 0) return { schema: null, rest };
  const arg = rest[at]!;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[at + 1];
  if (value === undefined || value === "") throw new ToolError(failure("--schema needs a .graphql path"));
  rest.splice(at, arg.includes("=") ? 1 : 2);
  return { schema: value, rest };
}

function codegenSchemas(ctx: CommandContext): string[] {
  const found = new Set<string>();
  for (const file of ctx.index.files.values()) {
    if (!CODEGEN_FILE.test(file.path)) continue;
    let text: string;
    try {
      text = readFileSync(join(ctx.root, file.path), "utf8");
    } catch {
      continue;
    }
    const m = CODEGEN_SCHEMA.exec(text);
    if (m === null) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file.path), m[1]!));
    if (ctx.index.files.get(resolved)?.language === "graphql") found.add(resolved);
  }
  return [...found].sort(compareBytes);
}

export function locateRootSchema(ctx: CommandContext, option: string | null): IndexedFile {
  if (option !== null) {
    const path = rootRelative(ctx.root, option);
    const file = ctx.index.files.get(path);
    if (file === undefined || file.language !== "graphql") throw new ToolError(notFound(`GraphQL schema ${path}`));
    return file;
  }
  let candidates = codegenSchemas(ctx);
  const how = candidates.length > 0 ? "GraphQL codegen configs name several schemas" : "several .graphql files declare type Query";
  if (candidates.length === 0) {
    candidates = ctx.index
      .filesOf(new Set(["graphql"]))
      .filter((f) => f.symbols.some((s) => s.kind === "type" && s.name === "Query"))
      .map((f) => f.path)
      .sort(compareBytes);
  }
  if (candidates.length === 0) {
    throw new ToolError(notFound("root GraphQL schema: no codegen config names one and no .graphql file declares type Query; pass --schema <path>"));
  }
  if (candidates.length > 1) throw new ToolError(ambiguous(`root GraphQL schema (${how}); pass --schema <path>`, candidates));
  return ctx.index.files.get(candidates[0]!)!;
}

export function isSchemaFile(file: IndexedFile): boolean {
  return file.symbols.some((s) => s.kind === "type" || s.kind === "input" || s.kind === "enum");
}
