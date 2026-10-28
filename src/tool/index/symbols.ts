import type { Language } from "../language.ts";
import type { FileStamp } from "./walk.ts";

export type ToolLanguage = Language | "rust" | "wgsl" | "css" | "scss" | "angular";
export type StyleLanguage = "css" | "scss";

export function isStyleLanguage(language: ToolLanguage): language is StyleLanguage {
  return language === "css" || language === "scss";
}

export interface ToolSymbol {
  kind: string;
  name: string;
  start: number;
  end: number;
  nameLine: number;
  nameColumn: number;
  container: string | null;
  depth: number;
}

export interface IndexedFile {
  path: string;
  language: ToolLanguage;
  stamp: FileStamp;
  symbols: ToolSymbol[];
}

const CONTAINER_KINDS: Record<ToolLanguage, ReadonlySet<string>> = {
  csharp: new Set(["class", "record", "struct", "interface", "enum"]),
  typescript: new Set(["class"]),
  graphql: new Set(["type", "input", "enum"]),
  rust: new Set(["impl", "trait", "module"]),
  wgsl: new Set(["struct"]),
  css: new Set(["rule", "media", "supports"]),
  scss: new Set(["rule", "placeholder", "media", "supports", "mixin", "function"]),
  angular: new Set(["element", "block"]),
};

export function isContainerKind(language: ToolLanguage, kind: string): boolean {
  return CONTAINER_KINDS[language].has(kind);
}

export function bySourceOrder(a: ToolSymbol, b: ToolSymbol): number {
  return a.nameLine - b.nameLine || a.nameColumn - b.nameColumn;
}

export interface Spanned {
  symbol: ToolSymbol;
  from: number;
  to: number;
}

export function assignContainers(
  language: ToolLanguage,
  spanned: Spanned[],
  ownerName: (container: ToolSymbol) => string = (container) => container.name,
): ToolSymbol[] {
  const containers = spanned.filter((s) => isContainerKind(language, s.symbol.kind));
  for (const s of spanned) {
    const enclosing = containers.filter((c) => c !== s && c.from <= s.from && s.to <= c.to && c.to - c.from > s.to - s.from);
    s.symbol.depth = enclosing.length;
    const nearest = enclosing.reduce<Spanned | null>((best, c) => (best === null || c.to - c.from < best.to - best.from ? c : best), null);
    s.symbol.container = nearest === null ? null : ownerName(nearest.symbol);
  }
  return spanned.map((s) => s.symbol).sort(bySourceOrder);
}
