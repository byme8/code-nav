import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../commands/context.ts";
import { compareBytes } from "../commands/context.ts";
import type { IndexedFile } from "../index/symbols.ts";
import { isSchemaFile, type Schema } from "./schema.ts";

interface Token {
  kind: "name" | "punct" | "spread" | "variable" | "string" | "number";
  value: string;
  line: number;
  column: number;
}

export interface Definition {
  kind: "query" | "mutation" | "subscription" | "fragment";
  name: string | null;
  line: number;
  column: number;
  spreads: Set<string>;
}

export interface Selection {
  field: string;
  line: number;
  column: number;
  alias: { line: number; column: number; length: number } | null;
  parentType: string | null;
  definition: number;
}

export interface ParsedDocument {
  path: string;
  definitions: Definition[];
  selections: Selection[];
}

const OPERATION_ROOT: Record<string, string> = { query: "Query", mutation: "Mutation", subscription: "Subscription" };

function tokenize(source: string): Token[] {
  const chars = Array.from(source);
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n: number) => {
    for (let k = 0; k < n && i < chars.length; k++) {
      if (chars[i] === "\n") {
        line++;
        column = 1;
      } else column++;
      i++;
    }
  };
  const word = (from: number) => {
    let to = from;
    while (to < chars.length && /\w/.test(chars[to]!)) to++;
    return chars.slice(from, to).join("");
  };
  while (i < chars.length) {
    const c = chars[i]!;
    const at = { line, column };
    if (/[\s,﻿]/.test(c)) {
      advance(1);
    } else if (c === "#") {
      while (i < chars.length && chars[i] !== "\n") advance(1);
    } else if (c === '"') {
      if (chars[i + 1] === '"' && chars[i + 2] === '"') {
        advance(3);
        while (i < chars.length && !(chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"')) advance(chars[i] === "\\" ? 2 : 1);
        advance(3);
      } else {
        advance(1);
        while (i < chars.length && chars[i] !== '"' && chars[i] !== "\n") advance(chars[i] === "\\" ? 2 : 1);
        advance(1);
      }
      tokens.push({ kind: "string", value: "", ...at });
    } else if (c === "." && chars[i + 1] === "." && chars[i + 2] === ".") {
      tokens.push({ kind: "spread", value: "...", ...at });
      advance(3);
    } else if (/[A-Za-z_]/.test(c)) {
      const value = word(i);
      tokens.push({ kind: "name", value, ...at });
      advance(value.length);
    } else if (c === "$") {
      const value = word(i + 1);
      tokens.push({ kind: "variable", value, ...at });
      advance(value.length + 1);
    } else if (/[-0-9]/.test(c)) {
      let to = i + 1;
      while (to < chars.length && /[0-9.eE+-]/.test(chars[to]!)) to++;
      tokens.push({ kind: "number", value: chars.slice(i, to).join(""), ...at });
      advance(to - i);
    } else {
      tokens.push({ kind: "punct", value: c, ...at });
      advance(1);
    }
  }
  return tokens;
}

export function parseDocument(path: string, source: string, schema: Schema): ParsedDocument {
  const tokens = tokenize(source);
  const definitions: Definition[] = [];
  const selections: Selection[] = [];
  let p = 0;
  const is = (kind: Token["kind"], value?: string, offset = 0) => {
    const t = tokens[p + offset];
    return t !== undefined && t.kind === kind && (value === undefined || t.value === value);
  };
  const skipBalanced = (open: string, close: string) => {
    let depth = 0;
    while (p < tokens.length) {
      const t = tokens[p++]!;
      if (t.kind === "punct" && t.value === open) depth++;
      else if (t.kind === "punct" && t.value === close && --depth === 0) return;
    }
  };
  const skipDirectives = () => {
    while (is("punct", "@")) {
      p++;
      if (is("name")) p++;
      if (is("punct", "(")) skipBalanced("(", ")");
    }
  };
  const selectionSet = (type: string | null, definition: number) => {
    p++;
    while (p < tokens.length) {
      const t = tokens[p]!;
      if (t.kind === "punct" && t.value === "}") {
        p++;
        return;
      }
      if (t.kind === "spread") {
        p++;
        if (is("name", "on")) {
          p++;
          const condition = is("name") ? tokens[p++]!.value : type;
          skipDirectives();
          if (is("punct", "{")) selectionSet(condition, definition);
        } else if (is("name")) {
          definitions[definition]!.spreads.add(tokens[p++]!.value);
          skipDirectives();
        } else {
          skipDirectives();
          if (is("punct", "{")) selectionSet(type, definition);
        }
        continue;
      }
      if (t.kind === "name") {
        p++;
        let field = t;
        let alias: Selection["alias"] = null;
        if (is("punct", ":") && is("name", undefined, 1)) {
          alias = { line: t.line, column: t.column, length: Array.from(t.value).length };
          field = tokens[p + 1]!;
          p += 2;
        }
        selections.push({ field: field.value, line: field.line, column: field.column, alias, parentType: type, definition });
        if (is("punct", "(")) skipBalanced("(", ")");
        skipDirectives();
        if (is("punct", "{")) {
          const child = type === null ? null : (schema.types.get(type)?.fields.get(field.value)?.returns ?? null);
          selectionSet(child, definition);
        }
        continue;
      }
      p++;
    }
  };
  while (p < tokens.length) {
    const t = tokens[p]!;
    if (t.kind === "name" && t.value in OPERATION_ROOT) {
      p++;
      const name = is("name") ? tokens[p++]!.value : null;
      definitions.push({ kind: t.value as Definition["kind"], name, line: t.line, column: t.column, spreads: new Set() });
      if (is("punct", "(")) skipBalanced("(", ")");
      skipDirectives();
      if (is("punct", "{")) selectionSet(OPERATION_ROOT[t.value]!, definitions.length - 1);
    } else if (t.kind === "name" && t.value === "fragment") {
      p++;
      const name = is("name") ? tokens[p++]!.value : null;
      if (is("name", "on")) p++;
      const condition = is("name") ? tokens[p++]!.value : null;
      definitions.push({ kind: "fragment", name, line: t.line, column: t.column, spreads: new Set() });
      skipDirectives();
      if (is("punct", "{")) selectionSet(condition, definitions.length - 1);
    } else if (t.kind === "punct" && t.value === "{") {
      definitions.push({ kind: "query", name: null, line: t.line, column: t.column, spreads: new Set() });
      selectionSet("Query", definitions.length - 1);
    } else p++;
  }
  return { path, definitions, selections };
}

export function documentFiles(ctx: CommandContext, schema: Schema): IndexedFile[] {
  return ctx.index
    .filesOf(new Set(["graphql"]))
    .filter((f) => f.path !== schema.path && !isSchemaFile(f))
    .sort((a, b) => compareBytes(a.path, b.path));
}

export function parseDocuments(ctx: CommandContext, schema: Schema): ParsedDocument[] {
  return documentFiles(ctx, schema).map((f) => parseDocument(f.path, readFileSync(join(ctx.root, f.path), "utf8"), schema));
}

export function selectionAt(document: ParsedDocument, line: number, column: number, name: string): Selection | null {
  for (const s of document.selections) {
    if (s.line === line && column >= s.column && column <= s.column + Array.from(s.field).length) return s;
    const a = s.alias;
    if (a !== null && a.line === line && column >= a.column && column <= a.column + a.length) return s;
  }
  return document.selections.find((s) => s.line === line && s.field === name) ?? null;
}

export function selectionsOf(documents: ParsedDocument[], type: string, field: string): { document: ParsedDocument; selection: Selection }[] {
  const out: { document: ParsedDocument; selection: Selection }[] = [];
  for (const document of documents) {
    for (const selection of document.selections) {
      if (selection.field === field && selection.parentType === type) out.push({ document, selection });
    }
  }
  return out;
}

export function operationsUsing(documents: ParsedDocument[], document: ParsedDocument, definition: number): { document: ParsedDocument; name: string }[] {
  const out: { document: ParsedDocument; name: string }[] = [];
  const seen = new Set<string>();
  const fragments = new Set<string>();
  const visit = (doc: ParsedDocument, index: number) => {
    const def = doc.definitions[index]!;
    if (def.kind !== "fragment") {
      const key = `${doc.path}\0${index}`;
      if (!seen.has(key) && def.name !== null) out.push({ document: doc, name: def.name });
      seen.add(key);
      return;
    }
    if (def.name === null || fragments.has(def.name)) return;
    fragments.add(def.name);
    for (const other of documents) {
      other.definitions.forEach((d, i) => {
        if (d.spreads.has(def.name!)) visit(other, i);
      });
    }
  };
  visit(document, definition);
  return out;
}
