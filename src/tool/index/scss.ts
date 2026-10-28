import { join } from "node:path";
import { defaultGrammarDir } from "./wgsl.ts";

export const SCSS_LIBRARY_FILE = process.platform === "darwin" ? "scss.dylib" : process.platform === "win32" ? "scss.dll" : "scss.so";
export const SCSS_GRAMMAR_ENV = "CODE_NAV_SCSS_GRAMMAR";

export function scssLibraryPath(): string {
  return process.env[SCSS_GRAMMAR_ENV] || join(defaultGrammarDir(), SCSS_LIBRARY_FILE);
}
