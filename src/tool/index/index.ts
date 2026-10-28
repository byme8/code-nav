import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSyntaxFiles, parseWgslFiles } from "./astgrep.ts";
import { parseGraphql } from "./graphql.ts";
import type { IndexedFile, ToolLanguage, ToolSymbol } from "./symbols.ts";
import { fileTerms } from "./terms.ts";
import { sourceLanguage, type FileStamp } from "./walk.ts";
import { WGSL_BUILD_COMMAND, wgslGrammarProblem, wgslLibraryPath } from "./wgsl.ts";

export interface Located {
  file: IndexedFile;
  symbol: ToolSymbol;
}

export class SyntaxIndex {
  readonly files = new Map<string, IndexedFile>();
  readonly stamps = new Map<string, FileStamp>();
  private termCache = new Map<string, Map<string, number>>();

  private wgslPending = new Set<string>();
  private wgslScanError: string | null = null;

  constructor(readonly root: string) {}

  wgslProblem(): string | null {
    return wgslGrammarProblem() ?? (this.wgslPending.size > 0 ? this.wgslScanError : null);
  }

  wgslRetryDue(): boolean {
    return this.wgslPending.size > 0 && wgslGrammarProblem() === null;
  }

  private async parsePendingWgsl(): Promise<Map<string, ToolSymbol[]>> {
    if (this.wgslPending.size === 0 || wgslGrammarProblem() !== null) return new Map();
    const library = wgslLibraryPath();
    try {
      const parsed = await parseWgslFiles(this.root, [...this.wgslPending], library);
      this.wgslPending.clear();
      this.wgslScanError = null;
      return parsed;
    } catch (e) {
      this.wgslScanError = `WGSL grammar not usable: ${library}: ${(e as Error).message} (rebuild it with \`${WGSL_BUILD_COMMAND}\`)`;
      return new Map();
    }
  }

  async apply(stamps: Map<string, FileStamp>, changed: string[], deleted: string[]): Promise<void> {
    const syntax = changed.filter((p) => {
      const language = sourceLanguage(p);
      return language === "csharp" || language === "typescript" || language === "rust";
    });
    const parsed = await parseSyntaxFiles(this.root, syntax);
    for (const path of deleted) this.wgslPending.delete(path);
    for (const path of changed) if (sourceLanguage(path) === "wgsl") this.wgslPending.add(path);
    const wgsl = await this.parsePendingWgsl();
    for (const [path, symbols] of wgsl) {
      parsed.set(path, symbols);
      const file = this.files.get(path);
      if (file === undefined) continue;
      file.symbols = symbols;
      this.termCache.delete(path);
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
