import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { escapeRegex } from "./declarations.ts";
import { customLanguageConfigPath, defaultGrammarDir, missingGrammarMessage } from "./wgsl.ts";

type Rule = Record<string, unknown>;

export const ANGULAR_LIBRARY_FILE =
  process.platform === "darwin" ? "angular.dylib" : process.platform === "win32" ? "angular.dll" : "angular.so";
export const ANGULAR_GRAMMAR_ENV = "CODE_NAV_ANGULAR_GRAMMAR";
const AG_LANGUAGE = "angular";

export function angularLibraryPath(): string {
  return process.env[ANGULAR_GRAMMAR_ENV] || join(defaultGrammarDir(), ANGULAR_LIBRARY_FILE);
}

export function angularGrammarProblem(): string | null {
  const library = angularLibraryPath();
  return existsSync(library) ? null : missingGrammarMessage(library, "Angular", ANGULAR_GRAMMAR_ENV);
}

const COMPONENT_DECORATOR: Rule = {
  kind: "object",
  inside: {
    kind: "arguments",
    inside: { kind: "call_expression", has: { field: "function", regex: "^Component$" }, inside: { kind: "decorator" } },
  },
};

const INLINE_TEMPLATE: Rule = {
  pattern: "$CONTENT",
  any: [{ kind: "template_string" }, { kind: "string" }],
  inside: { kind: "pair", has: { field: "key", regex: "^template$" }, inside: COMPONENT_DECORATOR },
};

export function angularConfigPath(library: string): string {
  const injection = `languageInjections:\n  - hostLanguage: typescript\n    rule: ${JSON.stringify(INLINE_TEMPLATE)}\n    injected: ${AG_LANGUAGE}\n`;
  return customLanguageConfigPath(AG_LANGUAGE, library, "tree_sitter_angular", "html", injection);
}

function decoratorValue(decorators: string, key: string): Rule {
  return {
    kind: "string_fragment",
    inside: {
      kind: "string",
      inside: {
        kind: "pair",
        has: { field: "key", regex: `^${key}$` },
        inside: {
          kind: "object",
          inside: {
            kind: "arguments",
            inside: { kind: "call_expression", has: { field: "function", regex: `^(?:${decorators})$` }, inside: { kind: "decorator" } },
          },
        },
      },
    },
  };
}

export const DECORATOR_KINDS: ReadonlySet<string> = new Set(["selector", "pipe", "template"]);

export const DECORATOR_RULES: Record<string, Rule> = {
  selector: decoratorValue("Component|Directive", "selector"),
  pipe: decoratorValue("Pipe", "name"),
  template: { kind: "property_identifier", regex: "^template$", inside: { field: "key", kind: "pair", inside: COMPONENT_DECORATOR } },
};

const OPEN_TAGS: Rule[] = [{ kind: "start_tag" }, { kind: "self_closing_tag" }];
const CUSTOM_TAG_NAME: Rule = { kind: "tag_name", regex: "-", not: { regex: "^ng-" } };
const CUSTOM_OPEN_TAG: Rule = { any: OPEN_TAGS, has: CUSTOM_TAG_NAME };

const BLOCK_KINDS = [
  "if_statement",
  "else_if_statement",
  "else_statement",
  "for_statement",
  "empty_statement",
  "switch_statement",
  "case_statement",
  "default_statement",
  "defer_statement",
  "placeholder_statement",
  "loading_statement",
  "error_statement",
];

function binding(kind: string): Rule {
  return { kind: "binding_name", inside: { kind, inside: { kind: "attribute", inside: CUSTOM_OPEN_TAG } } };
}

const OUTLINE: { id: string; rule: Rule }[] = [
  { id: "element", rule: { ...CUSTOM_TAG_NAME, inside: { any: OPEN_TAGS } } },
  { id: "block", rule: { any: [...BLOCK_KINDS.map((kind) => ({ kind })), { kind: "structural_directive" }] } },
  { id: "let", rule: { kind: "identifier", inside: { field: "name", kind: "assignment_expression", inside: { kind: "let_statement" } } } },
  { id: "template-ref", rule: { kind: "attribute_name", regex: "^#" } },
  { id: "input", rule: binding("property_binding") },
  { id: "output", rule: binding("event_binding") },
  { id: "two-way", rule: binding("two_way_binding") },
];

export const TEMPLATE_KINDS: ReadonlySet<string> = new Set(OUTLINE.map((d) => d.id));

const DECLARATION_KINDS = ["element", "attribute", "let_statement", ...BLOCK_KINDS];

function documents(docs: { id: string; rule: Rule }[]): string {
  return docs.map((d) => JSON.stringify({ id: d.id, language: AG_LANGUAGE, severity: "info", rule: d.rule })).join("\n---\n");
}

export function angularRuleText(declarationId: string): string {
  return documents([...OUTLINE, { id: declarationId, rule: { any: DECLARATION_KINDS.map((kind) => ({ kind })) } }]);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parenthesised(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

export function blockName(text: string): string {
  const structural = /^(\*[\w.-]+)\s*(?:=\s*(["'])([\s\S]*)\2)?$/.exec(text.trim());
  if (structural !== null) return collapse(`${structural[1]} ${structural[3] ?? ""}`);
  const keyword = /^@\s*(else\s+if|\w+)\s*/.exec(text);
  if (keyword === null) return collapse(text.split("{")[0] ?? text);
  const rest = keyword.index + keyword[0].length;
  const header = text[rest] === "(" ? parenthesised(text, rest) : null;
  return collapse(`@${collapse(keyword[1]!)} ${header ?? ""}`);
}

export type TemplateTargetKind = "element" | "pipe" | "identifier";

export function templateReferenceRuleText(kind: TemplateTargetKind, name: string): string {
  const exact = `^${escapeRegex(name)}$`;
  const rule: Rule =
    kind === "element"
      ? { kind: "tag_name", regex: exact, inside: { any: OPEN_TAGS } }
      : kind === "pipe"
        ? { kind: "identifier", regex: exact, inside: { field: "name", kind: "pipe_call" } }
        : { kind: "identifier", regex: exact };
  return documents([{ id: "reference", rule }]);
}

export function declaresAngularCore(packageJson: string): boolean {
  try {
    const manifest = JSON.parse(packageJson);
    return ["dependencies", "devDependencies", "peerDependencies"].some((field) => manifest?.[field]?.["@angular/core"] !== undefined);
  } catch {
    return false;
  }
}

export function packageDeclaresAngular(path: string): boolean {
  try {
    return declaresAngularCore(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function resolvesAngularCore(dir: string, root: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, "node_modules", "@angular", "core", "package.json"))) return true;
    if (current === root || dirname(current) === current) return false;
  }
}

export function selectorElements(selector: string): string[] {
  return selector
    .split(",")
    .map((part) => /^\s*([A-Za-z][\w-]*)/.exec(part)?.[1] ?? null)
    .filter((tag): tag is string => tag !== null);
}
