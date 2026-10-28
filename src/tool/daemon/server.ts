import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { runCommand, COMMANDS } from "../commands/index.ts";
import { SyntaxIndex } from "../index/index.ts";
import { ServerPool } from "../lsp/pool.ts";
import { failure, success, type Reply } from "../output.ts";
import { IS_WINDOWS } from "../platform.ts";
import { bringUpToDate, type FreshnessListener, type FreshnessReport } from "./freshness.ts";
import { PING, type Request } from "./protocol.ts";
import { TOOL_VERSION, idleMs, readDaemonInfo, statePaths, type DaemonInfo, type ServerRecord } from "./state.ts";

export async function runDaemon(root: string): Promise<void> {
  const paths = statePaths(root);
  mkdirSync(paths.dir, { recursive: true });
  const log = (line: string): void => {
    try {
      appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
      return;
    }
  };
  const listeners: FreshnessListener[] = [];
  const index = new SyntaxIndex(root);
  const startedAt = performance.now();
  const initial = await bringUpToDate(index, listeners);
  log(`indexed ${index.files.size} files in ${(performance.now() - startedAt).toFixed(0)} ms (walk ${initial.scanMs.toFixed(0)} ms)`);
  let lastScan: FreshnessReport | null = null;
  const idle = idleMs();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let inFlight = 0;
  let info: DaemonInfo | null = null;

  const writeInfo = (servers: ServerRecord[]): void => {
    if (info === null || stopping) return;
    info = { ...info, servers };
    writeFileSync(paths.info, JSON.stringify(info));
  };
  const pool = new ServerPool(root, paths.dir, log, writeInfo);
  listeners.push((report) => pool.onFreshness(index, report));

  const server = createServer({ allowHalfOpen: true });

  const shutdown = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    log(`stopping: ${why}`);
    server.close();
    await pool.stopAll();
    if (readDaemonInfo(paths)?.pid === process.pid) rmSync(paths.dir, { recursive: true, force: true });
    process.exit(0);
  };

  const armIdle = (): void => {
    if (stopping) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void shutdown(`idle for ${idle} ms`), idle);
  };

  const status = (): Reply => {
    const lines = [
      `daemon ${process.pid} for ${root}`,
      `version ${TOOL_VERSION}`,
      `files indexed ${index.files.size}`,
      `uptime ${((performance.now() - startedAt) / 1000).toFixed(0)} s`,
      `idle shutdown after ${idle} ms`,
      ...pool.describe(),
    ];
    if (lastScan !== null) {
      lines.push(
        `last freshness scan ${lastScan.scanMs.toFixed(1)} ms over ${lastScan.paths} paths, update ${lastScan.updateMs.toFixed(1)} ms ` +
          `(${lastScan.created.length} created, ${lastScan.changed.length} changed, ${lastScan.deleted.length} deleted)`,
      );
    }
    return success(lines);
  };

  const immediate = (name: string | undefined): Reply | null => {
    if (name === PING) return success([String(index.files.size), TOOL_VERSION]);
    if (name === "status") return status();
    return null;
  };

  const handle = async (request: Request): Promise<{ reply: Reply; after?: () => void }> => {
    const [name, ...args] = request.argv;
    if (name === "stop") return { reply: success(["daemon stopped"]), after: () => void shutdown("stop requested") };
    if (name === undefined) return { reply: failure("no command") };
    const command = COMMANDS[name];
    if (command?.needsFreshIndex === true) {
      lastScan = await bringUpToDate(index, listeners);
      log(
        `scan ${lastScan.scanMs.toFixed(1)} ms update ${lastScan.updateMs.toFixed(1)} ms ` +
          `+${lastScan.created.length} ~${lastScan.changed.length} -${lastScan.deleted.length}`,
      );
    }
    const t0 = performance.now();
    const reply = await runCommand(name, { index, root, cwd: request.cwd, args, servers: pool });
    log(`${name} exit ${reply.exitCode} in ${(performance.now() - t0).toFixed(1)} ms`);
    return { reply };
  };

  const answer = (socket: Socket, reply: Reply): Promise<void> =>
    new Promise<void>((resolve) => socket.end(JSON.stringify(reply), () => resolve()));

  let queue: Promise<void> = Promise.resolve();
  server.on("connection", (socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("end", () => {
      let request: Request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
      } catch (e) {
        void answer(socket, failure(`bad request: ${(e as Error).message}`));
        return;
      }
      const quick = immediate(request.argv[0]);
      if (quick !== null) {
        void answer(socket, quick);
        if (inFlight === 0) armIdle();
        return;
      }
      inFlight++;
      if (idleTimer !== null) clearTimeout(idleTimer);
      queue = queue.then(async () => {
        let outcome: { reply: Reply; after?: () => void };
        try {
          outcome = await handle(request);
        } catch (e) {
          log(`request failed: ${(e as Error).stack ?? String(e)}`);
          outcome = { reply: failure((e as Error).message ?? String(e)) };
        }
        await answer(socket, outcome.reply);
        inFlight--;
        if (outcome.after !== undefined) outcome.after();
        else if (inFlight === 0) armIdle();
      });
    });
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown(signal));
  process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? String(e)}`));
  process.on("exit", () => pool.killAll());

  if (!IS_WINDOWS) rmSync(paths.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => resolve());
  });
  info = { pid: process.pid, root, version: TOOL_VERSION, startedAt: new Date().toISOString(), servers: [] };
  writeFileSync(paths.info, JSON.stringify(info));
  armIdle();
  log(`listening on ${paths.socket}`);
  pool.configure(index);
}
