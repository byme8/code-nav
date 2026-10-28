import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANGULAR_LIBRARY_FILE } from "./index/angular.ts";
import { SCSS_LIBRARY_FILE } from "./index/scss.ts";
import { defaultGrammarDir, WGSL_LIBRARY_FILE } from "./index/wgsl.ts";
import { IS_WINDOWS } from "./platform.ts";

export const WGSL_GRAMMAR_REPOSITORY = "https://github.com/tree-sitter-grammars/tree-sitter-wgsl-bevy.git";
export const WGSL_GRAMMAR_COMMIT = "d9306a798ede627001a8e5752f775858c8edd7e4";
export const SCSS_GRAMMAR_REPOSITORY = "https://github.com/tree-sitter-grammars/tree-sitter-scss.git";
export const SCSS_GRAMMAR_COMMIT = "eb69c8f55ecc17235f43358c65ec644578554f92";
export const ANGULAR_GRAMMAR_REPOSITORY = "https://github.com/dlvandenberg/tree-sitter-angular.git";
export const ANGULAR_GRAMMAR_COMMIT = "1446e647e50df96f6d4b1039f121b10b5c2b2976";

export interface Grammar {
  name: string;
  repository: string;
  commit: string;
  libraryFile: string;
}

export const GRAMMARS: readonly Grammar[] = [
  { name: "tree-sitter-wgsl-bevy", repository: WGSL_GRAMMAR_REPOSITORY, commit: WGSL_GRAMMAR_COMMIT, libraryFile: WGSL_LIBRARY_FILE },
  { name: "tree-sitter-scss", repository: SCSS_GRAMMAR_REPOSITORY, commit: SCSS_GRAMMAR_COMMIT, libraryFile: SCSS_LIBRARY_FILE },
  { name: "tree-sitter-angular", repository: ANGULAR_GRAMMAR_REPOSITORY, commit: ANGULAR_GRAMMAR_COMMIT, libraryFile: ANGULAR_LIBRARY_FILE },
];

function run(command: string[], cwd: string): string {
  const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${proc.exitCode}`);
  return proc.stdout.toString().trim();
}

export function buildGrammar(grammar: Grammar, outDir: string = defaultGrammarDir()): string {
  const work = mkdtempSync(join(tmpdir(), `code-nav-${grammar.name}-`));
  try {
    const source = join(work, grammar.name);
    run(["git", "-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", `--revision=${grammar.commit}`, grammar.repository, source], work);
    const head = run(["git", "rev-parse", "HEAD"], source);
    if (head !== grammar.commit) throw new Error(`${grammar.name}: HEAD is ${head}, expected ${grammar.commit}`);
    const sources = ["src/parser.c", ...(existsSync(join(source, "src", "scanner.c")) ? ["src/scanner.c"] : [])];
    const built = join(work, grammar.libraryFile);
    run(["clang", "-shared", ...(IS_WINDOWS ? [] : ["-fPIC"]), "-O2", "-I", "src", "-o", built, ...sources], source);
    mkdirSync(outDir, { recursive: true });
    const target = join(outDir, grammar.libraryFile);
    renameSync(built, target);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error("usage: bun src/tool/grammars.ts");
    process.exit(2);
  }
  try {
    for (const grammar of GRAMMARS) {
      const library = buildGrammar(grammar);
      const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(library).arrayBuffer()).digest("hex");
      console.log(`${grammar.name} ${grammar.commit} built: ${library} (${statSync(library).size} bytes, sha256 ${sha256})`);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
