import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Subprocess } from "bun";
import { IS_WINDOWS, killTree, spawnArgv } from "../platform.ts";

export interface Position {
  path: string;
  line: number;
  column: number;
}

export interface Location {
  path: string;
  startLine: number;
  endLine: number;
  line: number;
  column: number;
  insideRoot: boolean;
}

export interface DocumentSymbolInfo {
  name: string;
  kind: number;
  container: string | null;
  location: Location;
}

export interface IncomingCall {
  name: string;
  kind: number;
  location: Location;
  callSites: Location[];
}

export interface LspClientOptions {
  command: string[];
  cwd: string;
  corpusRoot: string;
  workspaceRoot?: string;
  initializationOptions?: unknown;
  experimentalCapabilities?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  requestTimeoutMs?: number;
  log?: string;
  env?: Record<string, string>;
  onNotification?: (method: string, params: any) => void;
  onSpawn?: (client: LspClient) => void;
}

export type WatchedFileChange = "created" | "changed" | "deleted";

const WATCHED_FILE_CHANGE_TYPE: Record<WatchedFileChange, number> = { created: 1, changed: 2, deleted: 3 };

export class LspTimeoutError extends Error {}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LANGUAGE_IDS: Record<string, string> = {
  ".cs": "csharp",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".rs": "rust",
  ".html": "html",
};

const DEFAULT_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;

function utf16ToCharColumn(lineText: string, utf16Offset: number): number {
  return Array.from(lineText.slice(0, utf16Offset)).length + 1;
}

function charColumnToUtf16(lineText: string, column: number): number {
  const chars = Array.from(lineText);
  if (column < 1 || column > chars.length + 1) {
    throw new Error(`column ${column} is outside a line of ${chars.length} characters`);
  }
  return chars.slice(0, column - 1).join("").length;
}

export class LspClient {
  readonly pid: number;
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly corpusRoot: string;
  private readonly timeoutMs: number;
  private readonly log: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Map<string, number>();
  private readonly onNotification: LspClientOptions["onNotification"];
  private readonly configuration: LspClientOptions["configuration"];
  private readonly lineCache = new Map<string, string[]>();
  private buffer = new Uint8Array(0);
  private exited = false;
  private readonly exitPromise: Promise<number>;

  private constructor(options: LspClientOptions) {
    this.corpusRoot = realpathSync(options.corpusRoot);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log;
    this.onNotification = options.onNotification;
    this.configuration = options.configuration;
    const spawned = spawnArgv(options.command);
    this.proc = Bun.spawn(spawned.argv, {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: spawned.verbatim,
      env: { ...process.env, ...options.env },
    });
    this.pid = this.proc.pid;
    this.exitPromise = this.proc.exited.then((code) => {
      this.exited = true;
      this.failAll(new Error(`language server ${options.command[0]} (pid ${this.pid}) exited with ${code}`));
      return code;
    });
    void this.pump();
    void this.drainStderr();
  }

