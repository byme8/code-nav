import { isAbsolute, relative } from "node:path";
import { declarationKinds, outlineRules, ruleText, type AgLanguage, type Rule, type RuleDoc } from "./rules.ts";
import { implOwner, rustRuleText } from "./rust.ts";
import { assignContainers, type Spanned, type ToolLanguage, type ToolSymbol } from "./symbols.ts";
import { addressSpaceKind, wgslConfigPath, wgslRuleText } from "./wgsl.ts";

const DECLARATION_ID = "declaration";
const BATCH_SIZE = 400;
const CONCURRENCY = 4;

function declarationRule(language: AgLanguage): Rule {
  const any: Rule[] = declarationKinds(language).map((kind) => ({ kind }));
  if (language === "CSharp") {
    any.push({ kind: "field_declaration" });
    any.push({ kind: "parameter", inside: { kind: "parameter_list", inside: { kind: "record_declaration" } } });
  } else {
    any.push({ kind: "lexical_declaration", matches: "top-level" });
    any.push({ kind: "variable_declaration", matches: "top-level" });
  }
  return { any };
}

const RULES = ruleText([
  ...outlineRules("csharp"),
  ...outlineRules("typescript"),
  ...(["CSharp", "TypeScript", "Tsx"] as const).map(
    (language): RuleDoc => ({ id: DECLARATION_ID, language, rule: declarationRule(language) }),
  ),
]) + "\n---\n" + rustRuleText(DECLARATION_ID);

const WGSL_RULES = wgslRuleText(DECLARATION_ID);

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
  return path.endsWith(".cs") ? "csharp" : "typescript";
}

function nameOf(language: ToolLanguage, m: StreamMatch): string {
  return language === "rust" ? m.message.replace(/\s+/g, " ") : m.text;
}

function symbolsOf(path: string, matches: StreamMatch[]): ToolSymbol[] {
  const language = languageOfPath(path);
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
    const symbol: ToolSymbol = {
      kind: language === "wgsl" && m.ruleId === "var" && best !== null ? addressSpaceKind(best.text) : m.ruleId,
      name: nameOf(language, m),
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
  return assignContainers(language, spanned);
}

export async function scanBatch(
  root: string,
  paths: string[],
  rules: string = RULES,
  config: string | null = null,
): Promise<Map<string, StreamMatch[]>> {
  const proc = Bun.spawn(
    [
      "ast-grep",
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
    { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && out === "") throw new Error(`ast-grep scan failed (exit ${code}): ${err.trim().split("\n")[0] ?? ""}`);
  const byFile = new Map<string, StreamMatch[]>();
  for (const raw of out.split("\n")) {
    if (raw === "") continue;
    const m = JSON.parse(raw) as StreamMatch;
    const file = (isAbsolute(m.file) ? relative(root, m.file) : m.file).split("\\").join("/");
    const list = byFile.get(file);
    if (list === undefined) byFile.set(file, [m]);
    else list.push(m);
  }
  return byFile;
}

export function parseWgslFiles(root: string, paths: string[], library: string): Promise<Map<string, ToolSymbol[]>> {
  return parseSyntaxFiles(root, paths, WGSL_RULES, wgslConfigPath(library));
}

export async function parseSyntaxFiles(
  root: string,
  paths: string[],
  rules: string = RULES,
  config: string | null = null,
): Promise<Map<string, ToolSymbol[]>> {
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += BATCH_SIZE) batches.push(paths.slice(i, i + BATCH_SIZE));
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
