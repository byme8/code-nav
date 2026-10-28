import type { IndexedFile, ToolLanguage, ToolSymbol } from "./symbols.ts";

export const PLACE = { fileName: 3, declaration: 2, directory: 1 } as const;
export const MEMBER_PLACE = { name: 3, owner: 2, path: 1 } as const;

const CSS_DECLARATION_KINDS: ReadonlySet<string> = new Set(["rule", "custom-property", "keyframes", "font-face"]);
const SCSS_DECLARATION_KINDS: ReadonlySet<string> = new Set([...CSS_DECLARATION_KINDS, "variable", "mixin", "function", "placeholder"]);

const FILE_LEVEL_KINDS: Record<ToolLanguage, ReadonlySet<string>> = {
  csharp: new Set(["class", "record", "struct", "interface", "enum"]),
  typescript: new Set(["function", "component", "class", "type", "interface", "enum", "constant", "selector", "pipe"]),
  graphql: new Set(["type", "input", "enum", "query", "mutation", "subscription", "fragment"]),
  rust: new Set(["struct", "enum", "trait", "function", "module", "type", "const", "static", "macro"]),
  wgsl: new Set(["fn", "struct", "var", "const", "override", "alias"]),
  css: CSS_DECLARATION_KINDS,
  scss: SCSS_DECLARATION_KINDS,
  angular: new Set(["element"]),
};

const MEMBER_KINDS: Record<ToolLanguage, ReadonlySet<string>> = {
  csharp: new Set(["method", "constructor", "property", "field"]),
  typescript: new Set(["method"]),
  graphql: new Set(["field"]),
  rust: new Set(["method"]),
  wgsl: new Set(["field"]),
  css: CSS_DECLARATION_KINDS,
  scss: SCSS_DECLARATION_KINDS,
  angular: new Set(),
};

const RUST_ASSOCIATED_KINDS: ReadonlySet<string> = new Set(["const", "type"]);

function isRustAssociated(file: IndexedFile, symbol: ToolSymbol): boolean {
  if (file.language !== "rust" || !RUST_ASSOCIATED_KINDS.has(symbol.kind)) return false;
  return file.symbols.some(
    (s) => (s.kind === "impl" || s.kind === "trait") && s !== symbol && s.start <= symbol.start && symbol.end <= s.end,
  );
}

const IRREGULAR: ReadonlyMap<string, string> = new Map([
  ["children", "child"],
  ["people", "person"],
  ["indices", "index"],
  ["matrices", "matrix"],
  ["statuses", "status"],
  ["status", "status"],
]);

function isNestedType(language: ToolLanguage, symbol: ToolSymbol): boolean {
  return language === "csharp" && FILE_LEVEL_KINDS.csharp.has(symbol.kind) && symbol.container !== null;
}

export function isFileLevel(file: IndexedFile, symbol: ToolSymbol): boolean {
  const language = file.language;
  const kind = language === "wgsl" ? symbol.kind.replace(/<.*$/, "") : symbol.kind;
  return FILE_LEVEL_KINDS[language].has(kind) && !isNestedType(language, symbol) && !isRustAssociated(file, symbol);
}

export function isMember(file: IndexedFile, symbol: ToolSymbol): boolean {
  const language = file.language;
  return MEMBER_KINDS[language].has(symbol.kind) || isNestedType(language, symbol) || isRustAssociated(file, symbol);
}

export function splitWords(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [])
    .map((w) => w.toLowerCase());
}

function cut(word: string, suffix: string, replacement = ""): string | null {
  if (!word.endsWith(suffix)) return null;
  const out = word.slice(0, word.length - suffix.length) + replacement;
  return out.length >= 3 ? out : null;
}

export function stem(word: string): string {
  const irregular = IRREGULAR.get(word);
  if (irregular !== undefined) return irregular;
  let w = word;
  w = cut(w, "ies", "y") ?? cut(w, "sses", "ss") ?? (w.endsWith("ss") ? w : cut(w, "s")) ?? w;
  w = cut(w, "ing") ?? cut(w, "ed") ?? w;
  w = cut(w, "e") ?? w;
  return w;
}

export function termsOf(text: string): string[] {
  return splitWords(text).map(stem);
}

export type Terms = Map<string, number>;

export function putTerms(out: Terms, text: string, place: number): void {
  for (const term of termsOf(text)) {
    if ((out.get(term) ?? 0) < place) out.set(term, place);
  }
}

export function fileTerms(file: IndexedFile): Terms {
  const out: Terms = new Map();
  const segments = file.path.split("/");
  putTerms(out, segments.at(-1)!, PLACE.fileName);
  for (const dir of segments.slice(0, -1)) putTerms(out, dir, PLACE.directory);
  for (const s of file.symbols) if (isFileLevel(file, s)) putTerms(out, s.name, PLACE.declaration);
  return out;
}

export interface MemberUnit {
  file: IndexedFile;
  symbol: ToolSymbol;
  terms: Terms;
}

export function memberUnits(file: IndexedFile): MemberUnit[] {
  const pathTerms: Terms = new Map();
  for (const segment of file.path.split("/")) putTerms(pathTerms, segment, MEMBER_PLACE.path);
  const out: MemberUnit[] = [];
  for (const symbol of file.symbols) {
    if (!isMember(file, symbol)) continue;
    const terms: Terms = new Map(pathTerms);
    if (symbol.container !== null) putTerms(terms, symbol.container, MEMBER_PLACE.owner);
    putTerms(terms, symbol.name, MEMBER_PLACE.name);
    out.push({ file, symbol, terms });
  }
  return out;
}
