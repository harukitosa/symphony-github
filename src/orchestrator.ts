import { settings } from "./config";
import { routable, type Issue } from "./linear";
import { err, ok, type Result } from "./result";
import { removeIssueWorkspaces } from "./workspace";

export type OrchestratorState = {
  maxConcurrentAgents: number;
  running: Record<string, RunningEntry>;
  claimed: Set<string>;
  completed: Set<string>;
  blocked: Record<string, unknown>;
  retryAttempts: Record<string, RetryEntry>;
  codexTotals?: TokenTotals;
  codexRateLimits?: unknown;
  pollIntervalMs?: number;
  nextPollDueAtMs?: number | null;
  pollCheckInProgress?: boolean;
};

export type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
};

export type RunningEntry = {
  identifier?: string | null;
  issue?: Issue;
  workerHost?: string | null;
  workspacePath?: string | null;
  sessionId?: string | null;
  codexAppServerPid?: string | null;
  codexInputTokens?: number;
  codexOutputTokens?: number;
  codexTotalTokens?: number;
  codexLastReportedInputTokens?: number;
  codexLastReportedOutputTokens?: number;
  codexLastReportedTotalTokens?: number;
  turnCount?: number;
  retryAttempt?: number;
  startedAt?: Date | null;
  lastCodexTimestamp?: Date | null;
  lastCodexMessage?: unknown;
  lastCodexEvent?: string | null;
  stop?: () => void;
};

export type RetryEntry = {
  attempt?: number;
  dueAtMs?: number;
  identifier?: string | null;
  issueUrl?: string | null;
  error?: string | null;
  workerHost?: string | null;
  workspacePath?: string | null;
};

export type CodexUpdate = {
  event: string;
  timestamp: Date;
  payload?: unknown;
  raw?: unknown;
  usage?: unknown;
  sessionId?: string;
  codexAppServerPid?: string | number;
  rateLimits?: unknown;
};

export type OrchestratorSnapshot = {
  running: Array<Record<string, unknown>>;
  retrying: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  codexTotals: TokenTotals;
  rateLimits: unknown;
  polling: { checking: boolean; nextPollInMs: number | null; pollIntervalMs: number | undefined };
};

export type RevalidationResult =
  | { status: "ok"; issue: Issue }
  | { status: "skip"; issue: Issue | "missing" }
  | { status: "error"; error: unknown };

export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const leftKey = dispatchSortKey(left);
    const rightKey = dispatchSortKey(right);
    return (
      leftKey.priority - rightKey.priority ||
      leftKey.createdAt - rightKey.createdAt ||
      leftKey.identifier.localeCompare(rightKey.identifier)
    );
  });
}

export async function shouldDispatchIssue(issue: Issue, state: OrchestratorState): Promise<boolean> {
  const config = await settings();
  const activeStates = new Set(config.tracker.active_states.map(normalizeIssueState).filter(Boolean));
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeIssueState).filter(Boolean));

  return (
    candidateIssue(issue, activeStates, terminalStates, config.tracker.required_labels) &&
    !todoIssueBlockedByNonTerminal(issue, terminalStates) &&
    !state.claimed.has(issue.id ?? "") &&
    !Object.hasOwn(state.running, issue.id ?? "") &&
    !Object.hasOwn(state.blocked, issue.id ?? "") &&
    availableSlots(state) > 0 &&
    stateSlotsAvailable(issue, state.running, config.agent.max_concurrent_agents_by_state)
  );
}

export async function selectWorkerHostForTest(
  state: OrchestratorState,
  preferredWorkerHost?: string | null,
): Promise<string | null | "no_worker_capacity"> {
  const config = await settings();
  const hosts = config.worker.ssh_hosts;
  if (hosts.length === 0) return null;

  const availableHosts = hosts.filter((host) => workerHostSlotsAvailable(state, host, config.worker.max_concurrent_agents_per_host));
  if (availableHosts.length === 0) return "no_worker_capacity";
  if (typeof preferredWorkerHost === "string" && preferredWorkerHost !== "" && availableHosts.includes(preferredWorkerHost)) {
    return preferredWorkerHost;
  }
  return leastLoadedWorkerHost(state, availableHosts);
}

