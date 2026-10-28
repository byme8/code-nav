import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolLanguage } from "./symbols.ts";

export const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "bin", "obj"]);

export interface FileStamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

export function sourceLanguage(path: string): ToolLanguage | null {
  if (/\.(?:ts|tsx|mts|cts)$/.test(path)) return "typescript";
  if (path.endsWith(".cs")) return "csharp";
  if (/\.(?:graphql|gql)$/.test(path)) return "graphql";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".wgsl")) return "wgsl";
  return null;
}

export type ConfigOwner = "csharp" | "typescript" | "rust";

export function configOwner(path: string): ConfigOwner | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(?:csproj|sln|slnx)$/.test(name) || /^Directory\..*\.(?:props|targets)$/.test(name)) return "csharp";
  if (name === "global.json" || name.toLowerCase() === "nuget.config") return "csharp";
  if (name === "package.json" || name === "package-lock.json" || /^tsconfig.*\.json$/.test(name)) return "typescript";
  if (name === "Cargo.toml" || name === "Cargo.lock") return "rust";
  return null;
}

export function walkTree(root: string): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>();
  const visit = (relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(relDir === "" ? root : join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(rel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (sourceLanguage(rel) === null && configOwner(rel) === null) continue;
      try {
        const st = statSync(join(root, rel));
        if (st.isFile()) out.set(rel, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino });
      } catch {
        continue;
      }
    }
  };
  visit("");
  return out;
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}
