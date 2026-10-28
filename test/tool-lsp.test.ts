import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, killDaemonTree } from "../src/tool/daemon/lifecycle.ts";
import { readDaemonInfo, statePaths } from "../src/tool/daemon/state.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "tool");
const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const TAG = "src/frontend/web/app/components/price-tag.tsx";
const SERVICE = "src/frontend/web/app/services/price-service.ts";
const FORMATTER = "src/frontend/web/app/services/formatter.ts";
const TSCONFIG = "src/frontend/web/tsconfig.json";
const TIMEOUT = 60_000;

const dirs: string[] = [];
const trees: string[] = [];

function makeTree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-lsp-")));
  cpSync(FIXTURE, dir, { recursive: true });
  trees.push(dir);
  return dir;
}

async function cli(root: string, argv: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    cwd: root,
    env: { ...process.env, CODE_NAV_ROOT: root, CODE_NAV_IDLE_MS: "30000", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, lines: out.trimEnd().split("\n") };
}

function answer(reply: { exitCode: number; lines: string[] }): { exitCode: number; lines: string[] } {
  return { exitCode: reply.exitCode, lines: reply.lines.filter((l) => !/^(daemon started|waited) /.test(l)) };
}

function tsServerPid(root: string): number | null {
  return readDaemonInfo(statePaths(root))?.servers?.find((s) => s.name === "typescript-language-server")?.pid ?? null;
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}

