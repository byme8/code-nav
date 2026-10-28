import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonTree } from "../src/tool/daemon/lifecycle.ts";
import { statePaths } from "../src/tool/daemon/state.ts";
import { WGSL_BUILD_COMMAND, WGSL_GRAMMAR_ENV, wgslLibraryPath } from "../src/tool/index/wgsl.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "wgsl");
const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const SHADER = "shading.wgsl";
const TIMEOUT = 30_000;

const roots: string[] = [];

function makeTree(): string {
  if (!existsSync(wgslLibraryPath())) throw new Error(`WGSL grammar missing at ${wgslLibraryPath()}: run \`${WGSL_BUILD_COMMAND}\` first`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-wgsl-")));
  cpSync(FIXTURE, root, { recursive: true });
  roots.push(root);
  return root;
}

async function cli(root: string, argv: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    cwd: root,
    env: { ...process.env, CODE_NAV_ROOT: root, CODE_NAV_IDLE_MS: "30000", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, lines: out.trimEnd().split("\n").filter((l) => !/^daemon started /.test(l)) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    killDaemonTree(root);
    rmSync(statePaths(root).dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "outline of a WGSL file lists every declaration, including those after an #import line and inside #ifdef branches",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["outline", SHADER])).toEqual({
      exitCode: 0,
      lines: [
        SHADER,
        "3-6 struct Light",
        "  4-4 field position",
        "  5-5 field intensity",
        "9-9 var<storage> lights",
        "11-11 const MAX_LIGHTS",
        "13-13 override shadow_bias",
        "15-15 alias Color",
        "17-19 fn attenuate",
        "22-28 fn shade_pixel",
        "31-31 const SHADOW_SAMPLES",
        "33-33 var<private> shadow_scale",
        "36-42 fn shadow_factor",
        "44-46 fn ambient",
      ],
    });
  },
  TIMEOUT,
);

test(
  "show of a WGSL fn prints its declaration range",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["show", SHADER, "attenuate"])).toEqual({
      exitCode: 0,
      lines: [
        "shading.wgsl:17-19 fn attenuate",
        "fn attenuate(light: Light, distance: f32) -> f32 {",
        "    return light.intensity / (distance * distance);",
        "}",
      ],
    });
  },
  TIMEOUT,
);

test(
  "find --lang wgsl ranks the shader declaring the fn first",
  async () => {
    const root = makeTree();
    const found = await cli(root, ["find", "--lang", "wgsl", "shade", "pixel"]);
    expect(found.exitCode).toBe(0);
    expect(found.lines[0]).toStartWith(`${SHADER}  `);
  },
  TIMEOUT,
);

test(
  "def on a WGSL position answers an error naming the missing language server",
  async () => {
    const root = makeTree();
    const answer = await cli(root, ["def", `${SHADER}:24:30`]);
    expect(answer.exitCode).toBe(3);
    expect(answer.lines[0]).toStartWith("error: no language server for wgsl");
  },
  TIMEOUT,
);

test(
  "a missing WGSL grammar fails WGSL commands with the build command and leaves other languages ranked",
  async () => {
    const root = makeTree();
    writeFileSync(join(root, "lighting.ts"), "export function shadePixel(): number {\n  return 1;\n}\n");
    writeFileSync(join(root, "camera.ts"), "export function moveCamera(): void {}\n");
    const env = { [WGSL_GRAMMAR_ENV]: join(root, "missing", "wgsl.dylib") };

    const outline = await cli(root, ["outline", SHADER], env);
    expect(outline.exitCode).toBe(3);
    expect(outline.lines[0]).toStartWith("error: WGSL grammar not available:");
    expect(outline.lines[0]).toContain(WGSL_BUILD_COMMAND);

    const found = await cli(root, ["find", "shade", "pixel"], env);
    expect(found.exitCode).toBe(0);
    expect(found.lines[0]).toStartWith("note: WGSL grammar not available:");
    expect(found.lines[0]).toEndWith("; WGSL files not ranked");
    expect(found.lines[1]).toStartWith("lighting.ts  ");
  },
  TIMEOUT,
);
