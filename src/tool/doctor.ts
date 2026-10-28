import { existsSync } from "node:fs";
import { join } from "node:path";
import { AST_GREP_ENV, AST_GREP_INSTALL_COMMAND, astGrepRelease } from "./ast-grep-dist.ts";
import { astGrepExecutable } from "./index/astgrep.ts";
import { LANGUAGE_LABELS, readSelection, selectedLanguages, selectionPath, type LanguageId } from "./languages.ts";
import { SCSS_GRAMMAR_ENV, scssLibraryPath } from "./index/scss.ts";
import { PREBUILT_PLATFORM, WGSL_GRAMMAR_ENV, prebuiltGrammarDir, wgslLibraryPath } from "./index/wgsl.ts";
import { ANGULAR_GRAMMAR_ENV, angularLibraryPath } from "./index/angular.ts";
import {
  ANGULAR_LS_HINT,
  ANGULAR_LS_PACKAGE,
  SERVER_COMMANDS,
  angularPackage,
  nodeRuntime,
  satisfiesEngines,
  serverCommand,
  type ServerId,
} from "./lsp/servers.ts";
import { EXIT } from "./output.ts";
import { IS_WINDOWS, resolveExecutable } from "./platform.ts";
import { INSTALL_COMMAND, rustcCommand, sysrootSource } from "./rust-src.ts";

type Role = "syntax" | "lsp" | "extra";

export interface Check {
  what: string;
  role: Role;
  found: string | null;
  hint: string;
  fix?: string[];
}

export interface LanguageReport {
  id: LanguageId;
  language: string;
  checks: Check[];
  summary: string;
}

export interface DoctorReport {
  astGrep: Check;
  languages: LanguageReport[];
}

const IS_MAC = process.platform === "darwin";

function astGrepHint(): string {
  return astGrepRelease() === null ? `install ast-grep and set ${AST_GREP_ENV}` : AST_GREP_INSTALL_COMMAND;
}

const SERVER_FIXES: Record<ServerId, string[]> = {
  csharp: ["dotnet", "tool", "install", "-g", "csharp-ls"],
  typescript: ["npm", "i", "-g", "typescript-language-server", "typescript"],
  rust: ["rustup", "component", "add", "rust-analyzer"],
};
const GRAMMARS_FIX = ["code-nav", "install", "grammars"];
const RUST_SRC_FIX = ["code-nav", "install", "rust-src"];
const ANGULAR_LS_FIX = ["npm", "i", "-g", ANGULAR_LS_PACKAGE];

const DOTNET_HINT = "install the .NET SDK (https://dotnet.microsoft.com/download)";
const CARGO_HINT = IS_MAC ? "install Rust with rustup (https://rustup.rs) or brew install rust" : "install Rust with rustup (https://rustup.rs)";

function grammarHint(): string {
  const prebuilt = existsSync(prebuiltGrammarDir()) ? "" : `no prebuilt libraries for ${PREBUILT_PLATFORM}; `;
  return `${prebuilt}code-nav install grammars (needs git and clang on PATH)`;
}