export async function revalidateIssueForDispatch(
  issue: Issue,
  fetcher: (ids: string[]) => Promise<Result<Issue[], unknown>>,
): Promise<RevalidationResult> {
  if (typeof issue.id !== "string") return { status: "ok", issue };

  const fetched = await fetcher([issue.id]);
  if (!fetched.ok) return { status: "error", error: fetched.error };
  const refreshed = fetched.value[0];
  if (refreshed === undefined) return { status: "skip", issue: "missing" };

  const config = await settings();
  const activeStates = new Set(config.tracker.active_states.map(normalizeIssueState).filter(Boolean));
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeIssueState).filter(Boolean));
  const candidate =
    candidateIssue(refreshed, activeStates, terminalStates, config.tracker.required_labels) &&
    !todoIssueBlockedByNonTerminal(refreshed, terminalStates);

  return candidate ? { status: "ok", issue: refreshed } : { status: "skip", issue: refreshed };
}

export function applyCodexUpdateToState(
  state: OrchestratorState,
  issueId: string,
  update: CodexUpdate,
): OrchestratorState {
  const runningEntry = state.running[issueId];
  if (runningEntry === undefined) return state;

  const { entry, tokenDelta } = integrateCodexUpdate(runningEntry, update);
  const nextState: OrchestratorState = {
    ...state,
    running: { ...state.running, [issueId]: entry },
    codexTotals: applyTokenDelta(state.codexTotals ?? emptyTokenTotals(), tokenDelta),
  };
  const rateLimits = extractRateLimits(update);
  if (rateLimits !== undefined) nextState.codexRateLimits = rateLimits;
  return nextState;
}

export function completeRunningIssue(
  state: OrchestratorState,
  issueId: string,
  now = new Date(),
): OrchestratorState {
  const runningEntry = state.running[issueId];
  if (runningEntry === undefined) return state;

  const running = { ...state.running };
  delete running[issueId];

  return {
    ...state,
    running,
    codexTotals: applyTokenDelta(state.codexTotals ?? emptyTokenTotals(), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: runningSeconds(runningEntry.startedAt, now),
      inputReported: 0,
      outputReported: 0,
      totalReported: 0,
    }),
  };
}

export async function reconcileRunningIssueStates(
  issues: Issue[],
  state: OrchestratorState,
  now = new Date(),
): Promise<OrchestratorState> {
  const config = await settings();
  const activeStates = new Set(config.tracker.active_states.map(normalizeIssueState).filter(Boolean));
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeIssueState).filter(Boolean));

  let nextState = state;
  for (const issue of issues) {
    if (typeof issue.id !== "string") continue;
    if (terminalStates.has(normalizeIssueState(issue.state))) {
      nextState = await stopRunningIssue(nextState, issue.id, { cleanupWorkspace: true, fallbackIssue: issue, now });
    } else if (!routable(issue, config.tracker.required_labels)) {
      nextState = await stopRunningIssue(nextState, issue.id, { cleanupWorkspace: false, fallbackIssue: issue, now });
    } else if (activeStates.has(normalizeIssueState(issue.state))) {
      nextState = refreshRunningIssue(nextState, issue);
    } else {
      nextState = await stopRunningIssue(nextState, issue.id, { cleanupWorkspace: false, fallbackIssue: issue, now });
    }
  }
  return nextState;
}

export async function reconcileBlockedIssueStates(
  issues: Issue[],
  state: OrchestratorState,
): Promise<OrchestratorState> {
  const config = await settings();
  const activeStates = new Set(config.tracker.active_states.map(normalizeIssueState).filter(Boolean));
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeIssueState).filter(Boolean));

  let nextState = state;
  for (const issue of issues) {
    if (typeof issue.id !== "string") continue;
    if (terminalStates.has(normalizeIssueState(issue.state))) {
      await removeIssueWorkspaces(issue.identifier);
      nextState = releaseIssueClaim(nextState, issue.id);
    } else if (!routable(issue, config.tracker.required_labels)) {
      nextState = releaseIssueClaim(nextState, issue.id);
    } else if (activeStates.has(normalizeIssueState(issue.state))) {
      nextState = refreshBlockedIssue(nextState, issue);
    } else {
      nextState = releaseIssueClaim(nextState, issue.id);
    }
  }
  return nextState;
}

