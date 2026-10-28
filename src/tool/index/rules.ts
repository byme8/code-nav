import type { Language } from "../language.ts";
import { escapeRegex } from "./declarations.ts";

export type Rule = Record<string, unknown>;
export type AgLanguage = "CSharp" | "TypeScript" | "Tsx";

const TOP_LEVEL: Rule = {
  any: [{ inside: { kind: "program" } }, { inside: { kind: "export_statement", inside: { kind: "program" } } }],
};
const FUNCTION_VALUE: Rule = { any: [{ kind: "arrow_function" }, { kind: "function_expression" }] };

export interface RuleDoc {
  id: string;
  language: AgLanguage;
  rule: Rule;
}

export function ruleText(docs: RuleDoc[]): string {
  return docs
    .map((d) =>
      JSON.stringify({
        id: d.id,
        language: d.language,
        severity: "info",
        message: "$N",
        ...(d.language === "CSharp" ? {} : { utils: { "top-level": TOP_LEVEL } }),
        rule: d.rule,
      }),
    )
    .join("\n---\n");
}

function languagesOf(language: Language): AgLanguage[] {
  return language === "csharp" ? ["CSharp"] : ["TypeScript", "Tsx"];
}

function nameIn(kind: string, inside: Rule): Rule {
  return { kind, pattern: "$N", inside: { field: "name", ...inside } };
}

const CS_OUTLINE: Record<string, Rule> = {
  class: nameIn("identifier", { kind: "class_declaration" }),
  record: nameIn("identifier", { kind: "record_declaration" }),
  struct: nameIn("identifier", { kind: "struct_declaration" }),
  interface: nameIn("identifier", { kind: "interface_declaration" }),
  enum: nameIn("identifier", { kind: "enum_declaration" }),
  constructor: nameIn("identifier", { kind: "constructor_declaration" }),
  method: nameIn("identifier", { kind: "method_declaration" }),
  property: {
    kind: "identifier",
    pattern: "$N",
    any: [
      { inside: { field: "name", kind: "property_declaration" } },
      {
        inside: {
          field: "name",
          kind: "parameter",
          inside: { kind: "parameter_list", inside: { kind: "record_declaration" } },
        },
      },
    ],
  },
  field: nameIn("identifier", {
    kind: "variable_declarator",
    inside: { kind: "variable_declaration", inside: { kind: "field_declaration" } },
  }),
};

function tsOutline(tsx: boolean): Record<string, Rule> {
  const functionCases: Rule = {
    any: [
      { inside: { field: "name", kind: "function_declaration", matches: "top-level" } },
      {
        inside: {
          field: "name",
          kind: "variable_declarator",
          has: { field: "value", ...FUNCTION_VALUE },
          inside: { any: [{ kind: "lexical_declaration" }, { kind: "variable_declaration" }], matches: "top-level" },
        },
      },
    ],
  };
  const rules: Record<string, Rule> = {
    function: tsx
      ? { kind: "identifier", pattern: "$N", all: [functionCases], not: { regex: "^[A-Z]" } }
      : { kind: "identifier", pattern: "$N", all: [functionCases] },
    constant: nameIn("identifier", {
      kind: "variable_declarator",
      not: { has: { field: "value", ...FUNCTION_VALUE } },
      inside: { kind: "lexical_declaration", matches: "top-level" },
    }),
    class: nameIn("type_identifier", { any: [{ kind: "class_declaration" }, { kind: "abstract_class_declaration" }] }),
    method: nameIn("property_identifier", {
      any: [{ kind: "method_definition" }, { kind: "abstract_method_signature" }],
      inside: { kind: "class_body" },
    }),
    property: {
      any: [{ kind: "property_identifier" }, { kind: "private_property_identifier" }],
      pattern: "$N",
      inside: { field: "name", kind: "public_field_definition", inside: { kind: "class_body" } },
    },
    type: nameIn("type_identifier", { kind: "type_alias_declaration" }),
    interface: nameIn("type_identifier", { kind: "interface_declaration" }),
    enum: nameIn("identifier", { kind: "enum_declaration" }),
  };
  if (tsx) rules.component = { kind: "identifier", pattern: "$N", all: [functionCases], regex: "^[A-Z]" };
  return rules;
}

export function outlineRules(language: Language): RuleDoc[] {
  if (language === "csharp") return Object.entries(CS_OUTLINE).map(([id, rule]) => ({ id, language: "CSharp", rule }));
  return (["TypeScript", "Tsx"] as const).flatMap((lang) =>
    Object.entries(tsOutline(lang === "Tsx")).map(([id, rule]) => ({ id, language: lang, rule })),
  );
}

function exactName(name: string): string {
  return `^${escapeRegex(name)}$`;
}

export function declarationKinds(language: AgLanguage): string[] {
  return language === "CSharp"
    ? [
        "class_declaration",
        "record_declaration",
        "struct_declaration",
        "interface_declaration",
        "enum_declaration",
        "constructor_declaration",
        "method_declaration",
        "property_declaration",
      ]
    : [
        "function_declaration",
        "class_declaration",
        "abstract_class_declaration",
        "method_definition",
        "abstract_method_signature",
        "public_field_definition",
        "type_alias_declaration",
        "interface_declaration",
        "enum_declaration",
      ];
}

function referenceKinds(language: AgLanguage): Rule[] {
  const kinds =
    language === "CSharp"
      ? ["identifier"]
      : [
          "identifier",
          "property_identifier",
          "type_identifier",
          "shorthand_property_identifier",
          "shorthand_property_identifier_pattern",
        ];
  return kinds.map((kind) => ({ kind }));
}

export function referenceRules(language: Language, name: string): RuleDoc[] {
  return languagesOf(language).map((lang) => ({
    id: "reference",
    language: lang,
    rule: { any: referenceKinds(lang), regex: exactName(name), pattern: "$N" },
  }));
}
