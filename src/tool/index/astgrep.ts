import { isAbsolute, relative } from "node:path";
import { IS_WINDOWS, resolveExecutable } from "../platform.ts";
import { DECORATOR_KINDS, DECORATOR_RULES, angularConfigPath, angularRuleText, blockName } from "./angular.ts";
import { declarationKinds, outlineRules, ruleText, type AgLanguage, type Rule, type RuleDoc } from "./rules.ts";
import { styleKind, styleName, styleRuleText } from "./css.ts";
import { implOwner, rustRuleText } from "./rust.ts";
import { scssConfigPath } from "./scss.ts";
import { assignContainers, isStyleLanguage, type Spanned, type ToolLanguage, type ToolSymbol } from "./symbols.ts";
import { addressSpaceKind, wgslConfigPath, wgslRuleText } from "./wgsl.ts";

const DECLARATION_ID = "declaration";
const BATCH_SIZE = 400;
const WINDOWS_COMMAND_LINE_MAX = 32_767;
const COMMAND_LINE_RESERVE = 2_048;
const CONCURRENCY = 4;

let astGrep: string | null = null;

export function astGrepExecutable(): string {
  if (astGrep !== null) return astGrep;
  const resolved = resolveExecutable("ast-grep");
  if (resolved === null) throw new Error("ast-grep not found on PATH");
  if (IS_WINDOWS && !/\.exe$/i.test(resolved)) {
    throw new Error(`ast-grep at ${resolved} is a script shim; install the native ast-grep.exe (cargo, scoop or winget)`);
  }
  astGrep = resolved;
  return astGrep;
}

export function scanBatches(paths: string[], rules: string): string[][] {
  const budget = IS_WINDOWS ? WINDOWS_COMMAND_LINE_MAX - COMMAND_LINE_RESERVE - 2 * rules.length : Infinity;
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (batch.length > 0 && (batch.length === BATCH_SIZE || length + path.length + 3 > budget)) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(path);
    length += path.length + 3;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function declarationRule(language: AgLanguage): Rule {
  const any: Rule[] = declarationKinds(language).map((kind) => ({ kind }));
  if (language === "CSharp") {
    any.push({ kind: "field_declaration" });
    any.push({ kind: "parameter", inside: { kind: "parameter_list", inside: { kind: "record_declaration" } } });
  } else {
    any.push({ kind: "lexical_declaration", matches: "top-level" });
    any.push({ kind: "variable_declaration", matches: "top-level" });
    any.push({ kind: "decorator" });
  }
  return { any };
}

const RULES = ruleText([
  ...outlineRules("csharp"),
  ...outlineRules("typescript"),
  ...Object.entries(DECORATOR_RULES).map(([id, rule]): RuleDoc => ({ id, language: "TypeScript", rule })),
  ...(["CSharp", "TypeScript", "Tsx"] as const).map(
    (language): RuleDoc => ({ id: DECLARATION_ID, language, rule: declarationRule(language) }),
  ),
]) + "\n---\n" + rustRuleText(DECLARATION_ID) + "\n---\n" + styleRuleText("Css", DECLARATION_ID);

const WGSL_RULES = wgslRuleText(DECLARATION_ID);
const SCSS_RULES = styleRuleText("scss", DECLARATION_ID);
const ANGULAR_RULES = angularRuleText(DECLARATION_ID);

interface Point {
  line: number;
}

export interface StreamMatch {
  file: string;
  ruleId: string;
  message: string;
  text: string;
  range: { byteOffset: { start: number; end: number }; start: Point; end: Point };
  charCount: { leading: number };
}

function languageOfPath(path: string): ToolLanguage {
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".wgsl")) return "wgsl";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".scss")) return "scss";
  if (path.endsWith(".html")) return "angular";
  return path.endsWith(".cs") ? "csharp" : "typescript";
}

function nameOf(language: ToolLanguage, m: StreamMatch): string {
  if (isStyleLanguage(language)) return styleName(m.ruleId, m.text);
  if (language === "angular" && m.ruleId === "block") return blockName(m.text);
  return language === "rust" ? m.message.replace(/\s+/g, " ") : m.text;
}

function kindOf(language: ToolLanguage, m: StreamMatch, name: string, declaration: StreamMatch | null): string {
  if (language === "wgsl" && m.ruleId === "var" && declaration !== null) return addressSpaceKind(declaration.text);
  return isStyleLanguage(language) ? styleKind(m.ruleId, name) : m.ruleId;
}

