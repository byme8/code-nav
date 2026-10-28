import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMPLATE_KINDS, angularGrammarProblem, angularLibraryPath, packageDeclaresAngular } from "./angular.ts";
import { parseAngularFiles, parseScssFiles, parseSyntaxFiles, parseWgslFiles } from "./astgrep.ts";
import { parseGraphql } from "./graphql.ts";
import { scssGrammarProblem, scssLibraryPath } from "./scss.ts";
import { bySourceOrder, type IndexedFile, type ToolLanguage, type ToolSymbol } from "./symbols.ts";
import { fileTerms } from "./terms.ts";
import { sourceLanguage, type FileStamp } from "./walk.ts";
import { WGSL_BUILD_COMMAND, wgslGrammarProblem, wgslLibraryPath } from "./wgsl.ts";

export interface Located {
  file: IndexedFile;
  symbol: ToolSymbol;
}

export type GrammarLanguage = "wgsl" | "scss" | "angular";

function isPackageJson(path: string): boolean {
  return path === "package.json" || path.endsWith("/package.json");
}

function packageDir(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "" : dir;
}

function mergeTemplate(symbols: ToolSymbol[], template: ToolSymbol[]): ToolSymbol[] {
  return [...symbols.filter((s) => !TEMPLATE_KINDS.has(s.kind)), ...template].sort(bySourceOrder);
}

interface CustomGrammar {
  label: string;
  problem: () => string | null;
  library: () => string;
  parse: (root: string, paths: string[], library: string) => Promise<Map<string, ToolSymbol[]>>;
}

const GRAMMARS: Record<GrammarLanguage, CustomGrammar> = {
  wgsl: { label: "WGSL", problem: wgslGrammarProblem, library: wgslLibraryPath, parse: parseWgslFiles },
  scss: { label: "SCSS", problem: scssGrammarProblem, library: scssLibraryPath, parse: parseScssFiles },
  angular: { label: "Angular", problem: angularGrammarProblem, library: angularLibraryPath, parse: parseAngularFiles },
};

export function isGrammarLanguage(language: ToolLanguage | null): language is GrammarLanguage {
  return language === "wgsl" || language === "scss" || language === "angular";
}

class GrammarState {
  readonly pending = new Set<string>();
  scanError: string | null = null;

  constructor(readonly grammar: CustomGrammar) {}

  problem(): string | null {
    return this.grammar.problem() ?? (this.pending.size > 0 ? this.scanError : null);
  }

  retryDue(): boolean {
    return this.pending.size > 0 && this.grammar.problem() === null;
  }

  async parsePending(root: string): Promise<Map<string, ToolSymbol[]>> {
    if (this.pending.size === 0 || this.grammar.problem() !== null) return new Map();
    const library = this.grammar.library();
    try {
      const parsed = await this.grammar.parse(root, [...this.pending], library);
      this.pending.clear();
      this.scanError = null;
      return parsed;
    } catch (e) {
      this.scanError = `${this.grammar.label} grammar not usable: ${library}: ${(e as Error).message} (rebuild it with \`${WGSL_BUILD_COMMAND}\`)`;
      return new Map();
    }
  }
}

export class SyntaxIndex {
  readonly files = new Map<string, IndexedFile>();
  readonly stamps = new Map<string, FileStamp>();
  private termCache = new Map<string, Map<string, number>>();

  private grammars: Record<GrammarLanguage, GrammarState> = {
    wgsl: new GrammarState(GRAMMARS.wgsl),
    scss: new GrammarState(GRAMMARS.scss),
    angular: new GrammarState(GRAMMARS.angular),
  };
  private packageDirs: string[] = [];
  private angularPackages = new Set<string>();

  constructor(readonly root: string) {}

  isAngularTemplate(path: string): boolean {
    let nearest: string | null = null;
    for (const dir of this.packageDirs) {
      if ((dir === "" || path.startsWith(`${dir}/`)) && (nearest === null || dir.length > nearest.length)) nearest = dir;
    }
    return nearest !== null && this.angularPackages.has(nearest);
  }

