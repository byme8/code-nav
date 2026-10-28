import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_RUST_DIST = "https://static.rust-lang.org/dist";
export const LIBRARY_IN_COMPONENT = "rust-src/lib/rustlib/src/rust/library";
export const INSTALL_COMMAND = "code-nav install rust-src";

type Env = Record<string, string | undefined>;

export function cacheRoot(env: Env = process.env): string {
  if (env.CODE_NAV_CACHE) return resolve(env.CODE_NAV_CACHE);
  if (env.XDG_CACHE_HOME) return join(resolve(env.XDG_CACHE_HOME), "code-nav");
  return join(homedir(), ".cache", "code-nav");
}

export function cargoHome(env: Env = process.env): { path: string; fromEnv: boolean } {
  return env.CARGO_HOME ? { path: resolve(env.CARGO_HOME), fromEnv: true } : { path: join(homedir(), ".cargo"), fromEnv: false };
}

export function rustcCommand(env: Env = process.env): string {
  return env.RUSTC || "rustc";
}

export function rustcVersion(cwd: string, env: Env = process.env): { version: string; line: string } {
  const command = rustcCommand(env);
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([command, "--version"], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    throw new Error(`cannot run ${command} --version: ${(e as Error).message}`);
  }
  const line = String(proc.stdout ?? "").trim();
  if (proc.exitCode !== 0) throw new Error(`${command} --version exited with ${proc.exitCode}: ${String(proc.stderr ?? "").trim()}`);
  const match = /^rustc (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(line);
  if (match === null) throw new Error(`cannot read the version from ${command} --version: ${line}`);
  return { version: match[1]!, line };
}

export function versionDir(version: string, env: Env = process.env): string {
  return join(cacheRoot(env), "rust-src", version);
}

export function installedLibrary(version: string, env: Env = process.env): string | null {
  const library = join(versionDir(version, env), LIBRARY_IN_COMPONENT);
  return existsSync(join(library, "Cargo.toml")) ? library : null;
}

export function sysrootSource(cwd: string, env: Env = process.env): { path: string; from: string } | null {
  if (env.CODE_NAV_RUST_SRC) return { path: resolve(env.CODE_NAV_RUST_SRC), from: "CODE_NAV_RUST_SRC" };
  let version: string;
  try {
    version = rustcVersion(cwd, env).version;
  } catch {
    return null;
  }
  const library = installedLibrary(version, env);
  return library === null ? null : { path: library, from: `the code-nav cache (rustc ${version})` };
}

const SOURCE_MISSING = /can't load standard library|can't find standard library sources|is missing a `core` library/;
const DEPENDENCIES_MISSING = /Failed to read Cargo metadata with dependencies for sysroot/;

export function stdProblem(statusMessage: string, env: Env = process.env): string | null {
  if (SOURCE_MISSING.test(statusMessage)) return "standard-library source not installed";
  if (DEPENDENCIES_MISSING.test(statusMessage)) {
    return `the standard library's crate dependencies are not in CARGO_HOME ${cargoHome(env).path}`;
  }
  return null;
}

export function stdNote(problem: string): string {
  return `note: std not available to rust-analyzer (${problem}); run \`${INSTALL_COMMAND}\``;
}
