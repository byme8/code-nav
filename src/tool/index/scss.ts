import { existsSync } from "node:fs";
import { customLanguageConfigPath, grammarLibraryPath, missingGrammarMessage } from "./wgsl.ts";

export const SCSS_LIBRARY_FILE = process.platform === "darwin" ? "scss.dylib" : process.platform === "win32" ? "scss.dll" : "scss.so";
export const SCSS_GRAMMAR_ENV = "CODE_NAV_SCSS_GRAMMAR";

export function scssLibraryPath(): string {
  return grammarLibraryPath(SCSS_LIBRARY_FILE, SCSS_GRAMMAR_ENV);
}

export function scssConfigPath(library: string): string {
  return customLanguageConfigPath("scss", library, "tree_sitter_scss", "scss");
}

export function scssGrammarProblem(): string | null {
  const library = scssLibraryPath();
  return existsSync(library) ? null : missingGrammarMessage(library, "SCSS", SCSS_GRAMMAR_ENV);
}
