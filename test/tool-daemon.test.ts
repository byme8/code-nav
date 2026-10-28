import { afterEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, killDaemonTree } from "../src/tool/daemon/lifecycle.ts";
import { readDaemonInfo, statePaths } from "../src/tool/daemon/state.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "tool");
const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const CALCULATOR = "src/backend/Shop.Services/Pricing/PriceCalculator.cs";
const TIMEOUT = 30_000;

const trees: string[] = [];

function makeTree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-test-")));
  cpSync(FIXTURE, dir, { recursive: true });
  trees.push(dir);
  return dir;
}

function daemonPid(root: string): number | null {
  return readDaemonInfo(statePaths(root))?.pid ?? null;
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
}

async function cli(root: string, argv: string[], idleMs = 20_000): Promise<{ exitCode: number; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    cwd: root,
    env: { ...process.env, CODE_NAV_ROOT: root, CODE_NAV_IDLE_MS: String(idleMs) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, lines: out.trimEnd().split("\n") };
}

afterEach(() => {
  for (const root of trees.splice(0)) {
    const paths = statePaths(root);
    killDaemonTree(root);
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "the first command starts a daemon and reports it; the next command reuses the same daemon",
  async () => {
    const root = makeTree();
    const first = await cli(root, ["outline", CALCULATOR]);
    expect(first.exitCode).toBe(0);
    expect(first.lines[0]).toMatch(/^daemon started in \d+\.\d s \(12 files indexed\)$/);
    expect(first.lines[1]).toBe(CALCULATOR);
    const pid = daemonPid(root);
    expect(pid).not.toBeNull();

    const second = await cli(root, ["outline", CALCULATOR]);
    expect(second.lines[0]).toBe(CALCULATOR);
    expect(daemonPid(root)).toBe(pid);
  },
  TIMEOUT,
);

test(
  "an edited, created, renamed or deleted file shows in the next answer",
  async () => {
    const root = makeTree();
    await cli(root, ["outline", CALCULATOR]);

    appendFileSync(join(root, CALCULATOR), "\npublic class Surcharge\n{\n    public decimal Apply(decimal amount) => amount;\n}\n");
    expect((await cli(root, ["outline", CALCULATOR])).lines.slice(-2)).toEqual(["30-33 class Surcharge", "  32-32 method Apply"]);

    const created = "src/backend/Shop.Services/Pricing/WarehousePolicy.cs";
    writeFileSync(join(root, created), "namespace Shop;\n\npublic class WarehousePolicy\n{\n}\n");
    expect((await cli(root, ["find", "--lang", "csharp", "warehouse"])).lines[0]).toStartWith(`${created}  `);

    const renamed = "src/backend/Shop.Services/Pricing/StoragePolicy.cs";
    renameSync(join(root, created), join(root, renamed));
    const afterRename = await cli(root, ["find", "--lang", "csharp", "warehouse", "storage"]);
    expect(afterRename.lines.map((l) => l.split("  ")[0])).toEqual([renamed]);

    rmSync(join(root, renamed));
    const afterDelete = await cli(root, ["outline", renamed]);
    expect(afterDelete.exitCode).toBe(1);
    expect(afterDelete.lines).toEqual([`not found: file ${renamed}`]);
  },
  TIMEOUT,
);

test(
  "stop and the idle timeout each end the daemon and remove its state directory",
  async () => {
    const stopped = makeTree();
    await cli(stopped, ["outline", CALCULATOR]);
    const stoppedPid = daemonPid(stopped)!;
    expect(await cli(stopped, ["stop"])).toEqual({ exitCode: 0, lines: ["daemon stopped"] });
    expect(isAlive(stoppedPid)).toBe(false);
    expect(existsSync(statePaths(stopped).dir)).toBe(false);

    const idle = makeTree();
    await cli(idle, ["outline", CALCULATOR], 700);
    const idlePid = daemonPid(idle)!;
    expect(await waitUntil(() => !isAlive(idlePid) && !existsSync(statePaths(idle).dir), 10_000)).toBe(true);
  },
  TIMEOUT,
);

test(
  "a killed daemon is detected and replaced by the next command, which reports the restart and answers",
  async () => {
    const root = makeTree();
    await cli(root, ["outline", CALCULATOR]);
    const pid = daemonPid(root)!;
    process.kill(pid, "SIGKILL");
    expect(await waitUntil(() => !isAlive(pid), 5_000)).toBe(true);

    const next = await cli(root, ["outline", CALCULATOR]);
    expect(next.exitCode).toBe(0);
    expect(next.lines[0]).toBe(`daemon restarted (daemon ${pid} not running)`);
    expect(next.lines[1]).toBe(CALCULATOR);
    const replacement = daemonPid(root);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(pid);
  },
  TIMEOUT,
);

test(
  "two working trees get two daemons",
  async () => {
    const a = makeTree();
    const b = makeTree();
    await Promise.all([cli(a, ["outline", CALCULATOR]), cli(b, ["outline", CALCULATOR])]);
    const infoA = readDaemonInfo(statePaths(a))!;
    const infoB = readDaemonInfo(statePaths(b))!;
    expect(infoA.pid).not.toBe(infoB.pid);
    expect([infoA.root, infoB.root]).toEqual([a, b]);
  },
  TIMEOUT,
);