function attachDecorators(symbols: ToolSymbol[]): ToolSymbol[] {
  for (const decorated of symbols.filter((s) => DECORATOR_KINDS.has(s.kind))) {
    const owner = symbols.find((s) => s.kind === "class" && s.nameLine >= decorated.end);
    if (owner === undefined) continue;
    decorated.container = owner.name;
    owner.start = Math.min(owner.start, decorated.start);
  }
  return symbols;
}

function symbolsOf(path: string, matches: StreamMatch[], languageOverride: ToolLanguage | null = null): ToolSymbol[] {
  const language = languageOverride ?? languageOfPath(path);
  const declarations = matches.filter((m) => m.ruleId === DECLARATION_ID);
  const spanned: Spanned[] = [];
  for (const m of matches) {
    if (m.ruleId === DECLARATION_ID) continue;
    const from = m.range.byteOffset.start;
    const to = m.range.byteOffset.end;
    let best: StreamMatch | null = null;
    for (const d of declarations) {
      if (d.range.byteOffset.start > from || d.range.byteOffset.end < to) continue;
      const size = d.range.byteOffset.end - d.range.byteOffset.start;
      if (best === null || size < best.range.byteOffset.end - best.range.byteOffset.start) best = d;
    }
    const nameLine = m.range.start.line + 1;
    const name = nameOf(language, m);
    const symbol: ToolSymbol = {
      kind: kindOf(language, m, name, best),
      name,
      start: best === null ? nameLine : best.range.start.line + 1,
      end: best === null ? nameLine : best.range.end.line + 1,
      nameLine,
      nameColumn: m.charCount.leading + 1,
      container: null,
      depth: 0,
    };
    spanned.push({
      symbol,
      from: best?.range.byteOffset.start ?? from,
      to: best?.range.byteOffset.end ?? to,
    });
  }
  if (language === "rust") return assignContainers(language, spanned, (c) => (c.kind === "impl" ? implOwner(c.name) : c.name));
  if (language === "typescript") return attachDecorators(assignContainers(language, spanned));
  return assignContainers(language, spanned);
}

export async function parseAngularFiles(root: string, paths: string[], library: string): Promise<Map<string, ToolSymbol[]>> {
  const config = angularConfigPath(library);
  const out = new Map<string, ToolSymbol[]>();
  for (const batch of scanBatches(paths, ANGULAR_RULES)) {
    const matches = await scanBatch(root, batch, ANGULAR_RULES, config);
    for (const path of batch) {
      const symbols = symbolsOf(path, matches.get(path) ?? [], "angular");
      if (!path.endsWith(".html")) for (const s of symbols) s.depth++;
      out.set(path, symbols);
    }
  }
  return out;
}

export async function scanBatch(
  root: string,
  paths: string[],
  rules: string = RULES,
  config: string | null = null,
): Promise<Map<string, StreamMatch[]>> {
  const proc = Bun.spawn(
    [
      astGrepExecutable(),
      "scan",
      ...(config === null ? [] : ["--config", config]),
      "--inline-rules",
      rules,
      "--json=stream",
      "--color",
      "never",
      ...["hidden", "dot", "exclude", "global", "parent", "vcs"].flatMap((t) => ["--no-ignore", t]),
      ...paths,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true },
  );
  const byFile = new Map<string, StreamMatch[]>();
  let matched = 0;
  const take = (raw: string): void => {
    if (raw === "") return;
    const m = JSON.parse(raw) as StreamMatch;
    matched++;
    const file = (isAbsolute(m.file) ? relative(root, m.file) : m.file).split("\\").join("/");
    const list = byFile.get(file);
    if (list === undefined) byFile.set(file, [m]);
    else list.push(m);
  };
  const readMatches = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) take(line);
    }
    take(pending + decoder.decode());
  };
  const [, err, code] = await Promise.all([readMatches(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && matched === 0) throw new Error(`ast-grep scan failed (exit ${code}): ${err.trim().split("\n")[0] ?? ""}`);
  return byFile;
}

export function parseWgslFiles(root: string, paths: string[], library: string): Promise<Map<string, ToolSymbol[]>> {
  return parseSyntaxFiles(root, paths, WGSL_RULES, wgslConfigPath(library));
}

export function parseScssFiles(root: string, paths: string[], library: string): Promise<Map<string, ToolSymbol[]>> {
  return parseSyntaxFiles(root, paths, SCSS_RULES, scssConfigPath(library));
}

export async function parseSyntaxFiles(
  root: string,
  paths: string[],
  rules: string = RULES,
  config: string | null = null,
): Promise<Map<string, ToolSymbol[]>> {
  const batches = scanBatches(paths, rules);
  const out = new Map<string, ToolSymbol[]>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const matches = await scanBatch(root, batch, rules, config);
      for (const path of batch) out.set(path, symbolsOf(path, matches.get(path) ?? []));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return out;
}
