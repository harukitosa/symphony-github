import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { err, ok, type Result } from "./result";

export type SshRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type SshProcess = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  lines?: AsyncIterable<string>;
};

export async function runSsh(host: string, command: string): Promise<Result<SshRunResult, unknown>> {
  const executable = await sshExecutable();
  if (!executable.ok) return executable;

  return new Promise((resolve) => {
    const child = spawn(executable.value, buildSshArgs(host, command), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => resolve(err("ssh_not_found")));
    child.on("close", (exitCode) => {
      resolve(ok({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode }));
    });
  });
}

export async function startSshProcess(
  host: string,
  command: string,
  opts: { lineBytes?: number } = {},
): Promise<Result<SshProcess, unknown>> {
  const executable = await sshExecutable();
  if (!executable.ok) return executable;

  const process = spawn(executable.value, buildSshArgs(host, command), { stdio: ["ignore", "pipe", "pipe"] });
  return ok({
    process,
    ...(opts.lineBytes === undefined ? {} : { lines: readLines(process.stdout, opts.lineBytes) }),
  });
}

export function buildSshArgs(host: string, command: string): string[] {
  const target = parseTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    ...(target.port === null ? [] : ["-p", target.port]),
    target.destination,
    remoteShellCommand(command),
  ];
}

export function remoteShellCommand(command: string): string {
  return `bash -lc ${shellEscape(command)}`;
}

async function sshExecutable(): Promise<Result<string, unknown>> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, "ssh");
    try {
      await access(candidate, constants.X_OK);
      return ok(candidate);
    } catch {
      // Keep scanning PATH.
    }
  }
  return err("ssh_not_found");
}

function sshConfigArgs(): string[] {
  const configPath = process.env.SYMPHONY_SSH_CONFIG;
  return typeof configPath === "string" && configPath !== "" ? ["-F", configPath] : [];
}

function parseTarget(target: string): { destination: string; port: string | null } {
  const trimmed = target.trim();
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (match === null) return { destination: trimmed, port: null };

  const [, destination, port] = match;
  if (destination !== undefined && port !== undefined && validPortDestination(destination)) {
    return { destination, port };
  }
  return { destination: trimmed, port: null };
}

function validPortDestination(destination: string): boolean {
  return destination !== "" && (!destination.includes(":") || bracketedHost(destination));
}

function bracketedHost(destination: string): boolean {
  return destination.includes("[") && destination.includes("]");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function* readLines(stream: NodeJS.ReadableStream, maxLineBytes: number): AsyncIterable<string> {
  let pending = "";
  for await (const chunk of stream) {
    pending += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      yield truncateLine(line, maxLineBytes);
      pending = pending.slice(newline + 1);
    }
  }
  if (pending !== "") yield truncateLine(pending.replace(/\r$/, ""), maxLineBytes);
}

function truncateLine(line: string, maxLineBytes: number): string {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) return line;
  const buffer = Buffer.from(line);
  return buffer.length <= maxLineBytes ? line : buffer.subarray(0, maxLineBytes).toString();
}
