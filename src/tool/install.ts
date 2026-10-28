import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllGrammars } from "./grammars.ts";
import { EXIT } from "./output.ts";
import {
  DEFAULT_RUST_DIST,
  LIBRARY_IN_COMPONENT,
  cacheRoot,
  cargoHome,
  rustcCommand,
  rustcVersion,
  versionDir,
} from "./rust-src.ts";

export const INSTALL_USAGE = "usage: code-nav install rust-src | grammars";
const PARTIAL = /^\.partial-(\d+)$/;

type Out = (line: string) => void;

class InstallError extends Error {}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function treeSize(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += treeSize(join(path, entry));
  return total;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function body(url: string): Promise<ReadableStream<Uint8Array>> {
  if (url.startsWith("file:")) {
    const file = Bun.file(fileURLToPath(url));
    if (!(await file.exists())) throw new InstallError(`download failed: ${url}: no such file`);
    return file.stream();
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new InstallError(`download failed: ${url}: ${(e as Error).message}`);
  }
  if (!response.ok || response.body === null) throw new InstallError(`download failed: ${url}: HTTP ${response.status}`);
  return response.body;
}

async function download(url: string, dest: string): Promise<{ bytes: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(dest).writer();
  let bytes = 0;
  try {
    for await (const chunk of await body(url)) {
      hasher.update(chunk);
      writer.write(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    await writer.end();
  }
  return { bytes, sha256: hasher.digest("hex") };
}

async function publishedSha256(url: string): Promise<string> {
  const text = await new Response(await body(url)).text();
  const hex = /^\s*([0-9a-fA-F]{64})\b/.exec(text)?.[1];
  if (hex === undefined) throw new InstallError(`no sha256 in ${url}`);
  return hex.toLowerCase();
}

function removeStalePartials(base: string): void {
  for (const entry of readdirSync(base)) {
    const pid = PARTIAL.exec(entry)?.[1];
    if (pid !== undefined && !alive(Number(pid))) rmSync(join(base, entry), { recursive: true, force: true });
  }
}

async function installSource(version: string, out: Out): Promise<string> {
  const target = versionDir(version);
  const base = join(target, "..");
  mkdirSync(base, { recursive: true });
  removeStalePartials(base);
  const partial = join(base, `.partial-${process.pid}`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial);
  const cleanUp = (): void => rmSync(partial, { recursive: true, force: true });
  const interrupted = (): never => {
    cleanUp();
    process.exit(130);
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    const dist = (process.env.CODE_NAV_RUST_DIST || DEFAULT_RUST_DIST).replace(/\/+$/, "");
    const name = `rust-src-${version}.tar.xz`;
    const url = `${dist}/${name}`;
    const archive = join(partial, name);
    out(`downloading ${url}`);
    const expected = await publishedSha256(`${url}.sha256`);
    const { bytes, sha256 } = await download(url, archive);
    if (sha256 !== expected) {
      throw new InstallError(`sha256 mismatch for ${url}: published ${expected}, downloaded ${sha256}; download deleted`);
    }
    out(`downloaded ${name} (${megabytes(bytes)}), sha256 ${sha256} verified against ${url}.sha256`);
    const extracted = join(partial, "extracted");
    mkdirSync(extracted);
    const tar = Bun.spawnSync(["tar", "-xf", archive, "-C", extracted], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    if (tar.exitCode !== 0) throw new InstallError(`extract failed: tar exited with ${tar.exitCode}: ${tar.stderr.toString().trim()}`);
    const component = join(extracted, `rust-src-${version}`);
    if (!existsSync(join(component, LIBRARY_IN_COMPONENT, "Cargo.toml"))) {
      throw new InstallError(`extract failed: ${name} has no rust-src-${version}/${LIBRARY_IN_COMPONENT}/Cargo.toml`);
    }
    renameSync(component, target);
    out(`installed rust-src ${version} at ${target} (${megabytes(treeSize(target))})`);
    return join(target, LIBRARY_IN_COMPONENT);
  } finally {
    cleanUp();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

function cargo(args: string[], quiet: boolean): { ok: boolean; detail: string } {
  const command = process.env.CARGO || "cargo";
  try {
    const proc = Bun.spawnSync([command, ...args], {
      env: { ...process.env, RUSTC_BOOTSTRAP: "1" },
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stderr = proc.stderr.toString().trim();
    if (!quiet && stderr !== "") writeSync(2, `${stderr}\n`);
    const detail = stderr.split("\n").filter((l) => /^error/.test(l)).join(" ") || stderr.split("\n").at(-1) || "";
    return { ok: proc.exitCode === 0, detail: proc.exitCode === 0 ? "" : `${command} exited with ${proc.exitCode}: ${detail}` };
  } catch (e) {
    return { ok: false, detail: `cannot run ${command}: ${(e as Error).message}` };
  }
}

function fetchDependencies(library: string, alreadyInstalled: boolean, out: Out): void {
  const manifest = join(library, "Cargo.toml");
  const home = cargoHome();
  const where = `CARGO_HOME ${home.path} (${home.fromEnv ? "from CARGO_HOME" : "default; set CARGO_HOME to change"})`;
  if (alreadyInstalled && cargo(["metadata", "--offline", "--locked", "--format-version", "1", "--manifest-path", manifest], true).ok) {
    out(`std dependencies: already in ${where}`);
    return;
  }
  out(`std dependencies: cargo fetch --locked --manifest-path ${manifest} into ${where}`);
  const fetched = cargo(["fetch", "--locked", "--manifest-path", manifest], false);
  if (fetched.ok) {
    out(`std dependencies: fetched into ${home.path}`);
  } else {
    out(`std dependencies: fetch failed (${fetched.detail}); the source install stands, but std internals may stay unresolved`);
  }
}

export async function install(args: string[], out: Out): Promise<number> {
  if (args.length === 1 && args[0] === "grammars") {
    try {
      await buildAllGrammars(out);
      out("a running daemon picks the grammars up after `code-nav stop`");
      return EXIT.success;
    } catch (e) {
      out(`error: ${(e as Error).message}`);
      return EXIT.error;
    }
  }
  if (args.length !== 1 || args[0] !== "rust-src") {
    out(`error: ${INSTALL_USAGE}`);
    return EXIT.error;
  }
  try {
    const rustc = rustcVersion(process.cwd());
    out(`${rustc.line} (${rustcCommand()}${process.env.RUSTC ? " from RUSTC" : ""})`);
    if (rustc.version.includes("-")) {
      throw new InstallError(`rust-src ${rustc.version}: only stable toolchains are published as rust-src-<version>.tar.xz`);
    }
    out(`cache: ${cacheRoot()}${process.env.CODE_NAV_CACHE ? " (CODE_NAV_CACHE)" : ""}`);
    const target = versionDir(rustc.version);
    const library = join(target, LIBRARY_IN_COMPONENT);
    const alreadyInstalled = existsSync(target);
    if (alreadyInstalled) {
      if (!existsSync(join(library, "Cargo.toml"))) {
        throw new InstallError(`${target} exists but has no ${LIBRARY_IN_COMPONENT}/Cargo.toml; remove it and rerun`);
      }
      out(`rust-src ${rustc.version} already installed at ${target}`);
    } else {
      await installSource(rustc.version, out);
    }
    fetchDependencies(library, alreadyInstalled, out);
    out(`rust-analyzer gets cargo.sysrootSrc = ${library} from its next start; a running daemon picks it up after \`code-nav stop\``);
    return EXIT.success;
  } catch (e) {
    out(`error: ${(e as Error).message}`);
    return EXIT.error;
  }
}
