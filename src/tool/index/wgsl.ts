import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare const CODE_NAV_GRAMMAR_DIR: string | undefined;

export const WGSL_LIBRARY_FILE = process.platform === "darwin" ? "wgsl.dylib" : process.platform === "win32" ? "wgsl.dll" : "wgsl.so";
export const WGSL_GRAMMAR_ENV = "CODE_NAV_WGSL_GRAMMAR";
export const WGSL_BUILD_COMMAND = "bun src/tool/grammars.ts";
const AG_LANGUAGE = "wgsl";

type Rule = Record<string, unknown>;

export function defaultGrammarDir(): string {
  return typeof CODE_NAV_GRAMMAR_DIR === "string" ? CODE_NAV_GRAMMAR_DIR : join(import.meta.dir, "..", "..", "..", "data", "grammars");
}

export function wgslLibraryPath(): string {
  return process.env[WGSL_GRAMMAR_ENV] || join(defaultGrammarDir(), WGSL_LIBRARY_FILE);
}

export function missingGrammarMessage(library: string, label = "WGSL", env = WGSL_GRAMMAR_ENV): string {
  return `${label} grammar not available: ${library} not found (build it with \`${WGSL_BUILD_COMMAND}\`, or set ${env})`;
}

const configs = new Map<string, string>();

export function customLanguageConfigPath(language: string, library: string, languageSymbol: string, extension: string, extra = ""): string {
  const known = configs.get(library);
  if (known !== undefined) return known;
  const dir = join(tmpdir(), "code-nav", "grammars", createHash("sha256").update(library).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sgconfig.yml");
  const partial = `${path}.${process.pid}`;
  writeFileSync(
    partial,
    `customLanguages:\n  ${language}:\n    libraryPath: ${JSON.stringify(library)}\n    languageSymbol: ${languageSymbol}\n    extensions: [${extension}]\n${extra}`,
  );
  renameSync(partial, path);
  configs.set(library, path);
  return path;
}

export function wgslConfigPath(library: string): string {
  return customLanguageConfigPath(AG_LANGUAGE, library, "tree_sitter_wgsl_bevy", "wgsl");
}

export function wgslGrammarProblem(): string | null {
  const library = wgslLibraryPath();
  return existsSync(library) ? null : missingGrammarMessage(library);
}

const TOP: Rule = {
  any: [
    { kind: "source_file" },
    {
      any: [{ kind: "preproc_ifdef" }, { kind: "preproc_else" }],
      not: { inside: { any: [{ kind: "function_declaration" }, { kind: "struct_declaration" }], stopBy: "end" } },
    },
  ],
};

function variableName(declaration: Rule): Rule {
  return { kind: "identifier", inside: { field: "name", kind: "variable_identifier_declaration", inside: declaration } };
}

function recovered(keyword: string): Rule {
  return {
    kind: "identifier",
    inside: { kind: "ERROR", inside: TOP },
    follows: { kind: "identifier", regex: `^${keyword}$` },
  };
}

const GLOBAL_VARIABLE: Rule = { kind: "variable_declaration", inside: { kind: "global_variable_declaration", inside: TOP } };
const OVERRIDE: Rule = { kind: "global_constant_declaration", inside: TOP, regex: "\\boverride\\b" };

const OUTLINE: { id: string; rule: Rule }[] = [
  { id: "fn", rule: { kind: "identifier", inside: { field: "name", kind: "function_declaration" } } },
  { id: "struct", rule: { kind: "identifier", inside: { field: "name", kind: "struct_declaration" } } },
  { id: "field", rule: variableName({ kind: "struct_member" }) },
  { id: "var", rule: { any: [variableName(GLOBAL_VARIABLE), { kind: "identifier", inside: GLOBAL_VARIABLE }] } },
  {
    id: "override",
    rule: {
      any: [
        variableName(OVERRIDE),
        {
          kind: "identifier",
          inside: OVERRIDE,
          not: { follows: { any: [{ kind: "identifier" }, { kind: "variable_identifier_declaration" }], stopBy: "end" } },
        },
      ],
    },
  },
  { id: "const", rule: recovered("const") },
  {
    id: "alias",
    rule: { any: [{ kind: "identifier", inside: { kind: "type_alias_declaration", inside: TOP } }, recovered("alias")] },
  },
];

const DECLARATION_KINDS = [
  "function_declaration",
  "struct_declaration",
  "struct_member",
  "global_variable_declaration",
  "global_constant_declaration",
  "type_alias_declaration",
];

export function wgslRuleText(declarationId: string): string {
  const declaration: Rule = { any: [...DECLARATION_KINDS.map((kind) => ({ kind })), { kind: "ERROR", inside: TOP }] };
  return [...OUTLINE, { id: declarationId, rule: declaration }]
    .map((d) => JSON.stringify({ id: d.id, language: AG_LANGUAGE, severity: "info", rule: d.rule }))
    .join("\n---\n");
}

export function addressSpaceKind(declarationText: string): string {
  const space = /\bvar\s*<\s*(\w+)/.exec(declarationText);
  return space === null ? "var" : `var<${space[1]}>`;
}