  private classifyPackages(stamps: Map<string, FileStamp>, changed: string[]): string[] {
    const packages = [...stamps.keys()].filter(isPackageJson);
    this.packageDirs = packages.map(packageDir);
    this.angularPackages = new Set(packages.filter((p) => packageDeclaresAngular(join(this.root, p))).map(packageDir));
    const listed = new Set(changed);
    const reclassified = [...stamps.keys()].filter(
      (p) => sourceLanguage(p) === "angular" && !listed.has(p) && this.files.has(p) !== this.isAngularTemplate(p),
    );
    return [...changed, ...reclassified];
  }

  grammarProblem(language: GrammarLanguage): string | null {
    return this.grammars[language].problem();
  }

  grammarRetryDue(): boolean {
    return Object.values(this.grammars).some((g) => g.retryDue());
  }

  async apply(stamps: Map<string, FileStamp>, changedPaths: string[], deleted: string[]): Promise<void> {
    const changed = [...changedPaths, ...deleted].some(isPackageJson) ? this.classifyPackages(stamps, changedPaths) : changedPaths;
    const syntax = changed.filter((p) => {
      const language = sourceLanguage(p);
      return language === "csharp" || language === "typescript" || language === "rust" || language === "css";
    });
    const parsed = await parseSyntaxFiles(this.root, syntax);
    for (const path of deleted) for (const state of Object.values(this.grammars)) state.pending.delete(path);
    for (const path of changed) {
      const language = sourceLanguage(path);
      if (language === "angular" && !this.isAngularTemplate(path)) this.grammars.angular.pending.delete(path);
      else if (isGrammarLanguage(language)) this.grammars[language].pending.add(path);
      else if (language === "typescript") {
        if ((parsed.get(path) ?? []).some((s) => s.kind === "template")) this.grammars.angular.pending.add(path);
        else this.grammars.angular.pending.delete(path);
      }
    }
    for (const state of Object.values(this.grammars)) {
      for (const [path, parsedSymbols] of await state.parsePending(this.root)) {
        const inline = sourceLanguage(path) === "typescript";
        const file = this.files.get(path);
        const host = parsed.get(path) ?? file?.symbols;
        const symbols = inline ? mergeTemplate(host ?? [], parsedSymbols) : parsedSymbols;
        parsed.set(path, symbols);
        if (file === undefined) continue;
        file.symbols = symbols;
        this.termCache.delete(path);
      }
    }
    const graphql = new Map<string, ToolSymbol[]>();
    for (const path of changed) {
      if (sourceLanguage(path) === "graphql") graphql.set(path, parseGraphql(path, readFileSync(join(this.root, path), "utf8")));
    }
    for (const path of deleted) {
      this.files.delete(path);
      this.stamps.delete(path);
      this.termCache.delete(path);
    }
    for (const path of changed) {
      const stamp = stamps.get(path)!;
      this.stamps.set(path, stamp);
      const language = sourceLanguage(path);
      if (language === null) continue;
      if (language === "angular" && !this.isAngularTemplate(path)) {
        this.files.delete(path);
        this.termCache.delete(path);
        continue;
      }
      const symbols = (language === "graphql" ? graphql.get(path) : parsed.get(path)) ?? [];
      this.files.set(path, { path, language, stamp, symbols });
      this.termCache.delete(path);
    }
  }

  filesOf(languages: ReadonlySet<ToolLanguage>): IndexedFile[] {
    return [...this.files.values()].filter((f) => languages.has(f.language));
  }

  terms(file: IndexedFile): Map<string, number> {
    let terms = this.termCache.get(file.path);
    if (terms === undefined) {
      terms = fileTerms(file);
      this.termCache.set(file.path, terms);
    }
    return terms;
  }

  symbolsNamed(name: string, owner: string | null): Located[] {
    const out: Located[] = [];
    for (const file of this.files.values()) {
      for (const symbol of file.symbols) {
        if (symbol.name === name && (owner === null || symbol.container === owner)) out.push({ file, symbol });
      }
    }
    return out;
  }
}