  static async start(options: LspClientOptions): Promise<LspClient> {
    const client = new LspClient(options);
    options.onSpawn?.(client);
    const workspaceRoot = realpathSync(options.workspaceRoot ?? options.corpusRoot);
    const rootUri = pathToFileURL(workspaceRoot).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
        rootPath: workspaceRoot,
        workspaceFolders: [{ uri: rootUri, name: workspaceRoot.split(sep).pop() ?? "root" }],
        initializationOptions: options.initializationOptions,
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: true },
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {},
            publishDiagnostics: {},
          },
          ...(options.experimentalCapabilities === undefined ? {} : { experimental: options.experimentalCapabilities }),
        },
      });
      client.notify("initialized", {});
    } catch (error) {
      client.kill();
      throw error;
    }
    return client;
  }

  get isRunning(): boolean {
    return !this.exited;
  }

  waitForExit(): Promise<number> {
    return this.exitPromise;
  }

  isOpen(path: string): boolean {
    return this.opened.has(this.absolute(path));
  }

  async open(path: string): Promise<void> {
    const absolute = this.absolute(path);
    if (this.opened.has(absolute)) return;
    const text = readFileSync(absolute, "utf8");
    this.lineCache.set(absolute, text.split(/\r?\n/));
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(absolute).href,
        languageId: LANGUAGE_IDS[extname(absolute)] ?? "plaintext",
        version: 1,
        text,
      },
    });
    this.opened.set(absolute, 1);
  }

  reload(path: string): void {
    const absolute = this.absolute(path);
    this.lineCache.delete(absolute);
    const version = this.opened.get(absolute);
    if (version === undefined) return;
    const text = readFileSync(absolute, "utf8");
    this.lineCache.set(absolute, text.split(/\r?\n/));
    this.opened.set(absolute, version + 1);
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(absolute).href, version: version + 1 },
      contentChanges: [{ text }],
    });
  }

  forget(path: string): void {
    const absolute = isAbsolute(path) ? path : join(this.corpusRoot, path);
    this.lineCache.delete(absolute);
    if (!this.opened.delete(absolute)) return;
    this.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(absolute).href } });
  }

  watchedFilesChanged(changes: { path: string; change: WatchedFileChange }[]): void {
    if (changes.length === 0) return;
    this.notify("workspace/didChangeWatchedFiles", {
      changes: changes.map(({ path, change }) => ({
        uri: pathToFileURL(isAbsolute(path) ? path : join(this.corpusRoot, path)).href,
        type: WATCHED_FILE_CHANGE_TYPE[change],
      })),
    });
  }

  async definition(position: Position): Promise<Location[]> {
    return this.locations(await this.request("textDocument/definition", await this.positionParams(position)));
  }

  async implementation(position: Position): Promise<Location[]> {
    return this.locations(await this.request("textDocument/implementation", await this.positionParams(position)));
  }

  async references(position: Position, includeDeclaration = false): Promise<Location[]> {
    const params = { ...(await this.positionParams(position)), context: { includeDeclaration } };
    return this.locations(await this.request("textDocument/references", params));
  }

  async documentSymbol(path: string): Promise<DocumentSymbolInfo[]> {
    await this.open(path);
    const absolute = this.absolute(path);
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(absolute).href },
    });
    if (!Array.isArray(result)) return [];
    const symbols: DocumentSymbolInfo[] = [];
    const walk = (items: any[], container: string | null) => {
      for (const item of items) {
        if (item.location) {
          symbols.push({
            name: item.name,
            kind: item.kind,
            container: item.containerName ?? container,
            location: this.toLocation(item.location.uri, item.location.range),
          });
        } else {
          symbols.push({
            name: item.name,
            kind: item.kind,
            container,
            location: this.toLocation(pathToFileURL(absolute).href, item.range, item.selectionRange),
          });
          if (Array.isArray(item.children)) walk(item.children, item.name);
        }
      }
    };
    walk(result, null);
    return symbols;
  }

  async workspaceSymbol(query: string): Promise<DocumentSymbolInfo[]> {
    const result = await this.request("workspace/symbol", { query });
    if (!Array.isArray(result)) return [];
    const empty: LspRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return result.map((item: any) => ({
      name: item.name,
      kind: item.kind,
      container: item.containerName || null,
      location: this.toLocation(item.location.uri, item.location.range ?? empty),
    }));
  }

  async incomingCalls(position: Position): Promise<IncomingCall[]> {
    const items = await this.request("textDocument/prepareCallHierarchy", await this.positionParams(position));
    if (!Array.isArray(items)) return [];
    const calls: IncomingCall[] = [];
    for (const item of items) {
      const result = await this.request("callHierarchy/incomingCalls", { item });
      if (!Array.isArray(result)) continue;
      for (const call of result as any[]) {
        calls.push({
          name: call.from.name,
          kind: call.from.kind,
          location: this.toLocation(call.from.uri, call.from.range, call.from.selectionRange),
          callSites: (call.fromRanges as LspRange[]).map((range) => this.toLocation(call.from.uri, range)),
        });
      }
    }
    return calls;
  }

  async shutdown(): Promise<void> {
    if (!this.exited) {
      try {
        await this.request("shutdown", null, SHUTDOWN_GRACE_MS);
        this.notify("exit", null);
        const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SHUTDOWN_GRACE_MS));
        if ((await Promise.race([this.exitPromise, timeout])) === "timeout") this.kill();
      } catch {
        this.kill();
      }
      await this.exitPromise;
    }
    this.kill();
  }

  kill(): void {
    if (IS_WINDOWS) {
      if (!this.exited) killTree(this.pid);
      return;
    }
    for (const target of this.exited ? [-this.pid] : [-this.pid, this.pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error(`language server pid ${this.pid} is not running`));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.writeLog(`timeout ${method} after ${timeoutMs} ms; killing pid ${this.pid}`);
        this.kill();
        reject(new LspTimeoutError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? realpathSync(path) : join(this.corpusRoot, path);
  }

  private lines(absolute: string): string[] | null {
    const cached = this.lineCache.get(absolute);
    if (cached) return cached;
    try {
      const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
      this.lineCache.set(absolute, lines);
      return lines;
    } catch {
      return null;
    }
  }

  private async positionParams(position: Position) {
    await this.open(position.path);
    const absolute = this.absolute(position.path);
    const lineText = this.lines(absolute)?.[position.line - 1];
    if (lineText === undefined) throw new Error(`${position.path} has no line ${position.line}`);
    return {
      textDocument: { uri: pathToFileURL(absolute).href },
      position: { line: position.line - 1, character: charColumnToUtf16(lineText, position.column) },
    };
  }

  private locations(result: unknown): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((item: any) =>
      item.targetUri
        ? this.toLocation(item.targetUri, item.targetRange, item.targetSelectionRange)
        : this.toLocation(item.uri, item.range),
    );
  }

  private toLocation(uri: string, range: LspRange, selection: LspRange = range): Location {
    const absolute = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    const rel = relative(this.corpusRoot, absolute);
    const insideRoot = uri.startsWith("file:") && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    const lineText = uri.startsWith("file:") ? this.lines(absolute)?.[selection.start.line] : undefined;
    const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1;
    return {
      path: insideRoot ? rel.split(sep).join("/") : absolute,
      startLine: range.start.line + 1,
      endLine,
      line: selection.start.line + 1,
      column: lineText === undefined ? selection.start.character + 1 : utf16ToCharColumn(lineText, selection.start.character),
      insideRoot,
    };
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
    this.proc.stdin.flush();
  }

  private async pump(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
      this.parseMessages();
    }
  }

  private parseMessages(): void {
    for (;;) {
      const headerEnd = Buffer.from(this.buffer).indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = Buffer.from(this.buffer.subarray(0, headerEnd)).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`malformed LSP header: ${header}`);
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = Buffer.from(this.buffer.subarray(start, start + length)).toString("utf8");
      this.buffer = this.buffer.slice(start + length);
      this.dispatch(JSON.parse(body));
    }
  }

  private dispatch(message: any): void {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.code} ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: message.id, result: this.answerServerRequest(message.method, message.params) });
      return;
    }
    if (message.method === "window/logMessage" || message.method === "window/showMessage") {
      this.writeLog(`${message.method}: ${message.params?.message}`);
    }
    this.onNotification?.(message.method, message.params);
  }

  private answerServerRequest(method: string, params: any): unknown {
    switch (method) {
      case "workspace/configuration":
        return (params?.items ?? []).map((item: { section?: string }) => this.configuration?.[item?.section ?? ""] ?? null);
      case "workspace/workspaceFolders":
        return [{ uri: pathToFileURL(this.corpusRoot).href, name: "root" }];
      default:
        return null;
    }
  }

  private async drainStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) this.writeLog(`stderr: ${decoder.decode(chunk)}`);
  }

  private writeLog(line: string): void {
    if (this.log) appendFileSync(this.log, `${new Date().toISOString()} ${line.trimEnd()}\n`);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