export async function handleRetryIssueLookup(
  issue: Issue,
  state: OrchestratorState,
  issueId: string,
  attempt: number,
  metadata: RetryEntry = {},
  nowMs = Date.now(),
): Promise<OrchestratorState> {
  const config = await settings();
  const terminalStates = new Set(config.tracker.terminal_states.map(normalizeIssueState).filter(Boolean));

  if (terminalStates.has(normalizeIssueState(issue.state))) {
    await removeIssueWorkspaces(issue.identifier);
    return releaseIssueClaim(state, issueId);
  }

  if (
    candidateIssue(issue, new Set(config.tracker.active_states.map(normalizeIssueState).filter(Boolean)), terminalStates, config.tracker.required_labels) &&
    !todoIssueBlockedByNonTerminal(issue, terminalStates)
  ) {
    return {
      ...state,
      retryAttempts: {
        ...state.retryAttempts,
        [issueId]: { ...metadata, attempt, dueAtMs: nowMs },
      },
    };
  }

  return releaseIssueClaim(state, issueId);
}

export function handleWorkerExit(
  state: OrchestratorState,
  issueId: string,
  reason: "normal" | string,
  nowMs = Date.now(),
): OrchestratorState {
  const runningEntry = state.running[issueId];
  if (runningEntry === undefined) return state;

  const nextAttempt = reason === "normal" ? 1 : (runningEntry.retryAttempt ?? 0) + 1;
  const retry: RetryEntry = {
    attempt: nextAttempt,
    dueAtMs: nowMs + retryDelayMs(nextAttempt, reason),
  };
  putRetryValue(retry, "identifier", runningEntry.identifier ?? runningEntry.issue?.identifier);
  putRetryValue(retry, "issueUrl", runningEntry.issue?.url);
  putRetryValue(retry, "workerHost", runningEntry.workerHost);
  putRetryValue(retry, "workspacePath", runningEntry.workspacePath);
  if (reason !== "normal") retry.error = `agent exited: ${reason}`;

  const nextState = completeRunningIssue(state, issueId, new Date(nowMs));
  const completed = new Set(nextState.completed);
  if (reason === "normal") completed.add(issueId);

  return {
    ...nextState,
    completed,
    retryAttempts: { ...nextState.retryAttempts, [issueId]: retry },
  };
}

export async function continueWithIssue(
  issue: Issue,
  fetcher: (ids: string[]) => Promise<Result<Issue[], unknown>>,
): Promise<{ status: "continue"; issue: Issue } | { status: "done"; issue: Issue | "missing" } | { status: "error"; error: unknown }> {
  const revalidated = await revalidateIssueForDispatch(issue, fetcher);
  if (revalidated.status === "ok") return { status: "continue", issue: revalidated.issue };
  if (revalidated.status === "skip") return { status: "done", issue: revalidated.issue };
  return { status: "error", error: revalidated.error };
}

export function createOrchestratorSnapshot(
  state: OrchestratorState,
  opts: { now?: Date; nowMs?: number } = {},
): OrchestratorSnapshot {
  const now = opts.now ?? new Date();
  const nowMs = opts.nowMs ?? Date.now();
  return {
    running: Object.entries(state.running).map(([issueId, metadata]) => ({
      issueId,
      identifier: metadata.identifier ?? metadata.issue?.identifier,
      issueUrl: metadata.issue?.url,
      state: metadata.issue?.state,
      workerHost: metadata.workerHost ?? undefined,
      workspacePath: metadata.workspacePath ?? undefined,
      sessionId: metadata.sessionId ?? null,
      codexAppServerPid: metadata.codexAppServerPid ?? null,
      codexInputTokens: metadata.codexInputTokens ?? 0,
      codexOutputTokens: metadata.codexOutputTokens ?? 0,
      codexTotalTokens: metadata.codexTotalTokens ?? 0,
      turnCount: metadata.turnCount ?? 0,
      startedAt: metadata.startedAt,
      lastCodexTimestamp: metadata.lastCodexTimestamp,
      lastCodexMessage: metadata.lastCodexMessage,
      lastCodexEvent: metadata.lastCodexEvent,
      runtimeSeconds: runningSeconds(metadata.startedAt, now),
    })),
    retrying: Object.entries(state.retryAttempts).map(([issueId, retry]) => ({
      issueId,
      attempt: retry.attempt,
      dueInMs: Math.max(0, (retry.dueAtMs ?? nowMs) - nowMs),
      identifier: retry.identifier,
      issueUrl: retry.issueUrl,
      error: retry.error,
      workerHost: retry.workerHost ?? undefined,
      workspacePath: retry.workspacePath ?? undefined,
    })),
    blocked: Object.entries(state.blocked).map(([issueId, metadata]) => ({ issueId, metadata })),
    codexTotals: state.codexTotals ?? emptyTokenTotals(),
    rateLimits: state.codexRateLimits,
    polling: {
      checking: state.pollCheckInProgress === true,
      nextPollInMs: state.nextPollDueAtMs == null ? null : Math.max(0, state.nextPollDueAtMs - nowMs),
      pollIntervalMs: state.pollIntervalMs,
    },
  };
}

