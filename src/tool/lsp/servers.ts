import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveExecutable, spawnArgv } from "../platform.ts";

export const CSHARP_LS = join(homedir(), ".dotnet", "tools", "csharp-ls");
export const TYPESCRIPT_LS = "typescript-language-server";
export const RUST_ANALYZER = "rust-analyzer";

export type ServerId = "csharp" | "typescript" | "rust";

export const SERVER_COMMANDS: Record<ServerId, { name: string; command: string; env: string }> = {
  csharp: { name: "csharp-ls", command: CSHARP_LS, env: "CODE_NAV_CSHARP_LS" },
  typescript: { name: "typescript-language-server", command: TYPESCRIPT_LS, env: "CODE_NAV_TYPESCRIPT_LS" },
  rust: { name: "rust-analyzer", command: RUST_ANALYZER, env: "CODE_NAV_RUST_ANALYZER" },};

export function serverCommand(id: ServerId): string {
  const override = process.env[SERVER_COMMANDS[id].env];
  return override !== undefined && override !== "" ? override : SERVER_COMMANDS[id].command;
}

export const ANGULAR_LS_NAME = "angular-language-server";
export const ANGULAR_LS_PACKAGE = "@angular/language-server";
export const ANGULAR_LS_ENV = "CODE_NAV_ANGULAR_LS";
export const ANGULAR_LS_HINT = `npm i -g ${ANGULAR_LS_PACKAGE}`;

export interface AngularPackage {
  dir: string;
  script: string;
  version: string;
  engines: string | null;
  from: string;
}

export interface NodeRuntime {
  path: string;
  version: string;
}

let npmRoot: string | null | undefined;

function npmGlobalRoot(): string | null {
  if (npmRoot !== undefined) return npmRoot;
  npmRoot = null;
  const npm = resolveExecutable("npm");
  if (npm === null) return npmRoot;
  try {
    const proc = Bun.spawnSync(spawnArgv([npm, "root", "-g"]).argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
    const out = proc.stdout.toString().trim();
    if (proc.exitCode === 0 && out !== "") npmRoot = out;
  } catch {}
  return npmRoot;
}

function packageAt(dir: string, from: string): AngularPackage | null {
  const script = join(dir, "index.js");
  if (!existsSync(script)) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { dir, script, version: String(manifest.version ?? "?"), engines: manifest.engines?.node ?? null, from };
  } catch {
    return { dir, script, version: "?", engines: null, from };
  }
}

export function angularPackage(): AngularPackage | string {
  const override = process.env[ANGULAR_LS_ENV];
  if (override !== undefined && override !== "") {
    const dir = existsSync(override) && statSync(override).isFile() ? dirname(override) : override;
    return packageAt(dir, ANGULAR_LS_ENV) ?? `${ANGULAR_LS_ENV}=${override} has no index.js`;
  }
  const root = npmGlobalRoot();
  if (root === null) return `npm not found, so no global ${ANGULAR_LS_PACKAGE}`;
  return packageAt(join(root, ...ANGULAR_LS_PACKAGE.split("/")), "npm root -g") ?? `${ANGULAR_LS_PACKAGE} not in ${root}`;
}

export function nodeRuntime(): NodeRuntime | null {
  const path = resolveExecutable("node");
  if (path === null) return null;
  try {
    const proc = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
    return proc.exitCode === 0 ? { path, version: proc.stdout.toString().trim().replace(/^v/, "") } : null;
  } catch {
    return null;
  }
}

function parts(version: string): number[] {
  return version.split(/[.-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function satisfiesOne(version: number[], range: string): boolean {
  const m = /^(\^|~|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(range.trim());
  if (m === null) return true;
  const base = parts(m[2]!);
  const c = compare(version, base);
  switch (m[1]) {
    case "^":
      return c >= 0 && version[0] === base[0];
    case "~":
      return c >= 0 && version[0] === base[0] && version[1] === base[1];
    case ">=":
      return c >= 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    default:
      return c === 0 || m[2]!.split(".").length < 3;
  }
}

export function satisfiesEngines(version: string, engines: string | null): boolean {
  if (engines === null || engines.trim() === "") return true;
  const v = parts(version);
  return engines.split("||").some((alternative) => alternative.trim().split(/\s+/).every((range) => satisfiesOne(v, range)));
}

export interface AngularLaunch {
  node: string;
  script: string;
  packageDir: string;
}

export function angularLaunch(): AngularLaunch | string {
  const pkg = angularPackage();
  if (typeof pkg === "string") return pkg;
  const node = nodeRuntime();
  if (node === null) return "node not found on PATH";
  if (!satisfiesEngines(node.version, pkg.engines)) return `node ${node.version} does not satisfy ${ANGULAR_LS_PACKAGE} ${pkg.version} engines ${pkg.engines}`;
  return { node: node.path, script: pkg.script, packageDir: pkg.dir };
}
