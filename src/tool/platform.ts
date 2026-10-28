import { existsSync } from "node:fs";
import { join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";
export const EXE_SUFFIX = IS_WINDOWS ? ".exe" : "";

export function ipcPath(dir: string, hash: string): string {
  return IS_WINDOWS ? `\\\\.\\pipe\\code-nav-${hash}` : join(dir, "daemon.sock");
}

export function commandLineOf(pid: number): string {
  const argv = IS_WINDOWS
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]
    : ["ps", "-o", "command=", "-p", String(pid)];
  try {
    return Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", windowsHide: true }).stdout.toString();
  } catch {
    return "";
  }
}

export function killTree(pid: number): void {
  if (IS_WINDOWS) {
    Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

export function resolveExecutable(command: string): string | null {
  if (!command.includes("/") && !command.includes("\\")) return Bun.which(command);
  const candidates = IS_WINDOWS && !/\.(?:exe|cmd|bat)$/i.test(command) ? [`${command}.exe`, `${command}.cmd`] : [command];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export interface SpawnArgv {
  argv: string[];
  verbatim: boolean;
}

export function spawnArgv(argv: string[]): SpawnArgv {
  const [command, ...args] = argv;
  if (!IS_WINDOWS || !/\.(?:cmd|bat)$/i.test(command!)) return { argv, verbatim: false };
  const line = [command!, ...args].map((a) => (a === "" || /[\s"&|<>^%()]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)).join(" ");
  return { argv: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${line}"`], verbatim: true };
}
