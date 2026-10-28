import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FreshnessReport } from "../daemon/freshness.ts";
import { serverSelected } from "../languages.ts";
import { resolveExecutable } from "../platform.ts";
import { LspClient, type WatchedFileChange } from "./client.ts";
import { ANGULAR_LS_NAME, angularLaunch, serverCommand, type AngularLaunch } from "./servers.ts";
import type { ServerRecord } from "../daemon/state.ts";
import { resolvesAngularCore } from "../index/angular.ts";
import type { SyntaxIndex } from "../index/index.ts";
import type { ToolLanguage } from "../index/symbols.ts";
import { sourceLanguage, type ConfigOwner } from "../index/walk.ts";
import { ToolError, failure } from "../output.ts";
import { stdProblem, sysrootSource } from "../rust-src.ts";

export type Owner = ConfigOwner;
export type SlotKind = Owner | "angular";
export type ServerLanguage = SlotKind;

export const SERVER_NAMES: Record<SlotKind, string> = {
  csharp: "csharp-ls",
  typescript: "typescript-language-server",
  rust: "rust-analyzer",
  angular: ANGULAR_LS_NAME,
};

const ALL_OWNERS: readonly Owner[] = ["csharp", "typescript", "rust"];

export function serverOwner(language: ToolLanguage | null): SlotKind | null {
  return language === "csharp" || language === "typescript" || language === "rust" || language === "angular" ? language : null;
}

