import { homedir } from "node:os";
import { join } from "node:path";

export const CSHARP_LS = join(homedir(), ".dotnet", "tools", "csharp-ls");
export const TYPESCRIPT_LS = "typescript-language-server";
export const CSS_LS = "vscode-css-language-server";
