import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGrammarDir, WGSL_LIBRARY_FILE } from "./index/wgsl.ts";

export const WGSL_GRAMMAR_REPOSITORY = "https://github.com/tree-sitter-grammars/tree-sitter-wgsl-bevy.git";
export const WGSL_GRAMMAR_COMMIT = "d9306a798ede627001a8e5752f775858c8edd7e4";

function run(command: string[], cwd: string): string {
  const proc = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${proc.exitCode}`);
  return proc.stdout.toString().trim();
}

export function buildWgslGrammar(outDir: string = defaultGrammarDir()): string {
  const work = mkdtempSync(join(tmpdir(), "code-nav-wgsl-grammar-"));
  try {
    const source = join(work, "tree-sitter-wgsl-bevy");
    run(["git", "-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", `--revision=${WGSL_GRAMMAR_COMMIT}`, WGSL_GRAMMAR_REPOSITORY, source], work);
    const head = run(["git", "rev-parse", "HEAD"], source);
    if (head !== WGSL_GRAMMAR_COMMIT) throw new Error(`HEAD is ${head}, expected ${WGSL_GRAMMAR_COMMIT}`);
    const sources = ["src/parser.c", ...(existsSync(join(source, "src", "scanner.c")) ? ["src/scanner.c"] : [])];
    const built = join(work, WGSL_LIBRARY_FILE);
    run(["clang", "-shared", "-fPIC", "-O2", "-I", "src", "-o", built, ...sources], source);
    mkdirSync(outDir, { recursive: true });
    const target = join(outDir, WGSL_LIBRARY_FILE);
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
    const library = buildWgslGrammar();
    const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(library).arrayBuffer()).digest("hex");
    console.log(`tree-sitter-wgsl-bevy ${WGSL_GRAMMAR_COMMIT} built: ${library} (${statSync(library).size} bytes, sha256 ${sha256})`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
