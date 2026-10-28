import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const DEMO_REPOSITORY = "https://github.com/linebender/vello.git";
export const DEMO_COMMIT = "875f324f21da93019cae9e8e61d4abfd69893206";
export const DEMO_CARGO_HOME = join(import.meta.dir, "..", "..", "data", "cargo-home");

function run(command: string[], cwd: string, env: Record<string, string> = {}): string {
  const proc = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "inherit", stdin: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${proc.exitCode}`);
  return proc.stdout.toString().trim();
}

function insideTemp(path: string): boolean {
  const temp = realpathSync(tmpdir());
  const parent = realpathSync(dirname(path));
  return parent === temp || parent.startsWith(temp + sep);
}

export function prepareDemo(destArg: string): string {
  const dest = resolve(destArg);
  if (!existsSync(dirname(dest)) || !insideTemp(dest)) throw new Error(`destination must be under the OS temp directory: ${dest}`);
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`destination is not empty: ${dest}`);
  run(["git", "clone", "--quiet", "--depth", "1", `--revision=${DEMO_COMMIT}`, DEMO_REPOSITORY, dest], dirname(dest));
  const head = run(["git", "rev-parse", "HEAD"], dest);
  if (head !== DEMO_COMMIT) throw new Error(`HEAD is ${head}, expected ${DEMO_COMMIT}`);
  mkdirSync(DEMO_CARGO_HOME, { recursive: true });
  run(["cargo", "fetch", "--locked"], dest, { CARGO_HOME: DEMO_CARGO_HOME });
  return dest;
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (dest === undefined || process.argv.length > 3) {
    console.error("usage: bun src/demo/prepare.ts <dest under the OS temp directory>");
    process.exit(2);
  }
  try {
    const prepared = prepareDemo(dest);
    console.log(`vello ${DEMO_COMMIT} prepared in ${prepared}`);
    console.log(`run the tool with CARGO_HOME=${DEMO_CARGO_HOME}`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
