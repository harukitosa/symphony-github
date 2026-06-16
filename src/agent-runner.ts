import { settings } from "./config";
import { continueWithIssue } from "./orchestrator";
import { buildPrompt } from "./prompt-builder";
import { ok, err, type Result } from "./result";
import { runAppServer, type AppServerOptions, type AppServerResult } from "./app-server";
import { fetchIssueStatesByIds } from "./tracker";
import { createWorkspaceForIssue, runAfterRunHook, runBeforeRunHook } from "./workspace";
import type { Issue } from "./linear";

export type AgentRunnerEvent =
  | { type: "worker_runtime_info"; issueId: string; workerHost: string | null; workspacePath: string }
  | { type: "codex_worker_update"; issueId: string; message: Record<string, unknown> }
  | Record<string, unknown>;

export type AgentRunnerError =
  | { type: "agent_workspace_failed"; reason: unknown }
  | { type: "agent_before_run_failed"; reason: unknown }
  | { type: "agent_run_failed"; reason: unknown }
  | { type: "agent_issue_refresh_failed"; reason: unknown };

export type AgentRunnerDeps = {
  workerHost?: string | null;
  maxTurns?: number;
  eventSink?: (event: AgentRunnerEvent) => void;
  createWorkspace?: (identifier: string | null | undefined, workerHost: string | null) => Promise<Result<string, unknown>>;
  runBeforeRunHook?: (workspace: string, identifier: unknown, workerHost: string | null) => Promise<Result<void, unknown>>;
  runAfterRunHook?: (workspace: string, identifier: unknown, workerHost: string | null) => Promise<Result<void, unknown>>;
  runAppServer?: (
    workspace: string,
    prompt: string,
    issue: Issue,
    opts: AppServerOptions,
  ) => Promise<Result<AppServerResult, unknown>>;
  buildPrompt?: (issue: Issue, opts?: { attempt?: number | null }) => Promise<string>;
  fetchIssueStatesByIds?: (ids: string[]) => Promise<Result<Issue[], unknown>>;
};

export async function runAgentIssue(issue: Issue, deps: AgentRunnerDeps = {}): Promise<Result<void, AgentRunnerError>> {
  const config = await settings();
  const workerHost = selectedWorkerHost(deps.workerHost, config.worker.ssh_hosts);
  const maxTurns = deps.maxTurns ?? config.agent.max_turns;
  const createWorkspace = deps.createWorkspace ?? createWorkspaceForIssue;
  const beforeRun = deps.runBeforeRunHook ?? runBeforeRunHook;
  const afterRun = deps.runAfterRunHook ?? runAfterRunHook;

  const workspace = await createWorkspace(issue.identifier, workerHost);
  if (!workspace.ok) return err({ type: "agent_workspace_failed", reason: workspace.error });

  sendWorkerRuntimeInfo(deps.eventSink, issue, workerHost, workspace.value);

  try {
    const before = await beforeRun(workspace.value, issue.identifier, workerHost);
    if (!before.ok) return err({ type: "agent_before_run_failed", reason: before.error });

    return await runCodexTurns(workspace.value, issue, workerHost, maxTurns, deps);
  } finally {
    await afterRun(workspace.value, issue.identifier, workerHost);
  }
}

export function continuationPromptForTurn(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous Codex turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace and workpad state instead of restarting from scratch.
- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.
- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}

async function runCodexTurns(
  workspace: string,
  initialIssue: Issue,
  workerHost: string | null,
  maxTurns: number,
  deps: AgentRunnerDeps,
): Promise<Result<void, AgentRunnerError>> {
  const appServer = deps.runAppServer ?? runAppServer;
  const promptBuilder = deps.buildPrompt ?? buildPrompt;
  const issueFetcher = deps.fetchIssueStatesByIds ?? defaultFetchIssueStatesByIds;
  let issue = initialIssue;

  for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
    const prompt =
      turnNumber === 1
        ? await promptBuilder(issue, { attempt: null })
        : continuationPromptForTurn(turnNumber, maxTurns);

    const run = await appServer(workspace, prompt, issue, {
      workerHost,
      onMessage: (message) => sendCodexUpdate(deps.eventSink, issue, message),
    });
    if (!run.ok) return err({ type: "agent_run_failed", reason: run.error });

    const continuation = await continueWithIssue(issue, issueFetcher);
    if (continuation.status === "done") return ok(undefined);
    if (continuation.status === "error") return err({ type: "agent_issue_refresh_failed", reason: continuation.error });
    issue = continuation.issue;
  }

  return ok(undefined);
}

function sendWorkerRuntimeInfo(
  sink: ((event: AgentRunnerEvent) => void) | undefined,
  issue: Issue,
  workerHost: string | null,
  workspacePath: string,
): void {
  if (typeof issue.id !== "string") return;
  sink?.({ type: "worker_runtime_info", issueId: issue.id, workerHost, workspacePath });
}

function sendCodexUpdate(
  sink: ((event: AgentRunnerEvent) => void) | undefined,
  issue: Issue,
  message: Record<string, unknown>,
): void {
  if (typeof issue.id !== "string") return;
  sink?.({ type: "codex_worker_update", issueId: issue.id, message });
}

function selectedWorkerHost(preferredHost: string | null | undefined, configuredHosts: string[]): string | null {
  const normalizedPreferred = normalizeHost(preferredHost);
  if (normalizedPreferred !== null) return normalizedPreferred;
  return configuredHosts.map(normalizeHost).find((host): host is string => host !== null) ?? null;
}

async function defaultFetchIssueStatesByIds(ids: string[]): Promise<Result<Issue[], unknown>> {
  const fetched = await fetchIssueStatesByIds(ids);
  if (!fetched.ok) return fetched;
  return ok(fetched.value.filter(isIssue));
}

function isIssue(value: unknown): value is Issue {
  return typeof value === "object" && value !== null;
}

function normalizeHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
