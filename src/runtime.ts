import { settings, validateConfig } from "./config";
import type { Issue } from "./linear";
import {
  createOrchestratorSnapshot,
  shouldDispatchIssue,
  sortIssuesForDispatch,
  type OrchestratorSnapshot,
  type OrchestratorState,
} from "./orchestrator";
import { ok, err, type Result } from "./result";
import { runAgentIssue, type AgentRunnerError } from "./agent-runner";
import { fetchCandidateIssues } from "./tracker";
import { startObservabilityServer } from "./observability-api";
import { broadcastObservabilityUpdate } from "./observability-pubsub";

export type RuntimeDeps = {
  fetchCandidateIssues?: () => Promise<Result<unknown[], unknown>>;
  runAgentIssue?: (issue: Issue) => Promise<Result<void, AgentRunnerError>>;
  onEvent?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  nowMs?: () => number;
};

export type SymphonyRuntime = {
  pollOnce: () => Promise<Result<string[], unknown>>;
  snapshot: () => OrchestratorSnapshot;
  stop: () => void;
};

export function createRuntimeState(options: { maxConcurrentAgents: number; pollIntervalMs: number }): OrchestratorState {
  return {
    maxConcurrentAgents: options.maxConcurrentAgents,
    running: {},
    claimed: new Set(),
    completed: new Set(),
    blocked: {},
    retryAttempts: {},
    pollIntervalMs: options.pollIntervalMs,
    nextPollDueAtMs: null,
    pollCheckInProgress: false,
  };
}

export async function startSymphonyRuntime(deps: RuntimeDeps = {}): Promise<Result<SymphonyRuntime, unknown>> {
  const validation = await validateConfig();
  if (!validation.ok) return validation;

  const config = await settings();
  const state = createRuntimeState({
    maxConcurrentAgents: config.agent.max_concurrent_agents,
    pollIntervalMs: config.polling.interval_ms,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pollOnce = async (): Promise<Result<string[], unknown>> => {
    const result = await runPollOnce(state, deps);
    broadcastObservabilityUpdate();
    return result;
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    state.nextPollDueAtMs = (deps.nowMs ?? Date.now)() + config.polling.interval_ms;
    timer = setTimeout(async () => {
      await pollOnce();
      scheduleNext();
    }, config.polling.interval_ms);
    timer.unref?.();
  };

  const observability = await startObservabilityServer({
    host: config.server.host,
    port: config.server.port,
    snapshot: async () => createOrchestratorSnapshot(state),
    refresh: async () => {
      const result = await pollOnce();
      return { queued: result.ok, coalesced: false, operations: ["poll"] };
    },
  });
  if (!observability.ok) return observability;

  await pollOnce();
  scheduleNext();

  return ok({
    pollOnce,
    snapshot: () => createOrchestratorSnapshot(state),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      observability.value?.stop(true);
    },
  });
}

export async function runPollOnce(
  state: OrchestratorState,
  deps: RuntimeDeps = {},
): Promise<Result<string[], unknown>> {
  if (state.pollCheckInProgress === true) return ok([]);
  state.pollCheckInProgress = true;

  try {
    const fetcher = deps.fetchCandidateIssues ?? fetchCandidateIssues;
    const fetched = await fetcher();
    if (!fetched.ok) return err(fetched.error);

    const started: string[] = [];
    for (const issue of sortIssuesForDispatch(fetched.value.filter(isIssue))) {
      const issueId = issue.id;
      if (typeof issueId !== "string") continue;
      if (!(await shouldDispatchIssue(issue, state))) continue;

      started.push(issueId);
      state.claimed.add(issueId);
      state.running[issueId] = {
        identifier: issue.identifier ?? null,
        issue,
        startedAt: deps.now?.() ?? new Date(),
      };
      broadcastObservabilityUpdate();

      const runner = deps.runAgentIssue ?? runAgentIssue;
      const result = await runner(issue);
      delete state.running[issueId];
      if (result.ok) {
        state.claimed.delete(issueId);
        state.completed.add(issueId);
      } else {
        state.blocked[issueId] = {
          issue,
          error: result.error,
          blockedAt: deps.now?.() ?? new Date(),
        };
      }
      deps.onEvent?.({ type: "issue_run_finished", issueId, ok: result.ok });
      broadcastObservabilityUpdate();
    }

    return ok(started);
  } finally {
    state.pollCheckInProgress = false;
    state.nextPollDueAtMs = null;
  }
}

function isIssue(value: unknown): value is Issue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Issue).id === "string" &&
    typeof (value as Issue).identifier === "string" &&
    typeof (value as Issue).title === "string" &&
    typeof (value as Issue).state === "string"
  );
}
