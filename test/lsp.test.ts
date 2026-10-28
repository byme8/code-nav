import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, type Location } from "../src/tool/lsp/client.ts";
import { TYPESCRIPT_LS } from "../src/tool/lsp/servers.ts";

const project = mkdtempSync(join(tmpdir(), "cn-lsp-test-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

const charColumn = (line: string, needle: string) => Array.from(line.slice(0, line.indexOf(needle))).length + 1;

// TEST_POINT: astral characters before both positions make UTF-16 offsets differ from character columns.
test("definition across two files returns the declaration as a corpus-relative location with character columns", async () => {
  const declaration = "/* 😀 rocket 🚀 */ export function greet(name: string): string { return name; }";
  const call = "const label = '🎉🎉'; export const out = greet(label);";
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022" } }));
  writeFileSync(join(project, "a.ts"), `export const first = 1;\n${declaration}\n`);
  writeFileSync(join(project, "b.ts"), `import { greet } from './a';\n${call}\n`);

  const client = await LspClient.start({ command: [TYPESCRIPT_LS, "--stdio"], cwd: project, corpusRoot: project, requestTimeoutMs: 30_000 });
  let locations: Location[] = [];
  try {
    const deadline = Date.now() + 60_000;
    const resolved = () => locations.length > 0 && locations.every((l) => l.path !== "b.ts");
    while (!resolved() && Date.now() < deadline) {
      locations = await client.definition({ path: "b.ts", line: 2, column: charColumn(call, "greet(label)") + 1 });
      if (!resolved()) await Bun.sleep(500);
    }
  } finally {
    await client.shutdown();
  }

  expect(locations).toHaveLength(1);
  expect(locations[0]).toMatchObject({
    path: "a.ts",
    line: 2,
    column: charColumn(declaration, "greet("),
    startLine: 2,
    endLine: 2,
    insideRoot: true,
  });
  expect(client.isRunning).toBe(false);
}, 90_000);
