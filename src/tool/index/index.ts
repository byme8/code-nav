import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScssFiles, parseSyntaxFiles, parseWgslFiles } from "./astgrep.ts";
import { parseGraphql } from "./graphql.ts";
import { scssGrammarProblem, scssLibraryPath } from "./scss.ts";
import type { IndexedFile, ToolLanguage, ToolSymbol } from "./symbols.ts";
import { fileTerms } from "./terms.ts";
import { sourceLanguage, type FileStamp } from "./walk.ts";
import { WGSL_BUILD_COMMAND, wgslGrammarProblem, wgslLibraryPath } from "./wgsl.ts";

export interface Located {
  file: IndexedFile;
  symbol: ToolSymbol;
}

export type GrammarLanguage = "wgsl" | "scss";

interface CustomGrammar {
  label: string;
  problem: () => string | null;
  library: () => string;
  parse: (root: string, paths: string[], library: string) => Promise<Map<string, ToolSymbol[]>>;
}

const GRAMMARS: Record<GrammarLanguage, CustomGrammar> = {
  wgsl: { label: "WGSL", problem: wgslGrammarProblem, library: wgslLibraryPath, parse: parseWgslFiles },
  scss: { label: "SCSS", problem: scssGrammarProblem, library: scssLibraryPath, parse: parseScssFiles },
};

export function isGrammarLanguage(language: ToolLanguage | null): language is GrammarLanguage {
  return language === "wgsl" || language === "scss";
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
  };

  constructor(readonly root: string) {}

  grammarProblem(language: GrammarLanguage): string | null {
    return this.grammars[language].problem();
  }

  grammarRetryDue(): boolean {
    return Object.values(this.grammars).some((g) => g.retryDue());
  }

  async apply(stamps: Map<string, FileStamp>, changed: string[], deleted: string[]): Promise<void> {
    const syntax = changed.filter((p) => {
      const language = sourceLanguage(p);
      return language === "csharp" || language === "typescript" || language === "rust" || language === "css";
    });
    const parsed = await parseSyntaxFiles(this.root, syntax);
    for (const path of deleted) for (const state of Object.values(this.grammars)) state.pending.delete(path);
    for (const path of changed) {
      const language = sourceLanguage(path);
      if (isGrammarLanguage(language)) this.grammars[language].pending.add(path);
    }
    for (const state of Object.values(this.grammars)) {
      for (const [path, symbols] of await state.parsePending(this.root)) {
        parsed.set(path, symbols);
        const file = this.files.get(path);
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
