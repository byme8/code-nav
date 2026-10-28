import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../commands/context.ts";
import type { ResolvedPosition } from "../commands/position.ts";
import { describePosition } from "../commands/position.ts";
import { LineTexts, groupedLines } from "../lsp/answer.ts";
import { ToolError, notFound, success, type Reply } from "../output.ts";
import { parseDocument, parseDocuments, selectionAt, selectionsOf } from "./documents.ts";
import { schemaOf, type Schema, type SchemaField } from "./schema.ts";

function selectedField(ctx: CommandContext, position: ResolvedPosition, schema: Schema): { type: string | null; field: string } | null {
  const document = parseDocument(position.file.path, readFileSync(join(ctx.root, position.file.path), "utf8"), schema);
  const selection = selectionAt(document, position.line, position.column, position.name);
  return selection === null ? null : { type: selection.parentType, field: selection.field };
}

function schemaFieldOf(schema: Schema, type: string | null, field: string): SchemaField | null {
  return type === null ? null : (schema.types.get(type)?.fields.get(field) ?? null);
}

export function graphqlDefinition(ctx: CommandContext, position: ResolvedPosition, schema: Schema): Reply {
  const what = `definition of ${describePosition(position)}`;
  if (position.file.path === schema.path) throw new ToolError(notFound(`${what}: the position is in the root schema ${schema.path}`));
  const selected = selectedField(ctx, position, schema);
  if (selected === null) throw new ToolError(notFound(`${what}: not a field selection`));
  const field = schemaFieldOf(schema, selected.type, selected.field);
  if (field === null) {
    const parent = selected.type === null ? "an unresolved parent type" : `type ${selected.type}`;
    throw new ToolError(notFound(`${what}: no field ${selected.field} on ${parent} in ${schema.path}`));
  }
  return success([`${schema.path}:${field.line}:${field.column}  ${field.text.trim()}`]);
}

export function graphqlReferences(ctx: CommandContext, position: ResolvedPosition, schema: Schema): Reply {
  const what = `references to ${describePosition(position)}`;
  let target: { type: string; field: string } | null = null;
  const own = schemaOf(ctx.root, position.file).fields.find((f) => f.line === position.line);
  if (own !== undefined) target = { type: own.type, field: own.name };
  else if (position.file.path !== schema.path) {
    const selected = selectedField(ctx, position, schema);
    const field = selected === null ? null : schemaFieldOf(schema, selected.type, selected.field);
    if (field !== null) target = { type: field.type, field: field.name };
  }
  if (target === null) throw new ToolError(notFound(`${what}: not a schema field or a field selection`));
  const locations = selectionsOf(parseDocuments(ctx, schema), target.type, target.field).map(({ document, selection }) => ({
    path: document.path,
    line: selection.line,
    column: selection.column,
  }));
  if (locations.length === 0) throw new ToolError(notFound(`${what} (${target.type}.${target.field}) in the GraphQL documents`));
  return success(groupedLines(locations, new LineTexts(ctx.root)));
}
