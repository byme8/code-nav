import { escapeRegex } from "./declarations.ts";

type Rule = Record<string, unknown>;
export type StyleAgLanguage = "Css" | "scss";

const STATEMENT_KINDS = [
  "rule_set",
  "media_statement",
  "supports_statement",
  "keyframes_statement",
  "at_rule",
  "import_statement",
  "declaration",
];
const SCSS_STATEMENT_KINDS = ["mixin_statement", "function_statement", "use_statement", "forward_statement"];

function outline(language: StyleAgLanguage): { id: string; rule: Rule }[] {
  const rules: { id: string; rule: Rule }[] = [
    { id: "rule", rule: { kind: "selectors", inside: { kind: "rule_set" } } },
    { id: "custom-property", rule: { kind: "property_name", regex: "^--", inside: { kind: "declaration" } } },
    { id: "keyframes", rule: { kind: "keyframes_name", inside: { kind: "keyframes_statement" } } },
    { id: "media", rule: { kind: "media_statement" } },
    { id: "supports", rule: { kind: "supports_statement" } },
    { id: "font-face", rule: { kind: "at_rule", has: { kind: "at_keyword", regex: "^@font-face$" } } },
    { id: "import", rule: { kind: "import_statement" } },
  ];
  if (language === "scss") {
    rules.push(
      { id: "variable", rule: { kind: "property_name", regex: "^\\$", inside: { kind: "declaration" } } },
      { id: "mixin", rule: { kind: "identifier", inside: { field: "name", kind: "mixin_statement" } } },
      { id: "function", rule: { kind: "identifier", inside: { field: "name", kind: "function_statement" } } },
      { id: "use", rule: { kind: "use_statement" } },
      { id: "forward", rule: { kind: "forward_statement" } },
    );
  }
  return rules;
}

function documents(language: StyleAgLanguage, docs: { id: string; rule: Rule }[]): string {
  return docs.map((d) => JSON.stringify({ id: d.id, language, severity: "info", rule: d.rule })).join("\n---\n");
}

export function styleRuleText(language: StyleAgLanguage, declarationId: string): string {
  const kinds = language === "scss" ? [...STATEMENT_KINDS, ...SCSS_STATEMENT_KINDS] : STATEMENT_KINDS;
  return documents(language, [...outline(language), { id: declarationId, rule: { any: kinds.map((kind) => ({ kind })) } }]);
}

const PLACEHOLDER_SELECTOR = /^%[\w-]+$/;

export function styleKind(ruleId: string, name: string): string {
  return ruleId === "rule" && PLACEHOLDER_SELECTOR.test(name) ? "placeholder" : ruleId;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function header(text: string): string {
  const brace = text.indexOf("{");
  return collapse((brace < 0 ? text : text.slice(0, brace)).replace(/^@[\w-]+/, ""));
}

function target(text: string): string {
  const quoted = /url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["']/.exec(text);
  return quoted === null ? header(text.replace(/;\s*$/, "")) : (quoted[1] ?? quoted[2]!);
}

export function styleName(ruleId: string, text: string): string {
  switch (ruleId) {
    case "rule":
      return collapse(text);
    case "media":
    case "supports":
      return header(text);
    case "font-face": {
      const family = /font-family\s*:\s*([^;}]+)/.exec(text);
      return family === null ? "font-face" : collapse(family[1]!).replace(/^["']|["']$/g, "");
    }
    case "import":
    case "use":
    case "forward":
      return target(text);
    default:
      return text;
  }
}

export type StyleReferenceKind = "custom-property" | "variable" | "placeholder" | "class" | "mixin" | "function" | "keyframes";

function referenceRule(kind: StyleReferenceKind, name: string): Rule {
  const exact = `^${escapeRegex(name)}$`;
  switch (kind) {
    case "custom-property":
      return { any: [{ kind: "property_name" }, { kind: "plain_value" }, { kind: "identifier" }], regex: exact };
    case "variable":
      return { any: [{ kind: "property_name" }, { kind: "variable" }], regex: `^([A-Za-z_][\\w-]*\\.)?${escapeRegex(name)}$` };
    case "placeholder":
      return { kind: "placeholder", regex: exact };
    case "class":
      return { kind: "class_name", regex: exact, inside: { kind: "class_selector" } };
    case "mixin":
      return { kind: "identifier", regex: exact, inside: { kind: "include_statement" } };
    case "function":
      return { kind: "function_name", regex: exact };
    case "keyframes":
      return {
        kind: "plain_value",
        regex: exact,
        inside: { kind: "declaration", has: { kind: "property_name", regex: "^animation(-name)?$" } },
      };
  }
}

export function styleReferenceRuleText(language: StyleAgLanguage, kind: StyleReferenceKind, name: string): string {
  return documents(language, [{ id: "reference", rule: referenceRule(kind, name) }]);
}