function integrateCodexUpdate(
  runningEntry: RunningEntry,
  update: CodexUpdate,
): { entry: RunningEntry; tokenDelta: TokenDelta } {
  const tokenDelta = extractTokenDelta(runningEntry, update);
  const existingSessionId = runningEntry.sessionId ?? null;
  const sessionId = typeof update.sessionId === "string" ? update.sessionId : existingSessionId;
  const codexAppServerPid =
    update.codexAppServerPid === undefined ? runningEntry.codexAppServerPid ?? null : String(update.codexAppServerPid);

  return {
    entry: {
      ...runningEntry,
      lastCodexTimestamp: update.timestamp,
      lastCodexMessage: summarizeCodexUpdate(update),
      sessionId,
      lastCodexEvent: update.event,
      codexAppServerPid,
      codexInputTokens: (runningEntry.codexInputTokens ?? 0) + tokenDelta.inputTokens,
      codexOutputTokens: (runningEntry.codexOutputTokens ?? 0) + tokenDelta.outputTokens,
      codexTotalTokens: (runningEntry.codexTotalTokens ?? 0) + tokenDelta.totalTokens,
      codexLastReportedInputTokens: Math.max(runningEntry.codexLastReportedInputTokens ?? 0, tokenDelta.inputReported),
      codexLastReportedOutputTokens: Math.max(runningEntry.codexLastReportedOutputTokens ?? 0, tokenDelta.outputReported),
      codexLastReportedTotalTokens: Math.max(runningEntry.codexLastReportedTotalTokens ?? 0, tokenDelta.totalReported),
      turnCount: turnCountForUpdate(runningEntry.turnCount ?? 0, existingSessionId, update),
    },
    tokenDelta,
  };
}

async function stopRunningIssue(
  state: OrchestratorState,
  issueId: string,
  opts: { cleanupWorkspace: boolean; fallbackIssue?: Issue; now: Date },
): Promise<OrchestratorState> {
  const runningEntry = state.running[issueId];
  const identifier = runningEntry?.identifier ?? runningEntry?.issue?.identifier ?? opts.fallbackIssue?.identifier;
  let nextState = runningEntry === undefined ? state : completeRunningIssue(state, issueId, opts.now);

  if (opts.cleanupWorkspace) await removeIssueWorkspaces(identifier);
  runningEntry?.stop?.();

  const running = { ...nextState.running };
  delete running[issueId];
  const claimed = new Set(nextState.claimed);
  claimed.delete(issueId);
  const blocked = { ...nextState.blocked };
  delete blocked[issueId];
  const retryAttempts = { ...nextState.retryAttempts };
  delete retryAttempts[issueId];

  return { ...nextState, running, claimed, blocked, retryAttempts };
}

function refreshRunningIssue(state: OrchestratorState, issue: Issue): OrchestratorState {
  if (typeof issue.id !== "string") return state;
  const runningEntry = state.running[issue.id];
  if (runningEntry === undefined) return state;
  return {
    ...state,
    running: {
      ...state.running,
      [issue.id]: { ...runningEntry, issue },
    },
  };
}

function refreshBlockedIssue(state: OrchestratorState, issue: Issue): OrchestratorState {
  if (typeof issue.id !== "string") return state;
  const existing = state.blocked[issue.id];
  if (existing === undefined) return state;
  return {
    ...state,
    blocked: {
      ...state.blocked,
      [issue.id]: { ...(isRecord(existing) ? existing : {}), issue },
    },
  };
}

function releaseIssueClaim(state: OrchestratorState, issueId: string): OrchestratorState {
  const claimed = new Set(state.claimed);
  claimed.delete(issueId);
  const blocked = { ...state.blocked };
  delete blocked[issueId];
  const retryAttempts = { ...state.retryAttempts };
  delete retryAttempts[issueId];
  return { ...state, claimed, blocked, retryAttempts };
}

