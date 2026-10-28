import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonTree } from "../src/tool/daemon/lifecycle.ts";
import { statePaths } from "../src/tool/daemon/state.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "tool");
const CLI = join(import.meta.dir, "..", "src", "tool", "cli.ts");
const MODEL = "src/backend/Shop.Api/Models/PriceOutput.cs";
const SCHEMA = "src/frontend/web/schema.graphql";
const DOCUMENT = "src/frontend/web/app/graphql/price.graphql";
const TIMEOUT = 60_000;

const trees: string[] = [];

function makeTree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cn-tool-trace-")));
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
  return { exitCode, lines: out.trimEnd().split("\n").filter((l) => !/^(daemon started|waited) /.test(l)) };
}

afterEach(() => {
  for (const root of trees.splice(0)) {
    killDaemonTree(root);
    rmSync(statePaths(root).dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "trace prints the whole chain from a C# output property, one link per line in role order",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["trace", "PriceOutput.PrimaryAmount"])).toEqual({
      exitCode: 0,
      lines: [
        `csharp-property ${MODEL}:3:35  public record PriceOutput(decimal PrimaryAmount, string Currency);`,
        `schema-field ${SCHEMA}:9:3  primaryAmount: Decimal!`,
        `document-selection ${DOCUMENT}:8:3  primaryAmount`,
        "generated-ts-member src/frontend/web/app/api/types.ts:2:3  primaryAmount: number;",
        "generated-ts-member src/frontend/web/app/graphql/price.gql.ts:1:37  export type PriceFieldsFragment = { primaryAmount: number; currency: string };",
        "service-hook src/frontend/web/app/services/price-service.ts:3:17  export function usePrice(id: string) {",
        "component src/frontend/web/app/components/price-tag.tsx:13:14  export const PriceTag = ({ id }: PriceTagProps) => {",
      ],
    });
  },
  TIMEOUT,
);

test(
  "GraphQL def of a document field lands on the field of its parent type in the root schema",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["def", `${DOCUMENT}:8:3`])).toEqual({
      exitCode: 0,
      lines: [`${SCHEMA}:9:3  primaryAmount: Decimal!`],
    });
  },
  TIMEOUT,
);

test(
  "GraphQL refs of a schema field lists the document selections whose parent type declares it",
  async () => {
    const root = makeTree();
    expect(await cli(root, ["refs", `${SCHEMA}:2:3`])).toEqual({
      exitCode: 0,
      lines: [DOCUMENT, "  2:3  price(id: $id) {"],
    });
    expect(await cli(root, ["refs", "PriceOutput.currency"])).toEqual({
      exitCode: 0,
      lines: [DOCUMENT, "  9:3  currency"],
    });
  },
  TIMEOUT,
);

test(
  "without typescript-language-server, trace exits 3 naming it instead of printing a partial chain",
  async () => {
    const root = makeTree();
    const missing = join(root, "no-such-dir", "typescript-language-server");
    expect(await cli(root, ["trace", `${MODEL}:3`, "PrimaryAmount"], { CODE_NAV_TYPESCRIPT_LS: missing })).toEqual({
      exitCode: 3,
      lines: [`error: typescript-language-server not available: executable not found: ${missing}`],
    });
  },
  TIMEOUT,
);
