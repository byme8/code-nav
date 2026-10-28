import { findKeywords, isGeneratedPath } from "../index/declarations.ts";
import type { IndexedFile, ToolLanguage } from "../index/symbols.ts";
import { memberUnits, termsOf, type Terms } from "../index/terms.ts";
import { failure, notFound, prefixed, success } from "../output.ts";
import { compareBytes, type Command, type CommandContext } from "./context.ts";

export const FIND_LIMIT = 10;
export const DEMOTION = 0.5;

const LANGUAGES: readonly ToolLanguage[] = ["csharp", "typescript", "graphql", "rust", "wgsl"];
const KINDS = ["tests", "migrations", "generated"] as const;
type FileKind = (typeof KINDS)[number];
const TARGETS = ["file", "member"] as const;
type Target = (typeof TARGETS)[number];

const USAGE =
  "usage: code-nav find [--target file|member] [--lang csharp|typescript|graphql|rust|wgsl]… [--kind tests|migrations|generated]… <words…>";

export function fileKinds(path: string): Set<FileKind> {
  const out = new Set<FileKind>();
  const segments = path.split("/");
  const name = segments.at(-1)!;
  const directories = segments.slice(0, -1);
  if (
    directories.some(
      (d) =>
        ["test", "tests", "__tests__"].includes(d.toLowerCase()) ||
        d.endsWith(".Tests") ||
        d.endsWith(".IntegrationTests") ||
        d.endsWith(".UnitTests"),
    ) ||
    /\.(?:test|spec)\.tsx?$/.test(name)
  ) {
    out.add("tests");
  }
  if (directories.includes("Migrations") || name.endsWith(".Designer.cs") || name.endsWith("ModelSnapshot.cs")) {
    out.add("migrations");
  }
  if (isGeneratedPath(path)) out.add("generated");
  return out;
}

function listOption(value: string | undefined, allowed: readonly string[], option: string): string[] {
  if (value === undefined || value === "") throw new Error(`${option} needs a value`);
  const values = value.split(",").filter((v) => v !== "");
  const bad = values.find((v) => !allowed.includes(v));
  if (bad !== undefined) throw new Error(`unknown ${option} value: ${bad} (expected ${allowed.join("|")})`);
  return values;
}

interface FindRequest {
  languages: Set<ToolLanguage>;
  explicitLanguages: boolean;
  kinds: Set<FileKind>;
  target: Target;
  words: string[];
}

function parse(args: string[]): FindRequest {
  const languages = new Set<ToolLanguage>();
  const kinds = new Set<FileKind>();
  let target: Target = "file";
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [option, inline] = arg.startsWith("--") ? [arg.split("=")[0]!, arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null] : [null, null];
    if (option === "--target") {
      const value = inline ?? args[++i];
      if (value === undefined || value === "") throw new Error("--target needs a value");
      if (!(TARGETS as readonly string[]).includes(value)) throw new Error(`unknown --target value: ${value} (expected ${TARGETS.join("|")})`);
      target = value as Target;
    } else if (option === "--lang" || option === "--kind") {
      const value = inline ?? args[++i];
      if (option === "--lang") for (const v of listOption(value, LANGUAGES, "--lang")) languages.add(v as ToolLanguage);
      else for (const v of listOption(value, KINDS, "--kind")) kinds.add(v as FileKind);
    } else if (option !== null) {
      throw new Error(`unknown option ${option}`);
    } else {
      words.push(arg);
    }
  }
  return { languages: languages.size === 0 ? new Set(LANGUAGES) : languages, explicitLanguages: languages.size > 0, kinds, target, words };
}

interface Unit {
  path: string;
  line: number;
  label: string | null;
  terms: Terms;
}

interface Scored {
  unit: Unit;
  score: number;
  matched: string[];
}

const memberCache = new WeakMap<IndexedFile, Unit[]>();

function membersOf(file: IndexedFile): Unit[] {
  let units = memberCache.get(file);
  if (units === undefined) {
    units = memberUnits(file).map(({ symbol, terms }) => ({
      path: file.path,
      line: symbol.nameLine,
      label: `${file.path}:${symbol.nameLine}:${symbol.nameColumn} ${symbol.kind} ${symbol.container === null ? "" : `${symbol.container}.`}${symbol.name}`,
      terms,
    }));
    memberCache.set(file, units);
  }
  return units;
}

function unitsOf(ctx: CommandContext, target: Target, files: IndexedFile[]): Unit[] {
  if (target === "member") return files.flatMap(membersOf);
  return files.map((file) => ({ path: file.path, line: 0, label: null, terms: ctx.index.terms(file) }));
}

function rank(units: Unit[], queryTerms: string[], kinds: ReadonlySet<FileKind>): Scored[] {
  const df = new Map<string, number>(queryTerms.map((t) => [t, 0]));
  for (const unit of units) for (const t of queryTerms) if (unit.terms.has(t)) df.set(t, df.get(t)! + 1);
  const out: Scored[] = [];
  for (const unit of units) {
    let score = 0;
    const matched: string[] = [];
    for (const t of queryTerms) {
      const place = unit.terms.get(t);
      if (place === undefined) continue;
      score += Math.log(units.length / df.get(t)!) * place;
      matched.push(t);
    }
    const unitKinds = fileKinds(unit.path);
    if (unitKinds.size > 0 && ![...unitKinds].some((k) => kinds.has(k))) score *= DEMOTION;
    if (score > 0) out.push({ unit, score, matched });
  }
  return out;
}

export const find: Command = {
  needsFreshIndex: true,
  run(ctx) {
    let request: FindRequest;
    try {
      request = parse(ctx.args);
    } catch (e) {
      return failure(`${(e as Error).message}; ${USAGE}`);
    }
    if (request.words.length === 0) return failure(USAGE);
    const queryTerms = [...new Set(findKeywords(request.words.join(" ")).flatMap(termsOf))];
    const notes: string[] = [];
    const wgslProblem = request.languages.has("wgsl") ? ctx.index.wgslProblem() : null;
    if (wgslProblem !== null) {
      if (request.explicitLanguages) return failure(wgslProblem);
      request.languages.delete("wgsl");
      if (ctx.index.filesOf(new Set(["wgsl"])).length > 0) notes.push(`note: ${wgslProblem}; WGSL files not ranked`);
    }
    const scored: Scored[] = [];
    for (const language of request.languages) {
      const units = unitsOf(ctx, request.target, ctx.index.filesOf(new Set([language])));
      scored.push(...rank(units, queryTerms, request.kinds));
    }
    if (scored.length === 0) return prefixed(notes, notFound(`no file or symbol name matches ${request.words.join(" ")}`));
    scored.sort((a, b) => b.score - a.score || compareBytes(a.unit.path, b.unit.path) || a.unit.line - b.unit.line);
    const lines = scored
      .slice(0, FIND_LIMIT)
      .map((s) => `${s.unit.label ?? s.unit.path}  ${s.score.toFixed(2)}  ${s.matched.join(",")}`);
    if (scored.length > FIND_LIMIT) lines.push(`… ${scored.length - FIND_LIMIT} more`);
    return success([...notes, ...lines]);
  },
};
