export const EXIT = { success: 0, notFound: 1, ambiguous: 2, error: 3 } as const;

export interface Reply {
  exitCode: number;
  stdout: string;
}

function text(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function success(lines: string[]): Reply {
  return { exitCode: EXIT.success, stdout: text(lines) };
}

export function notFound(what: string): Reply {
  return { exitCode: EXIT.notFound, stdout: text([`not found: ${what}`]) };
}

export function ambiguous(what: string, candidates: string[]): Reply {
  return { exitCode: EXIT.ambiguous, stdout: text([`ambiguous: ${what}`, ...candidates]) };
}

export function failure(what: string): Reply {
  return { exitCode: EXIT.error, stdout: text([`error: ${what}`]) };
}

export function prefixed(lines: string[], reply: Reply): Reply {
  return lines.length === 0 ? reply : { ...reply, stdout: text(lines) + reply.stdout };
}

export class ToolError extends Error {
  constructor(readonly reply: Reply) {
    super(reply.stdout.trimEnd());
  }
}

export function symbolHeader(path: string, start: number, end: number, kind: string, name: string): string {
  return `${path}:${start}-${end} ${kind} ${name}`;
}
