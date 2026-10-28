import { homedir } from "node:os";
import { join } from "node:path";

export const CSHARP_LS = join(homedir(), ".dotnet", "tools", "csharp-ls");
export const TYPESCRIPT_LS = "typescript-language-server";
export const RUST_ANALYZER = "rust-analyzer";
export const CSS_LS = "vscode-css-language-server";

export type ServerId = "csharp" | "typescript" | "rust" | "css";

export const SERVER_COMMANDS: Record<ServerId, { name: string; command: string; env: string }> = {
  csharp: { name: "csharp-ls", command: CSHARP_LS, env: "CODE_NAV_CSHARP_LS" },
  typescript: { name: "typescript-language-server", command: TYPESCRIPT_LS, env: "CODE_NAV_TYPESCRIPT_LS" },
  rust: { name: "rust-analyzer", command: RUST_ANALYZER, env: "CODE_NAV_RUST_ANALYZER" },
  css: { name: "vscode-css-language-server", command: CSS_LS, env: "CODE_NAV_CSS_LS" },
};

export function serverCommand(id: ServerId): string {
  const override = process.env[SERVER_COMMANDS[id].env];
  return override !== undefined && override !== "" ? override : SERVER_COMMANDS[id].command;
}