function retryDelayMs(attempt: number, reason: string): number {
  if (reason === "normal") return 750;
  return Math.min(300_000, 5_000 * 2 ** attempt);
}

function putRetryValue<Key extends keyof RetryEntry>(retry: RetryEntry, key: Key, value: RetryEntry[Key] | undefined): void {
  if (value !== undefined) retry[key] = value;
}

type TokenDelta = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
  inputReported: number;
  outputReported: number;
  totalReported: number;
};

function extractTokenDelta(runningEntry: RunningEntry, update: CodexUpdate): TokenDelta {
  const usage = extractTokenUsage(update);
  const input = computeTokenDelta(runningEntry, usage, "input", "codexLastReportedInputTokens");
  const output = computeTokenDelta(runningEntry, usage, "output", "codexLastReportedOutputTokens");
  const total = computeTokenDelta(runningEntry, usage, "total", "codexLastReportedTotalTokens");
  return {
    inputTokens: input.delta,
    outputTokens: output.delta,
    totalTokens: total.delta,
    secondsRunning: 0,
    inputReported: input.reported,
    outputReported: output.reported,
    totalReported: total.reported,
  };
}

function computeTokenDelta(
  runningEntry: RunningEntry,
  usage: Record<string, unknown>,
  tokenKey: "input" | "output" | "total",
  reportedKey: keyof RunningEntry,
): { delta: number; reported: number } {
  const nextTotal = getTokenUsage(usage, tokenKey);
  const prevReported = typeof runningEntry[reportedKey] === "number" ? runningEntry[reportedKey] : 0;
  if (nextTotal !== undefined && nextTotal >= prevReported) {
    return { delta: nextTotal - prevReported, reported: nextTotal };
  }
  return { delta: 0, reported: nextTotal ?? prevReported };
}

function extractTokenUsage(update: CodexUpdate): Record<string, unknown> {
  const payloads = [update.usage, update.payload, update];
  for (const payload of payloads) {
    const usage = absoluteTokenUsageFromPayload(payload);
    if (usage !== undefined) return usage;
  }
  for (const payload of payloads) {
    const usage = turnCompletedUsageFromPayload(payload);
    if (usage !== undefined) return usage;
  }
  return {};
}

function absoluteTokenUsageFromPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const paths = [
    ["params", "msg", "payload", "info", "total_token_usage"],
    ["params", "msg", "info", "total_token_usage"],
    ["params", "tokenUsage", "total"],
    ["tokenUsage", "total"],
  ];
  for (const path of paths) {
    const value = mapAtPath(payload, path);
    if (isRecord(value) && integerTokenMap(value)) return value;
  }
  return undefined;
}

function turnCompletedUsageFromPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const method = payload.method;
  if (method !== "turn/completed" && method !== "turn_completed") return undefined;
  const direct = payload.usage ?? mapAtPath(payload, ["params", "usage"]);
  return isRecord(direct) && integerTokenMap(direct) ? direct : undefined;
}

function extractRateLimits(update: CodexUpdate): unknown {
  return rateLimitsFromPayload(update.rateLimits) ?? rateLimitsFromPayload(update.payload) ?? rateLimitsFromPayload(update);
}

function rateLimitsFromPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const result = rateLimitsFromPayload(value);
      if (result !== undefined) return result;
    }
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const direct = payload.rate_limits ?? payload.rateLimits;
  if (rateLimitsMap(direct)) return direct;
  if (rateLimitsMap(payload)) return payload;

  for (const value of Object.values(payload)) {
    const result = rateLimitsFromPayload(value);
    if (result !== undefined) return result;
  }
  return undefined;
}

function rateLimitsMap(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) return false;
  const limitId = payload.limit_id ?? payload.limit_name ?? payload.limitId ?? payload.limitName;
  return limitId !== undefined && ["primary", "secondary", "credits"].some((key) => Object.hasOwn(payload, key));
}

