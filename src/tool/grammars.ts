import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANGULAR_LIBRARY_FILE } from "./index/angular.ts";
import { SCSS_LIBRARY_FILE } from "./index/scss.ts";
import { defaultGrammarDir, prebuiltGrammarDir, WGSL_LIBRARY_FILE } from "./index/wgsl.ts";
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

export interface Target {
  platform: string;
  extension: string;
  compiler: string[];
}

export const PREBUILT_TARGETS: readonly Target[] = [
  { platform: "darwin", extension: "dylib", compiler: ["clang", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-fPIC"] },
  { platform: "linux-x64", extension: "so", compiler: ["zig", "cc", "-target", "x86_64-linux-gnu.2.17", "-fPIC", "-s"] },
  { platform: "linux-arm64", extension: "so", compiler: ["zig", "cc", "-target", "aarch64-linux-gnu.2.17", "-fPIC", "-s"] },
  { platform: "win32-x64", extension: "dll", compiler: ["zig", "cc", "-target", "x86_64-windows-gnu"] },
  { platform: "win32-arm64", extension: "dll", compiler: ["zig", "cc", "-target", "aarch64-windows-gnu"] },
];

const HOST_COMPILER = ["clang", ...(IS_WINDOWS ? [] : ["-fPIC"])];

function withGrammarSource<T>(grammar: Grammar, build: (source: string, work: string) => T): T {
  const work = mkdtempSync(join(tmpdir(), `code-nav-${grammar.name}-`));
  try {
    const source = join(work, grammar.name);
    run(["git", "-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", `--revision=${grammar.commit}`, grammar.repository, source], work);
    const head = run(["git", "rev-parse", "HEAD"], source);
    if (head !== grammar.commit) throw new Error(`${grammar.name}: HEAD is ${head}, expected ${grammar.commit}`);
    return build(source, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function compile(source: string, work: string, compiler: string[], file: string, outDir: string): string {
  const sources = ["src/parser.c", ...(existsSync(join(source, "src", "scanner.c")) ? ["src/scanner.c"] : [])];
  const built = join(work, file);
  run([...compiler, "-shared", "-O2", "-I", "src", "-o", built, ...sources], source);
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, file);
  renameSync(built, target);
  return target;
}

export function buildGrammar(grammar: Grammar, outDir: string = defaultGrammarDir()): string {
  return withGrammarSource(grammar, (source, work) => compile(source, work, HOST_COMPILER, grammar.libraryFile, outDir));
}

export function buildPrebuilt(grammar: Grammar): string[] {
  const stem = grammar.libraryFile.slice(0, grammar.libraryFile.lastIndexOf("."));
  return withGrammarSource(grammar, (source, work) =>
    PREBUILT_TARGETS.map((target) =>
      compile(source, work, target.compiler, `${stem}.${target.extension}`, prebuiltGrammarDir(target.platform)),
    ),
  );
}

export async function buildAllGrammars(out: (line: string) => void): Promise<void> {
  for (const grammar of GRAMMARS) {
    out(`${grammar.name} ${grammar.commit} built: ${await describe(buildGrammar(grammar))}`);
  }
}

async function describe(library: string): Promise<string> {
  const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(library).arrayBuffer()).digest("hex");
  return `${library} (${statSync(library).size} bytes, sha256 ${sha256})`;
}

if (import.meta.main) {
  const prebuilt = process.argv[2] === "--prebuilt";
  if (process.argv.length > (prebuilt ? 3 : 2)) {
    console.error("usage: bun src/tool/grammars.ts [--prebuilt]");
    process.exit(2);
  }
  try {
    if (!prebuilt) await buildAllGrammars(console.log);
    else
      for (const grammar of GRAMMARS) {
        for (const library of buildPrebuilt(grammar)) console.log(`${grammar.name} ${grammar.commit} built: ${await describe(library)}`);
      }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