afterEach(() => {
  for (const root of trees.splice(0)) {
    killDaemonTree(root);
    rmSync(statePaths(root).dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test(
  "refs, def, impls and callers answer from typescript-language-server",
  async () => {
    const root = makeTree();
    expect(answer(await cli(root, ["refs", "usePrice"]))).toEqual({
      exitCode: 0,
      lines: [TAG, '  1:10  import { usePrice } from "../services/price-service";', "  14:17  const price = usePrice(id);"],
    });
    expect(answer(await cli(root, ["def", `${TAG}:14`, "usePrice"]))).toEqual({
      exitCode: 0,
      lines: [`${SERVICE}:3:17  export function usePrice(id: string) {`],
    });
    expect(answer(await cli(root, ["impls", "Formatter"]))).toEqual({
      exitCode: 0,
      lines: [`${FORMATTER}:5:14 class PlainFormatter`, `${FORMATTER}:11:14 class CurrencyFormatter`],
    });
    expect(answer(await cli(root, ["callers", `${SERVICE}:3:17`]))).toEqual({
      exitCode: 0,
      lines: [`${TAG}:13:14 component PriceTag`],
    });
  },
  TIMEOUT,
);

test(
  "an edit that adds a call shows in the next callers and refs",
  async () => {
    const root = makeTree();
    expect(answer(await cli(root, ["callers", "usePrice"])).lines).toEqual([`${TAG}:13:14 component PriceTag`]);
    appendFileSync(
      join(root, FORMATTER),
      '\nimport { usePrice } from "./price-service";\n\nexport function priceLabel(id: string): string {\n  return String(usePrice(id));\n}\n',
    );
    expect(answer(await cli(root, ["callers", "usePrice"])).lines).toEqual([
      `${TAG}:13:14 component PriceTag`,
      `${FORMATTER}:21:17 function priceLabel`,
    ]);
    expect(answer(await cli(root, ["refs", "usePrice"])).lines.slice(3)).toEqual([
      FORMATTER,
      '  19:10  import { usePrice } from "./price-service";',
      "  22:17  return String(usePrice(id));",
    ]);
  },
  TIMEOUT,
);

test(
  "a tsconfig.json change restarts typescript-language-server before the answer",
  async () => {
    const root = makeTree();
    expect(answer(await cli(root, ["def", `${TAG}:14`, "usePrice"])).exitCode).toBe(0);
    const before = tsServerPid(root)!;
    expect(isAlive(before)).toBe(true);
    appendFileSync(join(root, TSCONFIG), "\n");
    expect(answer(await cli(root, ["def", `${TAG}:14`, "usePrice"]))).toEqual({
      exitCode: 0,
      lines: [`${SERVICE}:3:17  export function usePrice(id: string) {`],
    });
    const after = tsServerPid(root);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(await waitUntil(() => !isAlive(before), 5_000)).toBe(true);
  },
  TIMEOUT,
);

test(
  "with typescript-language-server missing, def exits 3 naming it while outline still answers",
  async () => {
    const root = makeTree();
    const missing = join(root, "no-such-dir", "typescript-language-server");
    const env = { CODE_NAV_TYPESCRIPT_LS: missing };
    expect(answer(await cli(root, ["def", `${TAG}:14`, "usePrice"], env))).toEqual({
      exitCode: 3,
      lines: [`error: typescript-language-server not available: executable not found: ${missing}`],
    });
    const outline = answer(await cli(root, ["outline", SERVICE], env));
    expect(outline).toEqual({ exitCode: 0, lines: [SERVICE, "3-5 function usePrice"] });
  },
  TIMEOUT,
);

test(
  "with typescript-language-server missing, refs answers from syntax only for a uniquely declared name",
  async () => {
    const root = makeTree();
    const missing = join(root, "no-such-dir", "typescript-language-server");
    const env = { CODE_NAV_TYPESCRIPT_LS: missing };
    expect(answer(await cli(root, ["refs", "usePrice"], env))).toEqual({
      exitCode: 0,
      lines: [
        "note: typescript-language-server not available; syntax references of a unique name",
        TAG,
        '  1:10  import { usePrice } from "../services/price-service";',
        "  14:17  const price = usePrice(id);",
      ],
    });
    expect(answer(await cli(root, ["refs", "src/frontend/web/app/graphql/price.gql.ts:3:13"], env))).toEqual({
      exitCode: 3,
      lines: [`error: typescript-language-server not available: executable not found: ${missing}`],
    });
  },
  TIMEOUT,
);

test(
  "stop kills a language server that has not answered initialize",
  async () => {
    const root = makeTree();
    const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-lsp-stub-")));
    dirs.push(stubDir);
    const stub = join(stubDir, "silent-language-server");
    writeFileSync(stub, `#!${process.execPath}\nawait Bun.sleep(60_000);\n`);
    chmodSync(stub, 0o755);
    const env = { CODE_NAV_TYPESCRIPT_LS: stub };
    expect((await cli(root, ["outline", SERVICE], env)).exitCode).toBe(0);
    expect(await waitUntil(() => tsServerPid(root) !== null, 5_000)).toBe(true);
    const pid = tsServerPid(root)!;
    expect(isAlive(pid)).toBe(true);
    expect((await cli(root, ["stop"], env)).exitCode).toBe(0);
    expect(await waitUntil(() => !isAlive(pid), 5_000)).toBe(true);
  },
  TIMEOUT,
);

test(
  "a command arriving while a slow one is in flight is answered by the same daemon without a restart",
  async () => {
    const root = makeTree();
    const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-lsp-stub-")));
    dirs.push(stubDir);
    const stub = join(stubDir, "slow-language-server");
    writeFileSync(stub, `#!${process.execPath}\nawait Bun.sleep(20_000);\n`);
    chmodSync(stub, 0o755);
    const env = { CODE_NAV_TYPESCRIPT_LS: stub };
    await cli(root, ["outline", SERVICE], env);
    const pid = readDaemonInfo(statePaths(root))!.pid;

    const slow = cli(root, ["def", `${TAG}:14`, "usePrice"], env);
    await Bun.sleep(1_000);
    const second = await cli(root, ["outline", SERVICE], env);
    expect(second).toEqual({ exitCode: 0, lines: [SERVICE, "3-5 function usePrice"] });
    expect(readDaemonInfo(statePaths(root))!.pid).toBe(pid);
    expect((await slow).exitCode).toBe(3);
  },
  TIMEOUT,
);
