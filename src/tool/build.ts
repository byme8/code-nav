import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileTool } from "./compile.ts";

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error("usage: bun src/tool/build.ts <outdir>");
  process.exit(2);
}
const dir = resolve(outDir);
mkdirSync(dir, { recursive: true });
const outfile = join(dir, "code-nav");
const failure = await compileTool(outfile, "inherit");
if (failure !== null) process.exit(failure.code);
console.log(outfile);
