import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const VERSION = "1.2.3";
const LIBRARY = "rust-src/lib/rustlib/src/rust/library";
const TIMEOUT = 60_000;

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function setup(publishedHash?: string): { dir: string; env: Record<string, string> } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cn-install-")));
  scratch.push(dir);
  const library = join(dir, "stage", `rust-src-${VERSION}`, LIBRARY);
  write(join(library, "Cargo.toml"), '[workspace]\nmembers = ["fakecore"]\nresolver = "2"\n');
  write(join(library, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "fakecore"\nversion = "0.0.0"\n');
  write(join(library, "fakecore", "Cargo.toml"), '[package]\nname = "fakecore"\nversion = "0.0.0"\nedition = "2021"\n');
  write(join(library, "fakecore", "src", "lib.rs"), "pub fn answer() -> u32 { 42 }\n");
  const dist = join(dir, "dist");
  mkdirSync(dist);
  const archive = join(dist, `rust-src-${VERSION}.tar.xz`);
  const tar = Bun.spawnSync(["tar", "-cJf", archive, "-C", join(dir, "stage"), `rust-src-${VERSION}`]);
  expect(tar.exitCode).toBe(0);
  const hash = publishedHash ?? new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${hash}  rust-src-${VERSION}.tar.xz\n`);
  const realRustc = Bun.which("rustc");
  const rustc = join(dir, "bin", "rustc");
  write(
    rustc,
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] === "--version") console.log("rustc ${VERSION} (fake 2026-01-01)");\n` +
      `else process.exit(Bun.spawnSync([${JSON.stringify(realRustc)}, ...args], { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1);\n`,
  );
  chmodSync(rustc, 0o755);
  mkdirSync(join(dir, "cargo-home"));
  return {
    dir,
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      CODE_NAV_CACHE: join(dir, "cache"),
      CODE_NAV_RUST_DIST: pathToFileURL(dist).href,
      CARGO_HOME: join(dir, "cargo-home"),
      CARGO_NET_OFFLINE: "true",
    },
  };
}

async function install(dir: string, env: Record<string, string>): Promise<{ exitCode: number; lines: string[] }> {
  const { RUSTC: _rustc, CARGO: _cargo, CODE_NAV_RUST_SRC: _src, ...inherited } = process.env;
  const proc = Bun.spawn([process.execPath, CLI, "install", "rust-src"], {
    cwd: dir,
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, lines: out.trimEnd().split("\n") };
}

test(
  "install rust-src downloads, verifies and extracts the component into the cache, fetches its dependencies, and a rerun reports it installed",
  async () => {
    const { dir, env } = setup();
    const target = join(dir, "cache", "rust-src", VERSION);
    const first = await install(dir, env);
    expect(first.exitCode).toBe(0);
    expect(first.lines).toContain(`installed rust-src ${VERSION} at ${target} (0.0 MB)`);
    expect(first.lines).toContain(`std dependencies: fetched into ${join(dir, "cargo-home")}`);
    expect(existsSync(join(target, LIBRARY, "fakecore", "src", "lib.rs"))).toBe(true);
    expect(readdirSync(join(dir, "cache", "rust-src"))).toEqual([VERSION]);

    const second = await install(dir, env);
    expect(second.exitCode).toBe(0);
    expect(second.lines).toContain(`rust-src ${VERSION} already installed at ${target}`);
    expect(second.lines.some((l) => l.startsWith("downloading "))).toBe(false);
  },
  TIMEOUT,
);

// TEST_POINT: a corrupted download must never become an install rust-analyzer would load.
test(
  "a hash mismatch exits non-zero, deletes the download and leaves no version dir",
  async () => {
    const { dir, env } = setup("0".repeat(64));
    const result = await install(dir, env);
    expect(result.exitCode).toBe(3);
    expect(result.lines.at(-1)).toStartWith("error: sha256 mismatch for ");
    expect(readdirSync(join(dir, "cache", "rust-src"))).toEqual([]);
  },
  TIMEOUT,
);
