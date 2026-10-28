import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TOOL_VERSION = "4c";
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export interface ServerRecord {
  name: string;
  pid: number;
  command: string;
  workspace: string;
}

export interface DaemonInfo {
  pid: number;
  root: string;
  version: string;
  startedAt: string;
  servers?: ServerRecord[];
}

export interface StatePaths {
  hash: string;
  dir: string;
  socket: string;
  info: string;
  lock: string;
  log: string;
}

export function resolveRoot(option: string | undefined, cwd: string): string {
  const explicit = option ?? process.env.CODE_NAV_ROOT;
  if (explicit !== undefined && explicit !== "") return realpathSync(resolve(cwd, explicit));
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return realpathSync(dir);
    if (dirname(dir) === dir) return realpathSync(cwd);
  }
}

export function statePaths(root: string): StatePaths {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "code-nav", hash);
  return {
    hash,
    dir,
    socket: join(dir, "daemon.sock"),
    info: join(dir, "daemon.json"),
    lock: join(dir, "start.lock"),
    log: join(dir, "daemon.log"),
  };
}

export function readDaemonInfo(paths: StatePaths): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(paths.info, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function idleMs(): number {
  const raw = Number(process.env.CODE_NAV_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}