function getTokenUsage(usage: Record<string, unknown>, tokenKey: "input" | "output" | "total"): number | undefined {
  const fields =
    tokenKey === "input"
      ? ["input_tokens", "prompt_tokens", "input", "promptTokens", "inputTokens"]
      : tokenKey === "output"
        ? ["output_tokens", "completion_tokens", "output", "completion", "outputTokens", "completionTokens"]
        : ["total_tokens", "total", "totalTokens"];
  for (const field of fields) {
    const value = integerLike(usage[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function integerTokenMap(payload: Record<string, unknown>): boolean {
  return [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "promptTokens",
    "completionTokens",
  ].some((field) => integerLike(payload[field]) !== undefined);
}

function mapAtPath(payload: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = payload;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function applyTokenDelta(totals: TokenTotals, delta: TokenDelta): TokenTotals {
  return {
    inputTokens: Math.max(0, totals.inputTokens + delta.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens + delta.outputTokens),
    totalTokens: Math.max(0, totals.totalTokens + delta.totalTokens),
    secondsRunning: Math.max(0, totals.secondsRunning + delta.secondsRunning),
  };
}

function summarizeCodexUpdate(update: CodexUpdate): Record<string, unknown> {
  return {
    event: update.event,
    message: update.payload ?? update.raw,
    timestamp: update.timestamp,
  };
}

function turnCountForUpdate(existingCount: number, existingSessionId: string | null, update: CodexUpdate): number {
  if (update.event === "session_started" && typeof update.sessionId === "string") {
    return update.sessionId === existingSessionId ? existingCount : existingCount + 1;
  }
  return existingCount;
}

function emptyTokenTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 };
}

function runningSeconds(startedAt: unknown, now: Date): number {
  return startedAt instanceof Date ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)) : 0;
}

function integerLike(value: unknown): number | undefined {
  if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatchSortKey(issue: Issue): { priority: number; createdAt: number; identifier: string } {
  return {
    priority: typeof issue.priority === "number" && issue.priority >= 1 && issue.priority <= 4 ? issue.priority : 5,
    createdAt: issue.createdAt instanceof Date ? issue.createdAt.getTime() : Number.MAX_SAFE_INTEGER,
    identifier: issue.identifier ?? issue.id ?? "",
  };
}

function candidateIssue(
  issue: Issue,
  activeStates: Set<string>,
  terminalStates: Set<string>,
  requiredLabels: string[],
): boolean {
  if (
    typeof issue.id !== "string" ||
    typeof issue.identifier !== "string" ||
    typeof issue.title !== "string" ||
    typeof issue.state !== "string"
  ) {
    return false;
  }
  return (
    routable(issue, requiredLabels) &&
    activeStates.has(normalizeIssueState(issue.state)) &&
    !terminalStates.has(normalizeIssueState(issue.state))
  );
}

function todoIssueBlockedByNonTerminal(issue: Issue, terminalStates: Set<string>): boolean {
  if (normalizeIssueState(issue.state) !== "todo") return false;
  return (issue.blockedBy ?? []).some((blocker) => {
    if (typeof blocker.state !== "string") return true;
    return !terminalStates.has(normalizeIssueState(blocker.state));
  });
}

function stateSlotsAvailable(
  issue: Issue,
  running: Record<string, { issue?: Issue }>,
  maxByState: Record<string, number>,
): boolean {
  const normalized = normalizeIssueState(issue.state);
  const limit = maxByState[normalized] ?? Number.POSITIVE_INFINITY;
  const used = Object.values(running).filter((entry) => normalizeIssueState(entry.issue?.state) === normalized).length;
  return limit > used;
}

function availableSlots(state: OrchestratorState): number {
  return state.maxConcurrentAgents - Object.keys(state.running).length;
}

function workerHostSlotsAvailable(
  state: OrchestratorState,
  workerHost: string,
  limit: number | null,
): boolean {
  return !(Number.isInteger(limit) && (limit as number) > 0) || runningWorkerHostCount(state.running, workerHost) < (limit as number);
}

function leastLoadedWorkerHost(state: OrchestratorState, hosts: string[]): string {
  return hosts
    .map((host, index) => ({ host, index, running: runningWorkerHostCount(state.running, host) }))
    .sort((left, right) => left.running - right.running || left.index - right.index)[0]?.host ?? hosts[0] ?? "";
}

function runningWorkerHostCount(running: Record<string, RunningEntry>, workerHost: string): number {
  return Object.values(running).filter((entry) => entry.workerHost === workerHost).length;
}

function normalizeIssueState(state: unknown): string {
  return typeof state === "string" ? state.trim().toLowerCase() : "";
}
