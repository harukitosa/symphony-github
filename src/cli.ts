import { basename, resolve } from "node:path";
import { err, ok, type Result } from "./result";

export const ACK_FLAG = "--i-understand-that-this-will-be-running-without-the-usual-guardrails";

export type CliDeps = {
  fileRegular: (path: string) => Promise<boolean> | boolean;
  setWorkflowFilePath: (path: string) => Promise<void> | void;
  setLogsRoot: (path: string) => Promise<void> | void;
  setServerPortOverride: (port: number | null) => Promise<void> | void;
  ensureAllStarted: () => Promise<Result<string[], unknown>> | Result<string[], unknown>;
};

export async function evaluateCli(args: string[], deps: CliDeps): Promise<Result<void, string>> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return err(usageMessage());
  if (!parsed.value.acknowledged) return err(acknowledgementBanner());

  if (parsed.value.logsRoot !== undefined) {
    if (parsed.value.logsRoot.trim() === "") return err(usageMessage());
    await deps.setLogsRoot(resolve(parsed.value.logsRoot));
  }

  if (parsed.value.port !== undefined) await deps.setServerPortOverride(parsed.value.port);

  return runCli(parsed.value.workflowPath ?? "WORKFLOW.md", deps);
}

async function runCli(workflowPath: string, deps: CliDeps): Promise<Result<void, string>> {
  const expandedPath = resolve(workflowPath);
  if (!(await deps.fileRegular(expandedPath))) return err(`Workflow file not found: ${expandedPath}`);

  await deps.setWorkflowFilePath(expandedPath);
  const started = await deps.ensureAllStarted();
  if (!started.ok) return err(`Failed to start Symphony with workflow ${expandedPath}: ${String(started.error)}`);
  return ok(undefined);
}

function parseArgs(args: string[]): Result<{
  acknowledged: boolean;
  logsRoot?: string;
  port?: number;
  workflowPath?: string;
}, string> {
  let acknowledged = false;
  let logsRoot: string | undefined;
  let port: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === ACK_FLAG) {
      acknowledged = true;
    } else if (arg === "--logs-root") {
      const value = args[++index];
      if (value === undefined) return err("usage");
      logsRoot = value;
    } else if (arg === "--port") {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value)) return err("usage");
      port = Number(value);
    } else if (arg?.startsWith("--")) {
      return err("usage");
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return err("usage");
  const parsed: {
    acknowledged: boolean;
    logsRoot?: string;
    port?: number;
    workflowPath?: string;
  } = { acknowledged };
  if (logsRoot !== undefined) parsed.logsRoot = logsRoot;
  if (port !== undefined) parsed.port = port;
  if (positional[0] !== undefined) parsed.workflowPath = positional[0];
  return ok(parsed);
}

function usageMessage(): string {
  return "Usage: symphony [--logs-root <path>] [--port <port>] [path-to-WORKFLOW.md]";
}

function acknowledgementBanner(): string {
  return [
    "This Symphony implementation is a low key engineering preview.",
    "Codex will run without any guardrails.",
    "SymphonyElixir is not a supported product and is presented as-is.",
    `To proceed, start with \`${ACK_FLAG}\` CLI argument`,
  ].join("\n");
}
