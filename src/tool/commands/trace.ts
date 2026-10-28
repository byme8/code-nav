import { blockEnd, camelCase, escapeRegex, isGeneratedPath } from "../index/declarations.ts";
import { TRACE_ROLES, type TraceRole } from "../language.ts";
import type { Location } from "../lsp/client.ts";
import { operationsUsing, parseDocuments, type ParsedDocument, type Selection } from "../graphql/documents.ts";
import { locateRootSchema, schemaOf, takeSchemaOption } from "../graphql/schema.ts";
import type { ToolSymbol } from "../index/symbols.ts";
import { LineTexts, serversOf, waitedLines } from "../lsp/answer.ts";
import { failure, notFound, prefixed, success } from "../output.ts";
import { compareBytes, type Command, type CommandContext } from "./context.ts";
import { describePosition, fileLines, parsePosition } from "./position.ts";

const USAGE = "usage: code-nav trace [--schema <path>] <path>:<line>:<col> | <path>:<line> <name> | <Type.Property>";
const HOOK_SUFFIXES = "Query|LazyQuery|SuspenseQuery|Mutation|Subscription";
const HOOK_KINDS = new Set(["function", "constant"]);
const COMPONENT_KINDS = new Set(["component", "function", "constant", "class"]);

interface Link {
  role: TraceRole;
  path: string;
  line: number;
  column: number;
}

function wordColumns(text: string, word: string): number[] {
  const columns: number[] = [];
  const pattern = new RegExp(`(?<![\\w$])${escapeRegex(word)}(?![\\w$])`, "g");
  for (const m of text.matchAll(pattern)) columns.push(Array.from(text.slice(0, m.index)).length + 1);
  return columns;
}

function outermost(symbols: ToolSymbol[], line: number, keep: (s: ToolSymbol) => boolean): ToolSymbol | null {
  let best: ToolSymbol | null = null;
  for (const s of symbols) {
    if (s.start > line || s.end < line || !keep(s)) continue;
    if (best === null || s.end - s.start > best.end - best.start) best = s;
  }
  return best;
}

class Trace {
  readonly links: Link[] = [];
  readonly waited: string[] = [];
  private readonly lines = new Map<string, string[]>();

  constructor(private readonly ctx: CommandContext) {}

  add(role: TraceRole, path: string, line: number, column: number): void {
    this.links.push({ role, path, line, column });
  }

  text(path: string): string[] {
    let lines = this.lines.get(path);
    if (lines === undefined) {
      lines = fileLines(this.ctx.root, path);
      this.lines.set(path, lines);
    }
    return lines;
  }

  async references(path: string, line: number, column: number): Promise<Location[]> {
    const { result, acquired } = await serversOf(this.ctx).run("typescript", path, (client) => client.references({ path, line, column }, false));
    if (this.waited.length === 0) this.waited.push(...waitedLines(acquired));
    return result.filter((l) => l.insideRoot);
  }

  enclosingHook(path: string, line: number): ToolSymbol | null {
    const file = this.ctx.index.files.get(path);
    if (file === undefined || file.language !== "typescript") return null;
    const lines = this.text(path);
    return outermost(
      file.symbols,
      line,
      (s) => s.container === null && HOOK_KINDS.has(s.kind) && /^use/.test(s.name) && /^\s*export\s/.test(lines[s.nameLine - 1] ?? ""),
    );
  }

  enclosingComponent(path: string, line: number): ToolSymbol | null {
    const file = this.ctx.index.files.get(path);
    if (file === undefined) return null;
    const top = outermost(file.symbols, line, () => true);
    return top !== null && COMPONENT_KINDS.has(top.kind) && /^[A-Z]/.test(top.name) ? top : null;
  }

