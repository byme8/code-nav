import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const LANGUAGES = ["csharp", "typescript", "graphql", "css", "scss", "rust", "wgsl", "angular"] as const;
export type LanguageId = (typeof LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<LanguageId, string> = {
  csharp: "C#",
  typescript: "TypeScript",
  graphql: "GraphQL",
  css: "CSS",
  scss: "SCSS",
  rust: "Rust",
  wgsl: "WGSL",
  angular: "Angular",
};

type ServerOwner = "csharp" | "typescript" | "rust" | "angular";

const SERVER_USERS: Record<ServerOwner, LanguageId[]> = {
  csharp: ["csharp"],
  typescript: ["typescript", "graphql", "angular"],
  rust: ["rust"],
  angular: ["angular"],
};

type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  if (env.CODE_NAV_CONFIG) return resolve(env.CODE_NAV_CONFIG);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), "code-nav");
  return join(homedir(), ".config", "code-nav");
}

export function selectionPath(env: Env = process.env): string {
  return join(configDir(env), "languages.json");
}

export function isLanguage(value: string): value is LanguageId {
  return (LANGUAGES as readonly string[]).includes(value);
}

export function readSelection(env: Env = process.env): LanguageId[] | null {
  const path = selectionPath(env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { languages?: unknown };
    if (!Array.isArray(parsed.languages)) return null;
    return LANGUAGES.filter((id) => (parsed.languages as unknown[]).includes(id));
  } catch {
    return null;
  }
}

export function writeSelection(languages: readonly LanguageId[], env: Env = process.env): string {
  const path = selectionPath(env);
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ languages: LANGUAGES.filter((id) => languages.includes(id)) }, null, 2)}\n`);
  return path;
}

export function selectedLanguages(env: Env = process.env): readonly LanguageId[] {
  return readSelection(env) ?? LANGUAGES;
}

export function serverSelected(owner: ServerOwner, env: Env = process.env): boolean {
  const selected = selectedLanguages(env);
  return SERVER_USERS[owner].some((id) => selected.includes(id));
}
