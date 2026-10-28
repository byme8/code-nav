import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reply } from "../output.ts";
import { IS_WINDOWS, commandLineOf, killTree } from "../platform.ts";
import { PING, TransportError, send } from "./protocol.ts";
import { TOOL_VERSION, readDaemonInfo, statePaths, type DaemonInfo, type StatePaths } from "./state.ts";

export const PING_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 300_000;
const STOP_WAIT_MS = 5_000;

function selfCommand(): string[] {
  const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isOurDaemon(pid: number, paths: StatePaths): boolean {
  const command = commandLineOf(pid);
  return / daemon /.test(command) && command.includes(paths.hash);
}

export function killServers(info: DaemonInfo | null): void {
  for (const server of info?.servers ?? []) {
    if (!isAlive(server.pid)) continue;
    if (!commandLineOf(server.pid).includes(basename(server.command))) continue;
    killTree(server.pid);
  }
}

export function killDaemonTree(root: string): void {
  const paths = statePaths(root);
  const info = readDaemonInfo(paths);
  if (info !== null && isAlive(info.pid) && isOurDaemon(info.pid, paths)) killTree(info.pid);
  killServers(info);
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

interface Ping {
  files: number;
  version: string;
}

async function ping(paths: StatePaths, timeoutMs: number): Promise<Ping> {
  const reply = await send(paths.socket, { argv: [PING], cwd: process.cwd() }, timeoutMs);
  const [files, version] = reply.stdout.trim().split("\n");
  return { files: Number(files), version: version ?? "" };
}

function killStale(paths: StatePaths): void {
  const info = readDaemonInfo(paths);
  if (info !== null && isAlive(info.pid) && isOurDaemon(info.pid, paths)) killTree(info.pid);
  killServers(info);
  if (!IS_WINDOWS) rmSync(paths.socket, { force: true });
  rmSync(paths.info, { force: true });
}

function logTail(paths: StatePaths): string {
  try {
    return readFileSync(paths.log, "utf8").trim().split("\n").slice(-3).join(" | ");
  } catch {
    return "no daemon log";
  }
}

function takeLock(paths: StatePaths): boolean {
  try {
    closeSync(openSync(paths.lock, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(paths.lock).mtimeMs > START_TIMEOUT_MS) {
        rmSync(paths.lock, { force: true });
        return takeLock(paths);
      }
    } catch {
      return takeLock(paths);
    }
    return false;
  }
}

async function waitReady(paths: StatePaths, exited: () => boolean): Promise<Ping> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      return await ping(paths, PING_TIMEOUT_MS);
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
    }
    if (exited()) throw new Error(`daemon exited during start-up: ${logTail(paths)}`);
    if (Date.now() > deadline) throw new Error(`daemon not ready after ${START_TIMEOUT_MS / 1000} s: ${logTail(paths)}`);
    await sleep(25);
  }
}

async function start(root: string, paths: StatePaths): Promise<Ping | null> {
  mkdirSync(paths.dir, { recursive: true });
  if (!takeLock(paths)) {
    await waitReady(paths, () => false);
    return null;
  }
  try {
    const out = openSync(paths.log, "a");
    const [command, ...prefix] = selfCommand();
    const child = spawn(command!, [...prefix, "daemon", root, paths.hash], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    closeSync(out);
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    return await waitReady(paths, () => exited);
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

export async function ensureDaemon(root: string): Promise<string | null> {
  const paths = statePaths(root);
  const info = readDaemonInfo(paths);
  let reason: string;
  try {
    const answer = await ping(paths, PING_TIMEOUT_MS);
    if (answer.version === TOOL_VERSION) return null;
    reason = `version ${answer.version} replaced by ${TOOL_VERSION}`;
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    if (info === null) {
      const t0 = performance.now();
      const started = await start(root, paths);
      if (started === null) return null;
      return `daemon started in ${((performance.now() - t0) / 1000).toFixed(1)} s (${started.files} files indexed)`;
    }
    reason = isAlive(info.pid) ? e.reason : `daemon ${info.pid} not running`;
  }
  killStale(paths);
  await start(root, paths);
  return `daemon restarted (${reason})`;
}

export async function request(root: string, argv: string[], cwd: string): Promise<Reply> {
  return send(statePaths(root).socket, { argv, cwd }, null);
}

export async function status(root: string): Promise<Reply | null> {
  const paths = statePaths(root);
  try {
    await ping(paths, PING_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof TransportError) return null;
    throw e;
  }
  return send(paths.socket, { argv: ["status"], cwd: process.cwd() }, PING_TIMEOUT_MS);
}

export async function stop(root: string): Promise<string> {
  const paths = statePaths(root);
  const info = readDaemonInfo(paths);
  try {
    await send(paths.socket, { argv: ["stop"], cwd: process.cwd() }, PING_TIMEOUT_MS);
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    if (info === null || !isAlive(info.pid) || !isOurDaemon(info.pid, paths)) {
      rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return "no daemon running";
    }
    killTree(info.pid);
    killServers(info);
    await waitForExit(info.pid, STOP_WAIT_MS);
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return `daemon ${info.pid} killed (${e.reason})`;
  }
  if (info !== null && !(await waitForExit(info.pid, STOP_WAIT_MS))) {
    killTree(info.pid);
    killServers(readDaemonInfo(paths) ?? info);
    await waitForExit(info.pid, STOP_WAIT_MS);
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return `daemon ${info.pid} killed (did not exit after stop)`;
  }
  return "daemon stopped";
}
