import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/tool/commands/index.ts";
import { bringUpToDate } from "../src/tool/daemon/freshness.ts";
import { SyntaxIndex } from "../src/tool/index/index.ts";

const root = realpathSync(join(import.meta.dir, "fixtures", "tool"));
const CALCULATOR = "src/backend/Shop.Services/Pricing/PriceCalculator.cs";
const INTERFACE = "src/backend/Shop.Services/Pricing/IPriceCalculator.cs";
const TESTS = "src/backend/Shop.Services.Tests/PriceCalculatorTests.cs";
const TAG = "src/frontend/web/app/components/price-tag.tsx";
const SCHEMA = "src/frontend/web/schema.graphql";

let index: SyntaxIndex;

beforeAll(async () => {
  index = new SyntaxIndex(root);
  await bringUpToDate(index);
});

async function tool(...argv: string[]): Promise<{ exitCode: number; lines: string[] }> {
  const [name, ...args] = argv;
  const reply = await runCommand(name!, { index, root, cwd: root, args });
  return { exitCode: reply.exitCode, lines: reply.stdout.trimEnd().split("\n") };
}

test("find breaks ties by path and halves test files unless --kind names them", async () => {
  const tied = await tool("find", "--lang", "csharp", "calculator");
  expect(tied.lines.map((l) => l.split("  ")[0])).toEqual([INTERFACE, CALCULATOR, TESTS]);
  const [interfaceScore, calculatorScore, testsScore] = tied.lines.map((l) => Number(l.split("  ")[1]));
  expect(interfaceScore).toBe(calculatorScore!);
  expect(testsScore).toBeCloseTo(calculatorScore! / 2, 2);

  const lookingForTests = await tool("find", "--lang", "csharp", "--kind", "tests", "calculator");
  expect(lookingForTests.lines.map((l) => l.split("  ")[0])).toEqual([TESTS, INTERFACE, CALCULATOR]);
});

test("find --target file ranks on file-level declarations, so a file with many matching member names does not outrank the implementing file", async () => {
  const tree = mkdtempSync(join(tmpdir(), "cn-find-target-"));
  try {
    const put = (path: string, text: string): void => {
      mkdirSync(join(tree, path, ".."), { recursive: true });
      writeFileSync(join(tree, path), text);
    };
    put("src/Billing/InvoiceTotal.cs", "namespace Billing;\n\npublic class InvoiceTotal\n{\n    public decimal Amount { get; init; }\n}\n");
    put(
      "src/Ledger/LedgerService.cs",
      [
        "namespace Ledger;",
        "",
        "public class LedgerService",
        "{",
        "    public decimal InvoiceTotal { get; init; }",
        "    public decimal Discount() => 0;",
        "    public decimal Rounding() => 0;",
        "    public string Currency() => \"\";",
        "    public void Schedule() { }",
        "    public void Penalty() { }",
        "}",
        "",
      ].join("\n"),
    );
    put("src/Customers/Customer.cs", "namespace Customers;\n\npublic class Customer\n{\n    public string Name { get; init; } = \"\";\n}\n");
    const treeIndex = new SyntaxIndex(realpathSync(tree));
    await bringUpToDate(treeIndex);
    const reply = await runCommand("find", {
      index: treeIndex,
      root: treeIndex.root,
      cwd: treeIndex.root,
      args: ["--lang", "csharp", "invoice", "total", "discount", "rounding", "currency", "schedule", "penalty"],
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout.trimEnd().split("\n")).toEqual(["src/Billing/InvoiceTotal.cs  6.59  invoic,total"]);
  } finally {
    rmSync(tree, { recursive: true });
  }
});

test("find --target member finds a method by its name and prints it as Owner.name at its position", async () => {
  const reply = await tool("find", "--target", "member", "--lang", "csharp", "compute", "primary", "amount");
  expect(reply.exitCode).toBe(0);
  expect(reply.lines.slice(0, 3)).toEqual([
    `${INTERFACE}:7:17 method IPriceCalculator.ComputePrimaryAmount  8.55  comput,primary,amount`,
    `${CALCULATOR}:16:24 method PriceCalculator.ComputePrimaryAmount  8.55  comput,primary,amount`,
    `${CALCULATOR}:21:24 method PriceCalculator.ComputePrimaryAmount  8.55  comput,primary,amount`,
  ]);

  const nested = await tool("find", "--target", "member", "--lang", "csharp", "breakdown");
  expect(nested.lines[0]).toStartWith(`${CALCULATOR}:27:19 record PriceCalculator.Breakdown  `);
});

test("find with no matching name exits 1 with not found", async () => {
  const reply = await tool("find", "--lang", "csharp", "warehouse", "shipment");
  expect(reply.exitCode).toBe(1);
  expect(reply.lines).toEqual(["not found: no file or symbol name matches warehouse shipment"]);
});

test("outline lists C#, TSX and GraphQL symbols in source order with members under their type", async () => {
  expect((await tool("outline", CALCULATOR)).lines).toEqual([
    CALCULATOR,
    "5-28 class PriceCalculator",
    "  7-7 field _rate",
    "  9-12 constructor PriceCalculator",
    "  14-14 property Currency",
    "  16-19 method ComputePrimaryAmount",
    "  21-25 method ComputePrimaryAmount",
    "  27-27 record Breakdown",
    "    27-27 property Base",
    "    27-27 property Tax",
  ]);
  expect((await tool("outline", TAG)).lines).toEqual([
    TAG,
    "3-3 constant MAX_DIGITS",
    "5-7 interface PriceTagProps",
    "9-11 function formatAmount",
    "13-21 component PriceTag",
  ]);
  expect((await tool("outline", SCHEMA)).lines).toEqual([
    SCHEMA,
    "1-3 type Query",
    "  2-2 field price",
    "8-11 type PriceOutput",
    "  9-9 field primaryAmount",
    "  10-10 field currency",
    "13-16 enum Currency",
    "  14-14 enum-value USD",
    "  15-15 enum-value EUR",
  ]);
});

test("show by line prints the smallest containing symbol with its text; a name prints its one declaration", async () => {
  expect((await tool("show", `${CALCULATOR}:23`)).lines).toEqual([
    `${CALCULATOR}:21-25 method ComputePrimaryAmount`,
    "    public PriceOutput ComputePrimaryAmount(decimal amount, decimal discount)",
    "    {",
    "        var discounted = amount - discount;",
    "        return ComputePrimaryAmount(discounted);",
    "    }",
  ]);
  expect((await tool("show", CALCULATOR, "ComputePrimaryAmount", "17")).lines[0]).toBe(
    `${CALCULATOR}:16-19 method ComputePrimaryAmount`,
  );
  expect((await tool("show", TAG, "formatAmount")).lines).toEqual([
    `${TAG}:9-11 function formatAmount`,
    "function formatAmount(amount: number): string {",
    "  return amount.toFixed(MAX_DIGITS);",
    "}",
  ]);
  expect((await tool("show", "PriceOutput.primaryAmount")).lines).toEqual([
    `${SCHEMA}:9-9 field primaryAmount`,
    "  primaryAmount: Decimal!",
  ]);
});

test("show of a name several symbols share exits 2 listing every candidate", async () => {
  const reply = await tool("show", "ComputePrimaryAmount");
  expect(reply.exitCode).toBe(2);
  expect(reply.lines).toEqual([
    "ambiguous: ComputePrimaryAmount",
    `${INTERFACE}:7-7 method ComputePrimaryAmount`,
    `${CALCULATOR}:16-19 method ComputePrimaryAmount`,
    `${CALCULATOR}:21-25 method ComputePrimaryAmount`,
  ]);
});
