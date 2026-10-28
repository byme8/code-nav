import { createConnection } from "node:net";
import type { Reply } from "../output.ts";

export interface Request {
  argv: string[];
  cwd: string;
}

export const PING = "__ping";

export class TransportError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function send(socketPath: string, request: Request, timeoutMs: number | null): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn();
    };
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            socket.destroy();
            settle(() => reject(new TransportError(`no reply within ${timeoutMs / 1000} s`, "timeout")));
          }, timeoutMs);
    socket.on("connect", () => socket.end(JSON.stringify(request)));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      const reason =
        e.code === "ENOENT" ? "socket missing" : e.code === "ECONNREFUSED" ? "connection refused" : `socket error ${e.code ?? e.message}`;
      settle(() => reject(new TransportError(reason, e.message)));
    });
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const reply = JSON.parse(text) as Reply;
        settle(() => resolve(reply));
      } catch {
        settle(() => reject(new TransportError("connection closed without a reply", "bad reply")));
      }
    });
    socket.on("close", () => settle(() => reject(new TransportError("connection closed without a reply", "closed"))));
  });
}
