import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPermission } from "../src/tool/install-global.ts";

const SCRIPT = join(import.meta.dir, "..", "src", "tool", "install-global.ts");
const NOTE = join(import.meta.dir, "..", "prompts", "navigation-tool-note.md");
const TIMEOUT = 110_000;

const base = realpathSync(mkdtempSync(join(tmpdir(), "cnig")));
const stateTmp = join(base, "t");
mkdirSync(stateTmp);
const env = { ...process.env, TMPDIR: stateTmp, CODE_NAV_IDLE_MS: "60000" };

afterAll(() => {
  const binary = join(base, "bin", "code-nav");
  if (existsSync(binary)) Bun.spawnSync([binary, "stop", "--root", join(base, "tree")], { env, stdout: "ignore", stderr: "ignore" });
  rmSync(base, { recursive: true, force: true });
});

function install(binDir: string, claudeHome: string): { exitCode: number; lines: string[] } {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, "--bin-dir", binDir, "--claude-home", claudeHome], { env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, lines: `${proc.stdout}${proc.stderr}`.trim().split("\n") };
}

const SETTINGS = `{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Read"
    ],
    "deny": []
  },
  "env": { "A": "1" }
}
`;

const SETTINGS_WITH_ENTRY = `{
  "model": "opus",
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Read",
      "Bash(code-nav:*)"
    ],
    "deny": []
  },
  "env": { "A": "1" }
}
`;

test(
  "installing twice replaces the binary, writes the skill, adds the permission once and stops the scoped daemon",
  () => {
    const bin = join(base, "bin");
    const claude = join(base, "claude");
    const tree = join(base, "tree");
    mkdirSync(join(claude, "skills", "other"), { recursive: true });
    mkdirSync(tree);
    writeFileSync(join(tree, "a.ts"), "export function hello(): number {\n  return 1;\n}\n");
    writeFileSync(join(claude, "settings.json"), SETTINGS);
    writeFileSync(join(claude, "skills", "other", "SKILL.md"), "other skill\n");
    const binary = join(bin, "code-nav");

    const first = install(bin, claude);
    expect(first.exitCode).toBe(0);
    expect(first.lines).toContain(`permission: Bash(code-nav:*) added in ${join(claude, "settings.json")}`);
    expect(first.lines).toContain("daemons: 0 stopped");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(SETTINGS_WITH_ENTRY);
    const skill = readFileSync(join(claude, "skills", "code-nav", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: code-nav\ndescription: ")).toBe(true);
    expect(skill).toContain(readFileSync(NOTE, "utf8"));
    const firstInode = statSync(binary).ino;

    const outline = Bun.spawnSync([binary, "outline", "a.ts", "--root", tree], { cwd: tree, env, stdout: "pipe", stderr: "pipe" });
    expect(outline.exitCode).toBe(0);
    expect(outline.stdout.toString()).toContain("function hello");

    const second = install(bin, claude);
    expect(second.exitCode).toBe(0);
    expect(second.lines).toContain(`permission: Bash(code-nav:*) already present in ${join(claude, "settings.json")}`);
    expect(second.lines).toContain("daemons: 1 stopped");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(SETTINGS_WITH_ENTRY);
    expect(readFileSync(join(claude, "skills", "code-nav", "SKILL.md"), "utf8")).toBe(skill);
    expect(readFileSync(join(claude, "skills", "other", "SKILL.md"), "utf8")).toBe("other skill\n");
    expect(statSync(binary).ino).not.toBe(firstInode);

    const status = Bun.spawnSync([binary, "status", "--root", tree], { cwd: tree, env, stdout: "pipe", stderr: "pipe" });
    expect([0, 1]).toContain(status.exitCode);
  },
  TIMEOUT,
);

test("settings without permissions or without allow get the entry in the file's own indentation, the rest byte-identical", () => {
  const noPermissions = addPermission('{\n    "model": "opus",\n    "env": { "A": "1" }\n}\n');
  expect(noPermissions.result).toBe("added");
  expect(noPermissions.text).toBe(
    '{\n    "model": "opus",\n    "env": { "A": "1" },\n    "permissions": {\n        "allow": [\n            "Bash(code-nav:*)"\n        ]\n    }\n}\n',
  );
  const noAllow = addPermission('{\n  "permissions": {\n    "deny": []\n  },\n  "model": "opus"\n}\n');
  expect(noAllow.result).toBe("added");
  expect(noAllow.text).toBe('{\n  "permissions": {\n    "deny": [],\n    "allow": [\n      "Bash(code-nav:*)"\n    ]\n  },\n  "model": "opus"\n}\n');
});

test(
  "settings.json that is not valid JSON is left byte-identical and reported",
  () => {
    const claude = join(base, "claude-invalid");
    mkdirSync(claude);
    const broken = '{\n  "permissions": { "allow": [\n';
    writeFileSync(join(claude, "settings.json"), broken);

    const run = install(join(base, "bin-invalid"), claude);
    expect(run.exitCode).toBe(1);
    expect(run.lines).toContain(`permission: Bash(code-nav:*) not added, ${join(claude, "settings.json")} left unchanged (not valid JSON)`);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe(broken);
  },
  TIMEOUT,
);