  render(): string[] {
    const seen = new Set<string>();
    const texts = new LineTexts(this.ctx.root);
    return this.links
      .filter((l) => {
        const key = `${l.role}\0${l.path}\0${l.line}\0${l.column}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(
        (a, b) =>
          TRACE_ROLES.indexOf(a.role) - TRACE_ROLES.indexOf(b.role) || compareBytes(a.path, b.path) || a.line - b.line || a.column - b.column,
      )
      .map((l) => `${l.role} ${l.path}:${l.line}:${l.column}  ${texts.text(l.path, l.line)}`);
  }
}

function generatedPathOf(document: string): string {
  return document.replace(/\.graphql$/, ".gql.ts");
}

export const trace: Command = {
  needsFreshIndex: true,
  async run(ctx) {
    const { schema: option, rest } = takeSchemaOption(ctx.args);
    const position = parsePosition({ ...ctx, args: rest }, USAGE);
    if (position.file.language !== "csharp") return failure(`trace starts at a C# property; ${position.file.path} is ${position.file.language}`);
    const symbols = position.file.symbols;
    const property =
      symbols.find((s) => s.nameLine === position.line && s.nameColumn === position.column) ??
      symbols.find((s) => s.nameLine === position.line && s.name === position.name);
    if (property === undefined || property.container === null) {
      return failure(`trace starts at a C# property of a type; ${describePosition(position)} is not a declared member`);
    }
    if (property.kind !== "property" && property.kind !== "field") {
      return failure(`trace starts at a C# property; ${property.name} at ${position.file.path}:${position.line} is a ${property.kind}`);
    }
    const owner = property.container;
    const field = camelCase(property.name);
    const schema = schemaOf(ctx.root, locateRootSchema(ctx, option));
    const t = new Trace(ctx);
    t.add("csharp-property", position.file.path, position.line, position.column);

    const objectFields = schema.fields.filter((f) => f.name === field && schema.types.get(f.type)?.kind !== "input");
    const ownerDeclared = schema.types.has(owner) && schema.types.get(owner)!.kind !== "input";
    const schemaFields = ownerDeclared ? objectFields.filter((f) => f.type === owner) : objectFields;
    if (schemaFields.length === 0) return notFound(`schema field ${field} of ${owner} in ${schema.path}`);
    for (const f of schemaFields) t.add("schema-field", schema.path, f.line, f.column);
    const schemaTypes = new Set(schemaFields.map((f) => f.type));

    const documents = parseDocuments(ctx, schema);
    const selecting: { document: ParsedDocument; selection: Selection }[] = [];
    for (const document of documents) {
      for (const selection of document.selections) {
        if (selection.field !== field || selection.parentType === null || !schemaTypes.has(selection.parentType)) continue;
        selecting.push({ document, selection });
        t.add("document-selection", document.path, selection.line, selection.column);
      }
    }

    const generatedMembers: Link[] = [];
    for (const path of new Set(selecting.map((s) => generatedPathOf(s.document.path)))) {
      if (!ctx.index.files.has(path)) continue;
      t.text(path).forEach((text, i) => {
        for (const column of wordColumns(text, field)) generatedMembers.push({ role: "generated-ts-member", path, line: i + 1, column });
      });
    }
    for (const link of generatedMembers) t.add(link.role, link.path, link.line, link.column);
    const baseTypeHeader = new RegExp(`^export type ${escapeRegex(owner)} = `);
    const baseTypeMember = new RegExp(`^\\s+(?:readonly\\s+)?${escapeRegex(field)}\\??\\s*:`);
    for (const file of ctx.index.filesOf(new Set(["typescript"]))) {
      if (!isGeneratedPath(file.path) || file.path.endsWith(".gql.ts")) continue;
      const lines = t.text(file.path);
      const header = lines.findIndex((l) => baseTypeHeader.test(l));
      if (header < 0) continue;
      const end = blockEnd(lines.slice(header).map((text, i) => ({ line: header + i + 1, text })), false) ?? lines.length;
      for (let i = header + 1; i < end; i++) {
        if (!baseTypeMember.test(lines[i]!)) continue;
        t.add("generated-ts-member", file.path, i + 1, wordColumns(lines[i]!, field)[0]!);
        break;
      }
    }

    const operations = new Map<string, { document: ParsedDocument; name: string }>();
    for (const { document, selection } of selecting) {
      for (const op of operationsUsing(documents, document, selection.definition)) operations.set(`${op.document.path}\0${op.name}`, op);
    }
    for (const op of operations.values()) {
      const path = generatedPathOf(op.document.path);
      if (!ctx.index.files.has(path)) continue;
      const declaration = new RegExp(`^export function (use${escapeRegex(op.name)}(?:${HOOK_SUFFIXES}))\\b`);
      const lines = t.text(path);
      for (let i = 0; i < lines.length; i++) {
        const m = declaration.exec(lines[i]!);
        if (m === null) continue;
        const column = Array.from(lines[i]!.slice(0, lines[i]!.indexOf(m[1]!))).length + 1;
        for (const use of await t.references(path, i + 1, column)) {
          if (isGeneratedPath(use.path)) continue;
          const hook = t.enclosingHook(use.path, use.line);
          if (hook !== null) t.add("service-hook", use.path, hook.nameLine, hook.nameColumn);
        }
      }
    }

    for (const member of generatedMembers) {
      for (const use of await t.references(member.path, member.line, member.column)) {
        if (!use.path.endsWith(".tsx")) continue;
        const component = t.enclosingComponent(use.path, use.line);
        if (component !== null) t.add("component", use.path, component.nameLine, component.nameColumn);
      }
    }
    return prefixed(t.waited, success(t.render()));
  },
};
