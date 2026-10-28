import { fileURLToPath } from "node:url";

export interface CompileFailure {
  code: number;
  message: string;
}

async function run(argv: string[], output: "inherit" | "pipe"): Promise<CompileFailure | null> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: output, stderr: output });
  const [out, err, code] = await Promise.all([
    output === "pipe" ? new Response(proc.stdout as ReadableStream).text() : "",
    output === "pipe" ? new Response(proc.stderr as ReadableStream).text() : "",
    proc.exited,
  ]);
  if (code === 0) return null;
  const detail = (err || out).trim();
  return { code, message: `${argv[0] === process.execPath ? "bun build" : argv[0]} exited with ${code}${detail === "" ? "" : `: ${detail}`}` };
}

export async function compileTool(outfile: string, output: "inherit" | "pipe"): Promise<CompileFailure | null> {
  const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const grammarDir = fileURLToPath(new URL("../../data/grammars", import.meta.url));
  const define = `CODE_NAV_GRAMMAR_DIR=${JSON.stringify(grammarDir)}`;
  const built = await run([process.execPath, "build", "--compile", "--define", define, entry, "--outfile", outfile], output);
  if (built !== null || process.platform !== "darwin") return built;
  return run(["codesign", "--force", "--sign", "-", outfile], output);
}
