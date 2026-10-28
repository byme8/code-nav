import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "./doctor.ts";
import { LANGUAGES, LANGUAGE_LABELS, isLanguage, readSelection, writeSelection, type LanguageId } from "./languages.ts";
import { resolveExecutable, spawnArgv } from "./platform.ts";
import { installPermission, installSkill, stopAllDaemons } from "./setup.ts";
import {
  AST_GREP_ENV,
  AST_GREP_EXE,
  AST_GREP_PLATFORM,
  AST_GREP_VERSION,
  astGrepRelease,
  astGrepVersionDir,
  installedAstGrep,
  zipEntry,
} from "./ast-grep-dist.ts";
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

export const INSTALL_USAGE = "usage: code-nav install [--lang <id,…>]… [--yes] [--claude-home <dir>] | install ast-grep | rust-src | grammars";
const SETUP_USAGE = "usage: code-nav install [--lang <id,…>]… [--yes] [--claude-home <dir>]";
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

export async function installAstGrep(out: Out): Promise<string> {
  const installed = installedAstGrep();
  if (installed !== null) {
    out(`ast-grep ${AST_GREP_VERSION} already installed at ${installed}`);
    return installed;
  }
  const release = astGrepRelease();
  if (release === null) throw new InstallError(`no pinned ast-grep ${AST_GREP_VERSION} build for ${AST_GREP_PLATFORM}; set ${AST_GREP_ENV}`);
  const target = astGrepVersionDir();
  const base = join(target, "..");
  mkdirSync(base, { recursive: true });
  removeStalePartials(base);
  const partial = join(base, `.partial-${process.pid}`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial);
  try {
    out(`downloading ${release.url}`);
    const archive = join(partial, release.asset);
    const { bytes, sha256 } = await download(release.url, archive);
    if (sha256 !== release.sha256) {
      throw new InstallError(`sha256 mismatch for ${release.url}: pinned ${release.sha256}, downloaded ${sha256}; download deleted`);
    }
    out(`downloaded ${release.asset} (${megabytes(bytes)}), sha256 ${sha256} matches the pin`);
    const exe = zipEntry(new Uint8Array(await Bun.file(archive).arrayBuffer()), AST_GREP_EXE);
    if (exe === null) throw new InstallError(`extract failed: ${release.asset} has no ${AST_GREP_EXE}`);
    const staged = join(partial, AST_GREP_EXE);
    writeFileSync(staged, exe, { mode: 0o755 });
    rmSync(archive);
    renameSync(partial, target);
    const path = join(target, AST_GREP_EXE);
    out(`installed ast-grep ${AST_GREP_VERSION} at ${path}`);
    return path;
  } finally {
    rmSync(partial, { recursive: true, force: true });
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

type SetupArgs = { languages: LanguageId[] | null; yes: boolean; claudeHome: string };

function parseSetup(args: string[]): SetupArgs | string {
  const parsed: SetupArgs = { languages: null, yes: false, claudeHome: join(homedir(), ".claude") };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--claude-home" && args[i + 1]) parsed.claudeHome = resolve(args[++i]!);
    else if (arg === "--lang" && args[i + 1]) {
      const ids = args[++i]!.split(",").map((s) => s.trim()).filter((s) => s !== "");
      const all = ids.includes("all") ? [...LANGUAGES] : ids;
      const unknown = all.filter((id) => !isLanguage(id));
      if (unknown.length > 0) return `unknown language ${unknown.join(", ")}; one of ${LANGUAGES.join(", ")} or all`;
      parsed.languages = [...new Set([...(parsed.languages ?? []), ...(all as LanguageId[])])];
    } else return SETUP_USAGE;
  }
  return parsed;
}

function pickLanguages(out: Out): LanguageId[] | null {
  const current = readSelection();
  out("Which languages should code-nav support?");
  LANGUAGES.forEach((id, i) => out(`  ${i + 1}. [${current?.includes(id) ? "x" : " "}] ${LANGUAGE_LABELS[id]} (${id})`));
  for (;;) {
    const answer = prompt(`Numbers or names, comma-separated, or all${current === null ? "" : "; Enter keeps the marked ones"}:`);
    if (answer === null) return current;
    const tokens = answer.split(/[\s,]+/).filter((t) => t !== "");
    if (tokens.length === 0 && current !== null) return current;
    if (tokens.includes("all")) return [...LANGUAGES];
    const picked = tokens.map((t) => (/^\d+$/.test(t) ? LANGUAGES[Number(t) - 1] : isLanguage(t) ? t : undefined));
    if (tokens.length > 0 && picked.every((id) => id !== undefined)) return LANGUAGES.filter((id) => picked.includes(id));
    out(`not understood: ${answer}`);
  }
}

function runFix(fix: string[], out: Out): Promise<boolean> | boolean {
  if (fix[0] === "code-nav") return install(fix.slice(2), out).then((code) => code === EXIT.success);
  const command = resolveExecutable(fix[0]!);
  if (command === null) {
    out(`skipped ${fix.join(" ")}: ${fix[0]} not found on PATH`);
    return false;
  }
  const spawned = spawnArgv([command, ...fix.slice(1)]);
  const proc = Bun.spawnSync(spawned.argv, { stdio: ["inherit", "inherit", "inherit"], windowsVerbatimArguments: spawned.verbatim });
  if (proc.exitCode !== 0) out(`failed ${fix.join(" ")}: exit ${proc.exitCode}`);
  return proc.exitCode === 0;
}

async function setup(args: string[], out: Out): Promise<number> {
  const parsed = parseSetup(args);
  if (typeof parsed === "string") {
    out(`error: ${parsed}`);
    return EXIT.error;
  }
  const interactive = process.stdin.isTTY === true;
  if (parsed.languages === null && !interactive) {
    out(`error: not a terminal; pass --lang <${LANGUAGES.join("|")}|all>[,…] (and --yes to run the installers)`);
    return EXIT.error;
  }
  const languages = parsed.languages ?? pickLanguages(out);
  if (languages === null || languages.length === 0) {
    out("error: no languages selected");
    return EXIT.error;
  }
  out(`languages: ${languages.map((id) => LANGUAGE_LABELS[id]).join(", ")}`);

  if (!process.env[AST_GREP_ENV]) {
    try {
      await installAstGrep(out);
    } catch (e) {
      out(`error: ast-grep install failed (${(e as Error).message}); code-nav needs it for every command`);
      return EXIT.error;
    }
  }

  const missing = diagnose(languages).languages.flatMap((l) => l.checks.filter((c) => c.found === null));
  const fixes = [...new Map(missing.filter((c) => c.fix !== undefined).map((c) => [c.fix!.join(" "), c.fix!])).values()];
  for (const check of missing.filter((c) => c.fix === undefined)) out(`manual: ${check.what}: ${check.hint}`);
  if (fixes.length > 0) {
    out("to install:");
    for (const fix of fixes) out(`  ${fix.join(" ")}`);
    const go = parsed.yes || (interactive && /^(y|yes|)$/i.test((prompt("Run these commands? [Y/n]") ?? "n").trim()));
    if (go) {
      for (const fix of fixes) {
        out(`> ${fix.join(" ")}`);
        await runFix(fix, out);
      }
    } else out("not run; run them yourself, or rerun with --yes");
  }

  out(`selection: ${writeSelection(languages)}`);
  out(installSkill(parsed.claudeHome));
  const permission = installPermission(join(parsed.claudeHome, "settings.json"));
  out(permission.line);
  out(`daemons: ${await stopAllDaemons()} stopped`);
  const report = diagnose(languages);
  for (const language of report.languages) out(language.summary);
  return report.astGrep.found !== null && permission.ok ? EXIT.success : EXIT.error;
}

export async function install(args: string[], out: Out): Promise<number> {
  if (args.length === 0 || args[0]!.startsWith("-")) return await setup(args, out);
  if (args.length === 1 && args[0] === "ast-grep") {
    try {
      await installAstGrep(out);
      out("a running daemon picks it up after `code-nav stop`");
      return EXIT.success;
    } catch (e) {
      out(`error: ${(e as Error).message}`);
      return EXIT.error;
    }
  }
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
