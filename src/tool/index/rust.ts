type Rule = Record<string, unknown>;

interface RustRule {
  id: string;
  message: string;
  rule: Rule;
}

export const RUST_DECLARATION_KINDS = [
  "function_item",
  "function_signature_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",
  "const_item",
  "static_item",
  "type_item",
  "associated_type",
  "macro_definition",
];

const ITEM_PARENT: Rule = {
  any: [{ kind: "source_file" }, { kind: "declaration_list", inside: { kind: "mod_item" } }],
};
const ASSOCIATED_PARENT: Rule = {
  kind: "declaration_list",
  inside: { any: [{ kind: "impl_item" }, { kind: "trait_item" }] },
};

function named(nameKind: string, itemKinds: string[], parent: Rule): Rule {
  return {
    kind: nameKind,
    pattern: "$N",
    inside: { field: "name", any: itemKinds.map((kind) => ({ kind })), inside: parent },
  };
}

function either(...rules: Rule[]): Rule {
  return { any: rules };
}

const OUTLINE: RustRule[] = [
  { id: "function", message: "$N", rule: named("identifier", ["function_item"], ITEM_PARENT) },
  {
    id: "method",
    message: "$N",
    rule: named("identifier", ["function_item", "function_signature_item"], ASSOCIATED_PARENT),
  },
  { id: "struct", message: "$N", rule: named("type_identifier", ["struct_item"], ITEM_PARENT) },
  { id: "enum", message: "$N", rule: named("type_identifier", ["enum_item"], ITEM_PARENT) },
  { id: "trait", message: "$N", rule: named("type_identifier", ["trait_item"], ITEM_PARENT) },
  {
    id: "impl",
    message: "impl $TRAIT for $SELF",
    rule: { kind: "impl_item", inside: ITEM_PARENT, all: [{ has: { field: "trait", pattern: "$TRAIT" } }, { has: { field: "type", pattern: "$SELF" } }] },
  },
  {
    id: "impl",
    message: "impl $SELF",
    rule: { kind: "impl_item", inside: ITEM_PARENT, has: { field: "type", pattern: "$SELF" }, not: { has: { field: "trait", regex: "" } } },
  },
  { id: "module", message: "$N", rule: named("identifier", ["mod_item"], ITEM_PARENT) },
  {
    id: "const",
    message: "$N",
    rule: either(named("identifier", ["const_item"], ITEM_PARENT), named("identifier", ["const_item"], ASSOCIATED_PARENT)),
  },
  { id: "static", message: "$N", rule: named("identifier", ["static_item"], ITEM_PARENT) },
  {
    id: "type",
    message: "$N",
    rule: either(
      named("type_identifier", ["type_item"], ITEM_PARENT),
      named("type_identifier", ["type_item", "associated_type"], ASSOCIATED_PARENT),
    ),
  },
  { id: "macro", message: "$N", rule: named("identifier", ["macro_definition"], ITEM_PARENT) },
];

export function rustRuleText(declarationId: string): string {
  const docs = [
    ...OUTLINE,
    { id: declarationId, message: "$N", rule: { any: RUST_DECLARATION_KINDS.map((kind) => ({ kind })) } },
  ];
  return docs.map((d) => JSON.stringify({ id: d.id, language: "Rust", severity: "info", message: d.message, rule: d.rule })).join("\n---\n");
}

export function rustReferenceRuleText(name: string): string {
  return JSON.stringify({
    id: "reference",
    language: "Rust",
    severity: "info",
    message: "$N",
    rule: {
      any: ["identifier", "type_identifier", "field_identifier", "shorthand_field_identifier"].map((kind) => ({ kind })),
      regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      pattern: "$N",
    },
  });
}

export function implOwner(implName: string): string {
  const forAt = implName.lastIndexOf(" for ");
  let self = forAt >= 0 ? implName.slice(forAt + 5) : implName.replace(/^impl /, "");
  self = self.replace(/^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?|dyn\s+)+/, "");
  const generic = self.indexOf("<");
  if (generic >= 0) self = self.slice(0, generic);
  return self.split("::").at(-1)!.trim();
}
