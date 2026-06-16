import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, makeTempRoot } from "./support";
import { buildSshArgs, remoteShellCommand, runSsh, startSshProcess } from "../src/ssh";
import { err } from "../src/result";

let root: string;
let previousPath: string | undefined;
let previousConfig: string | undefined;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-ssh");
  previousPath = process.env.PATH;
  previousConfig = process.env.SYMPHONY_SSH_CONFIG;
});

afterEach(async () => {
  restoreEnv("PATH", previousPath);
  restoreEnv("SYMPHONY_SSH_CONFIG", previousConfig);
  await cleanup(root);
});

describe("ssh", () => {
  test("builds ssh args for host:port, user@host:port, and bracketed IPv6 targets", () => {
    expect(buildSshArgs("localhost:2222", "echo ready")).toEqual([
      "-T",
      "-p",
      "2222",
      "localhost",
      "bash -lc 'echo ready'",
    ]);
    expect(buildSshArgs("root@127.0.0.1:2200", "printf ok")).toContain("root@127.0.0.1");
    expect(buildSshArgs("root@[::1]:2200", "printf ok")).toContain("root@[::1]");
    expect(buildSshArgs("root@[::1]:2200", "printf ok")).toContain("2200");
  });

  test("leaves unbracketed IPv6-style targets unchanged", () => {
    expect(buildSshArgs("::1:2200", "printf ok")).toEqual(["-T", "::1:2200", "bash -lc 'printf ok'"]);
  });

  test("includes optional ssh config and escapes remote shell commands", () => {
    process.env.SYMPHONY_SSH_CONFIG = "/tmp/symphony-test-ssh-config";
    expect(buildSshArgs("localhost", "printf 'hello'")).toEqual([
      "-F",
      "/tmp/symphony-test-ssh-config",
      "-T",
      "localhost",
      "bash -lc 'printf '\"'\"'hello'\"'\"''",
    ]);
    expect(remoteShellCommand("printf 'hello'")).toBe("bash -lc 'printf '\"'\"'hello'\"'\"''");
  });

  test("runs ssh through PATH and returns ssh_not_found when unavailable", async () => {
    const traceFile = join(root, "ssh.trace");
    await installFakeSsh(traceFile);

    const result = await runSsh("localhost:2222", "echo ready");
    expect(result.ok).toBe(true);
    expect(await readFile(traceFile, "utf8")).toContain("-T -p 2222 localhost bash -lc 'echo ready'");

    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    expect(await runSsh("localhost", "printf ok")).toEqual(err("ssh_not_found"));
  });

  test("starts a long-lived ssh process with binary stdout", async () => {
    const traceFile = join(root, "ssh-process.trace");
    await installFakeSsh(
      traceFile,
      `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "${traceFile}"
printf 'ready\\n'
exit 0
`,
    );

    const result = await startSshProcess("localhost", "printf ok");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ssh process did not start");

    const stdout = await collectStream(result.value.process.stdout);
    const exitCode = await waitForExit(result.value.process);
    expect(stdout).toBe("ready\n");
    expect(exitCode).toBe(0);
    expect(await readFile(traceFile, "utf8")).toContain("-T localhost bash -lc 'printf ok'");
  });

  test("starts a long-lived ssh process with line mode", async () => {
    const traceFile = join(root, "ssh-line-process.trace");
    await installFakeSsh(
      traceFile,
      `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "${traceFile}"
printf 'ready\\nsecond\\n'
exit 0
`,
    );

    const result = await startSshProcess("localhost:2222", "printf ok", { lineBytes: 256 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("ssh process did not start");

    const lines: string[] = [];
    for await (const line of result.value.lines ?? []) lines.push(line);
    expect(await waitForExit(result.value.process)).toBe(0);
    expect(lines).toEqual(["ready", "second"]);
    expect(await readFile(traceFile, "utf8")).toContain("-T -p 2222 localhost bash -lc 'printf ok'");

    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;
    expect(await startSshProcess("localhost", "printf ok")).toEqual(err("ssh_not_found"));
  });
});

async function installFakeSsh(traceFile: string, script?: string): Promise<void> {
  const binDir = join(root, "bin");
  const fakeSsh = join(binDir, "ssh");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    fakeSsh,
    script ??
      `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "${traceFile}"
exit 0
`,
  );
  await chmod(fakeSsh, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
}

async function collectStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString();
}

function waitForExit(child: { once(event: "close", listener: (code: number | null) => void): void }): Promise<number | null> {
  return new Promise((resolve) => child.once("close", resolve));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
