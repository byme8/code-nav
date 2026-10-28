import { existsSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { IS_WINDOWS } from "./platform.ts";
import { cacheRoot } from "./rust-src.ts";

export const AST_GREP_VERSION = "0.51.0";
export const AST_GREP_ENV = "CODE_NAV_AST_GREP";
export const AST_GREP_INSTALL_COMMAND = "code-nav install ast-grep";
export const AST_GREP_EXE = IS_WINDOWS ? "ast-grep.exe" : "ast-grep";

const RELEASES = "https://github.com/ast-grep/ast-grep/releases/download";

const ASSETS: Record<string, { asset: string; sha256: string }> = {
  "darwin-arm64": { asset: "app-aarch64-apple-darwin.zip", sha256: "e18e13c27ed6c4b3ec4de00745b0755dee9dc26c035e226f4dd5d147dca99cc8" },
  "darwin-x64": { asset: "app-x86_64-apple-darwin.zip", sha256: "8438fe549da59da28518c45bdaab5b851aabafe8fb4f8dc05c261a7649b4eca6" },
  "linux-arm64": { asset: "app-aarch64-unknown-linux-gnu.zip", sha256: "73af0ebe5958acee012754a5b2826a186580ef83333092408a7a01096fc30b8b" },
  "linux-x64": { asset: "app-x86_64-unknown-linux-gnu.zip", sha256: "a7eead5552d3a8daad70f5d50d935da44bd0c138e946b5b0a96b1d38169fa639" },
  "win32-arm64": { asset: "app-aarch64-pc-windows-msvc.zip", sha256: "fb6a4c3c6ed350d7e64eae81961bdf6b3f201c6e7c31ace8caccf8ceddff1cac" },
  "win32-x64": { asset: "app-x86_64-pc-windows-msvc.zip", sha256: "1a5b7824c5925ac34257f806488e54860817cefd855fd308d13df7550d068908" },
};

export const AST_GREP_PLATFORM = `${process.platform}-${process.arch}`;

export function astGrepRelease(): { url: string; asset: string; sha256: string } | null {
  const pinned = ASSETS[AST_GREP_PLATFORM];
  if (pinned === undefined) return null;
  const base = (process.env.CODE_NAV_AST_GREP_DIST || `${RELEASES}/${AST_GREP_VERSION}`).replace(/\/+$/, "");
  return { url: `${base}/${pinned.asset}`, ...pinned };
}

export function astGrepVersionDir(): string {
  return join(cacheRoot(), "ast-grep", AST_GREP_VERSION);
}

export function installedAstGrep(): string | null {
  const path = join(astGrepVersionDir(), AST_GREP_EXE);
  return existsSync(path) ? path : null;
}

export function zipEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive: no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (entry.split("/").at(-1) !== name) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`zip entry ${entry}: unsupported compression method ${method}`);
  }
  return null;
}
