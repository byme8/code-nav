export const LANGUAGES = ["csharp", "typescript", "graphql"] as const;
export type Language = (typeof LANGUAGES)[number];

export const TRACE_ROLES = [
  "csharp-property",
  "schema-field",
  "document-selection",
  "generated-ts-member",
  "service-hook",
  "component",
] as const;
export type TraceRole = (typeof TRACE_ROLES)[number];