function runs(argv: string[]): string | null {
  try {
    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

function astGrepCheck(): Check {
  const what = "ast-grep";
  let path: string;
  try {
    path = astGrepExecutable();
  } catch (e) {
    const message = (e as Error).message;
    return { what, role: "syntax", found: null, hint: message.includes(AST_GREP_INSTALL_COMMAND) ? message : `${message}; ${astGrepHint()}` };
  }
  const version = runs([path, "--version"]);
  if (version === null) return { what, role: "syntax", found: null, hint: `${path} --version failed; ${astGrepHint()}` };
  return { what, role: "syntax", found: `${path} (${version})`, hint: "" };
}

function serverCheck(id: ServerId, role: Role): Check {
  const { name, env } = SERVER_COMMANDS[id];
  const command = serverCommand(id);
  const found = resolveExecutable(command);
  const overridden = process.env[env] !== undefined && process.env[env] !== "";
  const fix = SERVER_FIXES[id];
  if (overridden) return { what: name, role, found, hint: `${env}=${command} not found; unset it or ${fix.join(" ")}` };
  return { what: name, role, found, hint: fix.join(" "), fix };
}

function toolCheck(command: string, hint: string): Check {
  return { what: command, role: "lsp", found: resolveExecutable(command), hint };
}

function grammarCheck(what: string, library: string, env: string): Check {
  const found = existsSync(library) ? library : null;
  if (process.env[env]) return { what, role: "syntax", found, hint: `${env}=${library} not found; unset it or ${grammarHint()}` };
  return { what, role: "syntax", found, hint: `${library} not found; ${grammarHint()}`, fix: GRAMMARS_FIX };
}

function rustSrcCheck(): Check {
  const what = "rust-src";
  const hint = `run \`${INSTALL_COMMAND}\``;
  const chosen = sysrootSource(process.cwd());
  if (chosen !== null) {
    return existsSync(chosen.path)
      ? { what, role: "extra", found: `${chosen.path} (${chosen.from})`, hint }
      : { what, role: "extra", found: null, hint: `${chosen.path} from ${chosen.from} not found; ${hint}` };
  }
  const sysroot = runs([rustcCommand(), "--print", "sysroot"]);
  if (sysroot === null) return { what, role: "extra", found: null, hint: `${rustcCommand()} not runnable; ${CARGO_HINT}, then ${hint}` };
  const library = join(sysroot, "lib", "rustlib", "src", "rust", "library");
  return existsSync(library)
    ? { what, role: "extra", found: `${library} (toolchain sysroot)`, hint }
    : { what, role: "extra", found: null, hint, fix: RUST_SRC_FIX };
}

function angularServerChecks(): Check[] {
  const pkg = angularPackage();
  const node = nodeRuntime();
  const server: Check =
    typeof pkg === "string"
      ? { what: ANGULAR_LS_PACKAGE, role: "lsp", found: null, hint: `${pkg}; ${ANGULAR_LS_HINT}`, fix: ANGULAR_LS_FIX }
      : { what: ANGULAR_LS_PACKAGE, role: "lsp", found: `${pkg.dir} (${pkg.version}, from ${pkg.from})`, hint: "" };
  const engines = typeof pkg === "string" ? null : pkg.engines;
  let runtime: Check;
  if (node === null) runtime = { what: "node", role: "lsp", found: null, hint: "install Node.js (https://nodejs.org)" };
  else if (!satisfiesEngines(node.version, engines)) {
    runtime = { what: "node", role: "lsp", found: null, hint: `${node.path} is ${node.version}, ${ANGULAR_LS_PACKAGE} needs ${engines}` };
  } else runtime = { what: "node", role: "lsp", found: `${node.path} (${node.version})`, hint: "" };
  return [runtime, server];
}

function missingNames(checks: Check[], role: Role): string[] {
  return checks.filter((c) => c.role === role && c.found === null).map((c) => c.what);
}

function summarize(language: string, astGrep: Check, checks: Check[], extraNote: string): string {
  if (astGrep.found === null) return `${language}: unavailable (ast-grep missing)`;
  const syntax = missingNames(checks, "syntax");
  if (syntax.length > 0) return `${language}: unavailable (${syntax.join(", ")} missing)`;
  const lsp = missingNames(checks, "lsp");
  if (lsp.length > 0) return `${language}: syntax only (${lsp.join(", ")} missing)`;
  const extra = missingNames(checks, "extra");
  if (extra.length > 0) return `${language}: ready (${extraNote}: ${extra.join(", ")} missing)`;
  return `${language}: ready`;
}

const LANGUAGE_CHECKS: Record<LanguageId, () => [Check[], string]> = {
  csharp: () => [[serverCheck("csharp", "lsp"), toolCheck("dotnet", DOTNET_HINT)], ""],
  typescript: () => [[serverCheck("typescript", "lsp")], ""],
  graphql: () => [[serverCheck("typescript", "extra")], "no trace"],
  css: () => [[], ""],
  scss: () => [[grammarCheck("scss-grammar", scssLibraryPath(), SCSS_GRAMMAR_ENV)], ""],
  rust: () => [[serverCheck("rust", "lsp"), toolCheck("cargo", CARGO_HINT), rustSrcCheck()], "std not indexed"],
  wgsl: () => [[grammarCheck("wgsl-grammar", wgslLibraryPath(), WGSL_GRAMMAR_ENV)], ""],
  angular: () => [[grammarCheck("angular-grammar", angularLibraryPath(), ANGULAR_GRAMMAR_ENV), ...angularServerChecks()], ""],
};

export function diagnose(ids: readonly LanguageId[] = selectedLanguages()): DoctorReport {
  const astGrep = astGrepCheck();
  return {
    astGrep,
    languages: ids.map((id) => {
      const [checks, note] = LANGUAGE_CHECKS[id]();
      const language = LANGUAGE_LABELS[id];
      return { id, language, checks, summary: summarize(language, astGrep, checks, note) };
    }),
  };
}

function checkLine(check: Check): string {
  return check.found === null ? `missing ${check.what}: ${check.hint}` : `ok ${check.what} ${check.found}`;
}

export function doctor(args: string[], out: (text: string) => void): number {
  if (args.length > 0) {
    out("error: doctor takes no arguments");
    return EXIT.error;
  }
  const report = diagnose();
  const selection = readSelection() === null ? "all (no selection saved)" : `${report.languages.map((l) => l.language).join(", ")} (from ${selectionPath()})`;
  const lines = [`languages: ${selection}`, checkLine(report.astGrep)];
  for (const language of report.languages) lines.push(...language.checks.map(checkLine), language.summary);
  out(lines.join("\n"));
  return report.astGrep.found === null ? EXIT.notFound : EXIT.success;
}
