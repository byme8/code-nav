import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonTree } from "../src/tool/daemon/lifecycle.ts";
import { statePaths } from "../src/tool/daemon/state.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "rust-crate");
const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const LIB = "src/lib.rs";
const GEOMETRY = "src/geometry.rs";
const TIMEOUT = 60_000;

const roots: string[] = [];
const scratch: string[] = [];

function makeTree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-rust-")));
  scratch.push(dir);
  const root = join(dir, "crate");
  cpSync(FIXTURE, root, { recursive: true });
  mkdirSync(join(dir, "cargo-home"));
  roots.push(root);
  return root;
}

async function cli(root: string, argv: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; lines: string[] }> {
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    cwd: root,
    env: {
      ...process.env,
      CODE_NAV_ROOT: root,
      CODE_NAV_IDLE_MS: "30000",
      CARGO_HOME: join(root, "..", "cargo-home"),
      CARGO_NET_OFFLINE: "true",
      CODE_NAV_CACHE: join(root, "..", "cache"),
      CODE_NAV_RUST_SRC: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, lines: out.trimEnd().split("\n").filter((l) => !/^(daemon started|waited) /.test(l)) };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    killDaemonTree(root);
    rmSync(statePaths(root).dir, { recursive: true, force: true });
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test(
  "outline of a Rust file lists items with kinds, containers and ranges",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["outline", LIB])).toEqual({
      exitCode: 0,
      lines: [
        LIB,
        "1-1 module geometry",
        "3-3 const UNIT",
        "4-4 static ORIGIN_NAME",
        "5-5 type Area",
        "7-12 trait Shape",
        "  8-8 method area",
        "  9-11 method name",
        "14-16 struct Circle",
        "18-20 struct Square",
        "22-25 enum Kind",
        "27-31 impl impl Shape for Circle",
        "  28-30 method area",
        "33-37 impl impl Shape for Square",
        "  34-36 method area",
        "39-43 impl impl Circle",
        "  40-42 method new",
        "45-49 macro square_of",
        "51-53 function total_area",
        "55-58 function describe",
      ],
    });
    expect((await cli(root, ["find", "--target", "member", "--lang", "rust", "area"])).lines).toEqual([
      `${LIB}:8:8 method Shape.area  1.53  area`,
      `${LIB}:28:8 method Circle.area  1.53  area`,
      `${LIB}:34:8 method Square.area  1.53  area`,
    ]);
  },
  TIMEOUT,
);

test(
  "def, impls, refs and callers answer from rust-analyzer; show reads a Rust item",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["def", `${LIB}:57`, "area"])).toEqual({
      exitCode: 0,
      lines: [`${LIB}:28:8  fn area(&self) -> Area {`],
    });
    expect(await cli(root, ["impls", "Shape"])).toEqual({
      exitCode: 0,
      lines: [`${LIB}:27:16 impl impl Shape for Circle`, `${LIB}:33:16 impl impl Shape for Square`],
    });
    expect(await cli(root, ["refs", "total_area"])).toEqual({
      exitCode: 0,
      lines: [GEOMETRY, "  1:13  use crate::{total_area, Circle, Shape, Square};", "  9:5  total_area(&shapes) * units::SCALE"],
    });
    expect(await cli(root, ["callers", "total_area"])).toEqual({
      exitCode: 0,
      lines: [`${GEOMETRY}:7:8 function scaled_total`],
    });
    expect((await cli(root, ["show", LIB, "describe"])).lines[0]).toBe(`${LIB}:55-58 function describe`);
  },
  TIMEOUT,
);

test(
  "with rust-analyzer missing, def exits 3 naming it while outline still answers",
  async () => {
    const root = makeTree();
    const missing = join(root, "no-such-dir", "rust-analyzer");
    const env = { CODE_NAV_RUST_ANALYZER: missing };
    expect(await cli(root, ["def", `${LIB}:57`, "area"], env)).toEqual({
      exitCode: 3,
      lines: [`error: rust-analyzer not available: executable not found: ${missing}`],
    });
    const outline = await cli(root, ["outline", GEOMETRY], env);
    expect(outline).toEqual({
      exitCode: 0,
      lines: [GEOMETRY, "3-5 module units", "  4-4 const SCALE", "7-10 function scaled_total"],
    });
  },
  TIMEOUT,
);

test(
  "the first Rust answer that misses while rust-analyzer could not load std carries the install offer once",
  async () => {
    const root = makeTree();
    const first = await cli(root, ["def", `${LIB}:51`, "Box"]);
    expect(first.exitCode).toBe(1);
    expect(first.lines[0]).toMatch(/^note: std not available to rust-analyzer \(.+\); run `code-nav install rust-src`$/);
    expect(first.lines.slice(1)).toEqual([`not found: definition of Box at ${LIB}:51:29`]);
    const second = await cli(root, ["def", `${LIB}:51`, "Box"]);
    expect(second).toEqual({ exitCode: 1, lines: [`not found: definition of Box at ${LIB}:51:29`] });
  },
  TIMEOUT,
);