const REQUEST_TIMEOUT_MS = 120_000;
const SOLUTION_LOAD_TIMEOUT_MS = 600_000;
const STOP_GRACE_MS = 1_500;
const CSHARP_LOADED = /Finished loading solution/;
const CSHARP_LOAD_TRIGGER = "CodeNavSolutionLoad";
const ANGULAR_LOADED = "angular/projectLoadingFinish";
const CARGO_WORKSPACE = /^\s*\[workspace\]\s*(?:#.*)?$/m;

function rustAnalyzerSettings(manifest: string, sysrootSrc: string | null): Record<string, unknown> {
  return {
    cargo: { buildScripts: { enable: false }, ...(sysrootSrc === null ? {} : { sysrootSrc }) },
    procMacro: { enable: false },
    checkOnSave: false,
    linkedProjects: [manifest],
  };
}
export class ServerUnavailable extends ToolError {
  constructor(
    readonly server: string,
    readonly reason: string,
  ) {
    super(failure(`${server} not available: ${reason}`));
  }
}

class Slot {
  spawned: LspClient | null = null;
  client: LspClient | null = null;
  ready: Promise<LspClient> | null = null;
  loaded = false;
  crashes = 0;
  generation = 0;
  stdProblem: string | null = null;
  command: string | null = null;
  unavailable: string | null;

  constructor(
    readonly owner: SlotKind,
    readonly workspace: string,
    readonly solution: string | null,
    missing: string | null = null,
  ) {
    this.unavailable = missing;
  }

  get name(): string {
    return SERVER_NAMES[this.owner];
  }
}

export interface Acquired {
  client: LspClient;
  name: string;
  waitedMs: number;
  stdProblem: string | null;
}

function executable(slot: Slot): string {
  return slot.command ?? (slot.owner === "angular" ? "node" : serverCommand(slot.owner));
}

function angularArgs(launch: AngularLaunch, projectDir: string): string[] {
  const probes = `${projectDir},${launch.packageDir}`;
  return [launch.script, "--stdio", "--tsProbeLocations", probes, "--ngProbeLocations", probes];
}

function depth(path: string): number {
  return path.split("/").length;
}

function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function within(dir: string, path: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

function parentDir(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "" : dir;
}

export function discoverSolution(paths: Iterable<string>): string | null {
  const solutions = [...paths].filter((p) => /\.(?:slnx|sln)$/.test(p));
  solutions.sort((a, b) => depth(a) - depth(b) || Number(b.endsWith(".slnx")) - Number(a.endsWith(".slnx")) || byBytes(a, b));
  return solutions[0] ?? null;
}

export function discoverTypescriptRoots(paths: Iterable<string>): string[] {
  const dirs = [...paths].filter((p) => p === "tsconfig.json" || p.endsWith("/tsconfig.json")).map(parentDir);
  dirs.sort((a, b) => depth(a) - depth(b) || byBytes(a, b));
  const roots: string[] = [];
  for (const dir of dirs) if (!roots.some((r) => r === dir || within(r, dir))) roots.push(dir);
  return roots.sort(byBytes);
}

function isCargoWorkspace(manifest: string): boolean {
  try {
    return CARGO_WORKSPACE.test(readFileSync(manifest, "utf8"));
  } catch {
    return false;
  }
}

export function discoverCargoRoots(root: string, paths: Iterable<string>): string[] {
  const packages = [...paths].filter((p) => p === "Cargo.toml" || p.endsWith("/Cargo.toml")).map(parentDir);
  const workspaces = packages.filter((dir) => isCargoWorkspace(join(root, dir, "Cargo.toml")));
  const roots = new Set<string>();
  for (const dir of packages) {
    let nearest: string | null = null;
    for (const w of workspaces) {
      if ((w === dir || within(w, dir)) && (nearest === null || w.length > nearest.length)) nearest = w;
    }
    roots.add(nearest ?? dir);
  }
  return [...roots].sort(byBytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ServerPool {
  private slots: Slot[] = [];
  private stopping = false;
  private stdNoteGiven = false;
  private index: SyntaxIndex | null = null;

  constructor(
    private readonly root: string,
    private readonly logDir: string,
    private readonly log: (line: string) => void,
    private readonly onServersChanged: (servers: ServerRecord[]) => void,
  ) {}

  configure(index: SyntaxIndex, configOwners: readonly Owner[] = ALL_OWNERS): void {
    this.index = index;
    const owners: SlotKind[] = configOwners.includes("typescript") ? [...configOwners, "angular"] : [...configOwners];
    for (const owner of owners) {
      const active = new Set(this.slots.filter((s) => s.owner === owner && s.ready !== null).map((s) => s.workspace));
      for (const slot of this.slots.filter((s) => s.owner === owner)) this.retire(slot);
      this.slots = this.slots.filter((s) => s.owner !== owner);
      const fresh: Slot[] = [];
      if (owner === "csharp") {
        const solution = discoverSolution(index.stamps.keys());
        fresh.push(
          solution === null
            ? new Slot("csharp", "", null, "no .slnx or .sln solution in the tree")
            : new Slot("csharp", parentDir(solution), solution),
        );
      } else if (owner === "rust") {
        for (const dir of discoverCargoRoots(this.root, index.stamps.keys())) {
          fresh.push(new Slot("rust", dir, dir === "" ? "Cargo.toml" : `${dir}/Cargo.toml`));
        }
      } else if (owner === "angular") {
        for (const dir of discoverTypescriptRoots(index.stamps.keys())) {
          if (resolvesAngularCore(join(this.root, dir), this.root)) fresh.push(new Slot("angular", dir, null));
        }
      } else {
        const roots = discoverTypescriptRoots(index.stamps.keys());
        if (roots.length === 0) fresh.push(new Slot("typescript", "", null, "no tsconfig.json in the tree"));
        for (const dir of roots) fresh.push(new Slot("typescript", dir, null));
      }
      if (!serverSelected(owner)) {
        for (const slot of fresh) slot.unavailable ??= `not selected; add it with \`code-nav install --lang ${owner}\``;
      }
      this.slots.push(...fresh);
      for (const slot of fresh) if (slot.unavailable === null && active.has(slot.workspace)) this.start(slot);
    }
    this.publish();
  }

  servers(): ServerRecord[] {
    const out: ServerRecord[] = [];
    for (const slot of this.slots) {
      if (slot.spawned?.isRunning === true) {
        out.push({ name: slot.name, pid: slot.spawned.pid, command: executable(slot), workspace: slot.workspace });
      }
    }
    return out;
  }

  describe(): string[] {
    return this.slots.map((slot) => {
      const where = slot.workspace === "" ? "." : slot.workspace;
      if (slot.unavailable !== null) return `server ${slot.name} ${where} not available: ${slot.unavailable}`;
      if (slot.ready === null) return `server ${slot.name} ${where} idle (starts on first use)`;
      const pid = slot.spawned?.isRunning === true ? `pid ${slot.spawned.pid}` : "no process";
      return `server ${slot.name} ${where} ${pid} ${slot.loaded ? "ready" : "starting"}`;
    });
  }

  hasAngular(path: string): boolean {
    return this.slotOrNull("angular", path) !== null;
  }

  claimStdNote(): boolean {
    if (this.stdNoteGiven) return false;
    this.stdNoteGiven = true;
    return true;
  }

  async acquire(language: ToolLanguage, path: string): Promise<Acquired> {
    const slot = this.slotFor(language, path);
    const t0 = performance.now();
    for (;;) {
      if (slot.unavailable !== null) throw this.notAvailable(slot);
      if (slot.ready === null) this.start(slot);
      const pending = slot.ready!;
      try {
        const client = await pending;
        return { client, name: slot.name, waitedMs: performance.now() - t0, stdProblem: slot.stdProblem };
      } catch (e) {
        if (slot.unavailable !== null) throw this.notAvailable(slot);
        if (slot.ready !== pending) continue;
        throw new ToolError(failure(`${slot.name} failed: ${(e as Error).message}`));
      }
    }
  }

  async run<T>(language: ToolLanguage, path: string, request: (client: LspClient) => Promise<T>): Promise<{ result: T; acquired: Acquired }> {
    const first = await this.acquire(language, path);
    try {
      return { result: await request(first.client), acquired: first };
    } catch (e) {
      if (first.client.isRunning) throw new ToolError(failure(`${first.name} request failed: ${(e as Error).message}`));
      this.log(`${first.name} died during a request (${(e as Error).message}); retrying once`);
      const again = await this.acquire(language, path);
      try {
        const result = await request(again.client);
        return { result, acquired: { ...again, waitedMs: first.waitedMs + again.waitedMs } };
      } catch (e2) {
        throw new ToolError(failure(`${again.name} request failed: ${(e2 as Error).message}`));
      }
    }
  }

  async onFreshness(index: SyntaxIndex, report: FreshnessReport): Promise<void> {
    const restarted = new Set<Owner>(report.configChanged.keys());
    if (restarted.size > 0) {
      const why = [...report.configChanged.values()].flat();
      this.log(`restarting ${[...restarted].map((o) => SERVER_NAMES[o]).join(", ")} after ${why.join(", ")}`);
      this.configure(index, [...restarted]);
    }
    const bySlot = new Map<Slot, { path: string; change: WatchedFileChange }[]>();
    const add = (path: string, change: WatchedFileChange): void => {
      const owner = serverOwner(sourceLanguage(path));
      const kinds: SlotKind[] = owner === "typescript" ? ["typescript", "angular"] : owner === null ? [] : [owner];
      for (const kind of kinds) {
        if (restarted.has(kind === "angular" ? "typescript" : kind)) continue;
        const slot = this.slotOrNull(kind, path);
        if (slot?.client?.isRunning !== true) continue;
        bySlot.set(slot, [...(bySlot.get(slot) ?? []), { path, change }]);
      }
    };
    for (const path of report.created) add(path, "created");
    for (const path of report.changed) add(path, "changed");
    for (const path of report.deleted) add(path, "deleted");
    for (const [slot, changes] of bySlot) {
      const client = slot.client!;
      for (const { path, change } of changes) {
        if (change === "deleted") client.forget(path);
        else if (slot.owner !== "csharp" && !client.isOpen(path)) await client.open(path);
        else client.reload(path);
      }
      client.watchedFilesChanged(changes);
    }
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const initialized = this.slots.flatMap((s) => (s.client === null ? [] : [s.client]));
    const spawned = this.slots.flatMap((s) => (s.spawned === null ? [] : [s.spawned]));
    for (const slot of this.slots) slot.generation++;
    await Promise.race([Promise.allSettled(initialized.map((c) => c.shutdown())), sleep(STOP_GRACE_MS)]);
    for (const client of spawned) client.kill();
    this.slots = [];
    this.publish();
  }

  killAll(): void {
    for (const slot of this.slots) slot.spawned?.kill();
  }

  private slotOrNull(owner: SlotKind, path: string): Slot | null {
    if (owner === "csharp") return this.slots.find((s) => s.owner === owner) ?? null;
    let best: Slot | null = null;
    for (const slot of this.slots) {
      if (slot.owner !== owner || !within(slot.workspace, path)) continue;
      if (best === null || slot.workspace.length > best.workspace.length) best = slot;
    }
    return best;
  }

  private slotFor(language: ToolLanguage, path: string): Slot {
    const owner = serverOwner(language);
    if (owner === null) throw new ToolError(failure(`no language server for ${language}`));
    const slot = this.slotOrNull(owner, path);
    if (slot !== null) return slot;
    if (owner === "angular") throw new ServerUnavailable(SERVER_NAMES[owner], `no Angular project (a tsconfig.json resolving @angular/core) above ${path}`);
    const missing = owner === "rust" ? "Cargo.toml" : "tsconfig.json";
    throw new ServerUnavailable(SERVER_NAMES[owner], `no ${missing} above ${path}`);
  }

  private notAvailable(slot: Slot): ServerUnavailable {
    return new ServerUnavailable(slot.name, slot.unavailable ?? "unknown");
  }

  private publish(): void {
    this.onServersChanged(this.servers());
  }

  private retire(slot: Slot): void {
    slot.generation++;
    slot.ready = null;
    const client = slot.client;
    const spawned = slot.spawned;
    slot.client = null;
    slot.spawned = null;
    if (spawned === null) return;
    this.log(`stopping ${slot.name} pid ${spawned.pid}`);
    if (client === null) spawned.kill();
    else void Promise.race([client.shutdown(), sleep(STOP_GRACE_MS)]).finally(() => client.kill());
  }

  private start(slot: Slot): void {
    const generation = ++slot.generation;
    slot.loaded = false;
    slot.ready = this.launch(slot, generation);
    slot.ready.catch(() => undefined);
  }

  private angularOpener(slot: Slot): string | null {
    const files = [...(this.index?.files.values() ?? [])].filter((f) => within(slot.workspace, f.path)).sort((a, b) => byBytes(a.path, b.path));
    const component = files.find((f) => f.language === "typescript" && f.symbols.some((s) => s.kind === "selector"));
    return (component ?? files.find((f) => f.language === "angular") ?? files.find((f) => f.language === "typescript"))?.path ?? null;
  }

  private async launch(slot: Slot, generation: number): Promise<LspClient> {
    const cwd = join(this.root, slot.workspace);
    let resolved: string | null;
    let args: string[];
    if (slot.owner === "angular") {
      const launch = angularLaunch();
      if (typeof launch === "string") {
        if (generation === slot.generation) slot.unavailable = launch;
        throw new Error(launch);
      }
      slot.command = launch.script;
      resolved = launch.node;
      args = angularArgs(launch, cwd);
    } else {
      const command = executable(slot);
      resolved = resolveExecutable(command);
      if (resolved === null) {
        if (generation === slot.generation) slot.unavailable = `executable not found: ${command}`;
        throw new Error(`executable not found: ${command}`);
      }
      const prefix = slot.workspace === "" ? 0 : slot.workspace.length + 1;
      args = slot.owner === "csharp" ? ["--solution", slot.solution!.slice(prefix)] : slot.owner === "typescript" ? ["--stdio"] : [];
    }
    let markLoaded = (): void => undefined;
    const loaded = new Promise<void>((resolve) => (markLoaded = resolve));
    const rustStatus = { health: "", message: "" };
    let rustSettings: Record<string, unknown> | undefined;
    if (slot.owner === "rust") {
      const source = sysrootSource(cwd);
      if (source !== null) this.log(`${slot.name} cargo.sysrootSrc ${source.path} (from ${source.from})`);
      rustSettings = rustAnalyzerSettings(join(this.root, slot.solution!), source?.path ?? null);
    }
    const t0 = performance.now();
    let client: LspClient;
    try {
      client = await LspClient.start({
        command: [resolved, ...args],
        cwd,
        corpusRoot: this.root,
        workspaceRoot: cwd,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        log: join(this.logDir, `${slot.name}${slot.workspace === "" ? "" : `-${slot.workspace.replaceAll("/", "_")}`}.log`),
        initializationOptions: slot.owner === "typescript" ? { tsserver: { useSyntaxServer: "never" } } : rustSettings,
        ...(rustSettings === undefined
          ? {}
          : {
              experimentalCapabilities: { serverStatusNotification: true },
              configuration: { "rust-analyzer": rustSettings },
              env: { CARGO_NET_OFFLINE: "true" },
            }),
        onNotification: (method, params) => {
          if (slot.owner === "csharp" && method === "window/logMessage" && CSHARP_LOADED.test(String(params?.message ?? ""))) markLoaded();
          if (slot.owner === "angular" && method === ANGULAR_LOADED) markLoaded();
          if (slot.owner === "rust" && method === "experimental/serverStatus" && params?.quiescent === true) {
            rustStatus.health = String(params.health ?? "");
            rustStatus.message = String(params.message ?? "").trim();
            markLoaded();
          }
        },
        onSpawn: (spawned) => {
          if (generation !== slot.generation || this.stopping) {
            spawned.kill();
            return;
          }
          slot.spawned = spawned;
          this.log(`spawned ${slot.name} pid ${spawned.pid} in ${slot.workspace === "" ? "." : slot.workspace}`);
          this.publish();
        },
      });
    } catch (e) {
      if (generation === slot.generation) {
        slot.unavailable = `failed to start: ${(e as Error).message}`;
        slot.spawned = null;
        this.publish();
      }
      throw e;
    }
    if (generation !== slot.generation || this.stopping) {
      client.kill();
      throw new Error(`${slot.name} start superseded`);
    }
    slot.client = client;
    this.log(`started ${slot.name} pid ${client.pid} in ${slot.workspace === "" ? "." : slot.workspace}`);
    this.publish();
    void client.waitForExit().then((code) => this.exited(slot, client, generation, code));
    const opener = slot.owner === "angular" ? this.angularOpener(slot) : null;
    if (slot.owner === "csharp" || slot.owner === "rust" || opener !== null) {
      if (slot.owner === "csharp") {
        client.request("workspace/symbol", { query: CSHARP_LOAD_TRIGGER }, SOLUTION_LOAD_TIMEOUT_MS).catch(() => undefined);
      }
      if (opener !== null) {
        this.log(`${slot.name} opening ${opener} to load the project`);
        await client.open(opener);
      }
      const outcome = await Promise.race([
        loaded.then(() => "loaded" as const),
        client.waitForExit().then(() => "exited" as const),
        sleep(SOLUTION_LOAD_TIMEOUT_MS).then(() => "timeout" as const),
      ]);
      if (outcome === "exited") throw new Error(`exited while loading ${slot.solution ?? opener}`);
      const giveUp = (reason: string): Error => {
        if (generation === slot.generation) {
          slot.unavailable = reason;
          slot.generation++;
          slot.client = null;
          slot.spawned = null;
          this.publish();
        }
        client.kill();
        return new Error(reason);
      };
      if (outcome === "timeout") {
        const what = slot.owner === "csharp" ? "solution load" : slot.owner === "angular" ? "project load" : "workspace load";
        throw giveUp(`${what} did not finish in ${SOLUTION_LOAD_TIMEOUT_MS / 1000} s`);
      }
      if (slot.owner === "rust" && rustStatus.health === "error") {
        throw giveUp(`failed to load ${slot.solution}: ${rustStatus.message.split("\n")[0] || "health error"}`);
      }
      if (slot.owner === "rust" && generation === slot.generation) slot.stdProblem = stdProblem(rustStatus.message);
      const health = slot.owner === "rust" && rustStatus.health !== "ok" ? ` (health ${rustStatus.health}: ${rustStatus.message.replace(/\s+/g, " ")})` : "";
      this.log(`${slot.name} loaded ${slot.solution ?? opener} in ${((performance.now() - t0) / 1000).toFixed(1)} s${health}`);
    }
    if (generation === slot.generation) slot.loaded = true;
    return client;
  }

  private exited(slot: Slot, client: LspClient, generation: number, code: number): void {
    if (generation !== slot.generation || this.stopping) return;
    slot.client = null;
    slot.spawned = null;
    slot.loaded = false;
    slot.crashes++;
    this.log(`${slot.name} pid ${client.pid} exited with ${code} (crash ${slot.crashes})`);
    if (slot.crashes >= 2) {
      slot.unavailable = `crashed twice (last exit code ${code})`;
      slot.ready = null;
      slot.generation++;
    } else {
      this.start(slot);
    }
    this.publish();
  }
}
