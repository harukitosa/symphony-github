import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import {
  fetchIssueStatesByIdsForTest,
  fetchIssueStatesByIds as fetchLinearIssueStatesByIds,
  fetchIssuesByStates as fetchLinearIssuesByStates,
  fetchIssuesByStatesForTest,
  fetchCandidateIssues as fetchLinearCandidateIssues,
  labelNames,
  linearGraphql,
  mergeIssuePagesForTest,
  nextPageCursor,
  normalizeIssue,
  routable,
  type Issue,
} from "../src/linear";
import {
  applyCodexUpdateToState,
  createOrchestratorSnapshot,
  completeRunningIssue,
  continueWithIssue,
  handleWorkerExit,
  handleRetryIssueLookup,
  revalidateIssueForDispatch,
  reconcileBlockedIssueStates,
  reconcileRunningIssueStates,
  selectWorkerHostForTest,
  shouldDispatchIssue,
  sortIssuesForDispatch,
  type OrchestratorState,
} from "../src/orchestrator";
import { err, ok } from "../src/result";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-linear");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("linear issue helpers", () => {
  test("label names and routing require every configured label", () => {
    const issue: Issue = { id: "abc", labels: ["frontend", "infra"], assignedToWorker: false };
    expect(labelNames(issue)).toEqual(["frontend", "infra"]);
    expect(issue.assignedToWorker).toBe(false);

    const routableIssue: Issue = { labels: [" Symphony ", "JavaScript"], assignedToWorker: true };
    expect(routable(routableIssue, [])).toBe(true);
    expect(routable(routableIssue, ["symphony"])).toBe(true);
    expect(routable(routableIssue, ["SYMPHONY", "javascript"])).toBe(true);
    expect(routable(routableIssue, ["symph"])).toBe(false);
    expect(routable(routableIssue, [" "])).toBe(false);
    expect(routable(routableIssue, ["symphony", "security"])).toBe(false);
    expect(routable({ ...routableIssue, assignedToWorker: false }, ["symphony"])).toBe(false);
  });

  test("normalizes blockers from inverse relations", () => {
    const rawIssue = {
      id: "issue-1",
      identifier: "MT-1",
      title: "Blocked todo",
      description: "Needs dependency",
      priority: 2,
      state: { name: "Todo" },
      branchName: "mt-1",
      url: "https://example.org/issues/MT-1",
      assignee: { id: "user-1" },
      labels: { nodes: [{ name: "Backend" }] },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "issue-2", identifier: "MT-2", state: { name: "In Progress" } } },
          { type: "relatesTo", issue: { id: "issue-3", identifier: "MT-3", state: { name: "Done" } } },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    const issue = normalizeIssue(rawIssue, "user-1");
    expect(issue?.blockedBy).toEqual([{ id: "issue-2", identifier: "MT-2", state: "In Progress" }]);
    expect(issue?.labels).toEqual(["backend"]);
    expect(issue?.priority).toBe(2);
    expect(issue?.state).toBe("Todo");
    expect(issue?.assigneeId).toBe("user-1");
    expect(issue?.assignedToWorker).toBe(true);
  });

  test("marks explicitly unassigned issues as not routed to worker", () => {
    const issue = normalizeIssue(
      { id: "issue-99", identifier: "MT-99", title: "Someone else's task", state: { name: "Todo" }, assignee: { id: "user-2" } },
      "user-1",
    );
    expect(issue?.assignedToWorker).toBe(false);
  });

  test("pagination merge helper preserves issue ordering", () => {
    const merged = mergeIssuePagesForTest([
      [{ id: "issue-1", identifier: "MT-1" }, { id: "issue-2", identifier: "MT-2" }],
      [{ id: "issue-3", identifier: "MT-3" }],
    ]);

    expect(merged.map((issue) => issue.identifier)).toEqual(["MT-1", "MT-2", "MT-3"]);
  });

  test("paginates issue state fetches by id beyond one page", async () => {
    const issueIds = Array.from({ length: 55 }, (_, index) => `issue-${index + 1}`);
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];

    const result = await fetchIssueStatesByIdsForTest(issueIds, async (query, variables) => {
      calls.push({ query, variables });
      return ok({
        data: {
          issues: {
            nodes: (variables.ids as string[]).map((issueId) => {
              const suffix = issueId.replace("issue-", "");
              return {
                id: issueId,
                identifier: `MT-${suffix}`,
                title: `Issue ${suffix}`,
                description: `Description ${suffix}`,
                state: { name: "In Progress" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              };
            }),
          },
        },
      });
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((issue) => issue.id)).toEqual(issueIds);
    expect(calls[0]?.query).toContain("SymphonyLinearIssuesById");
    expect(calls[0]?.variables).toEqual({ ids: issueIds.slice(0, 50), first: 50, relationFirst: 50 });
    expect(calls[1]?.variables).toEqual({ ids: issueIds.slice(50), first: 5, relationFirst: 50 });
  });

  test("fetchIssuesByStatesForTest short-circuits empty state lists", async () => {
    const result = await fetchIssuesByStatesForTest("project", [], async () => {
      throw new Error("graphql should not be called for empty state lists");
    });

    expect(result).toEqual(ok([]));
  });

  test("fetchIssuesByStatesForTest paginates Linear issue polling responses", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const result = await fetchIssuesByStatesForTest("project", ["Todo", "In Progress"], async (query, variables) => {
      calls.push({ query, variables });
      const after = variables.after;
      return ok({
        data: {
          issues: {
            nodes: [
              {
                id: after === null ? "issue-1" : "issue-2",
                identifier: after === null ? "MT-1" : "MT-2",
                title: after === null ? "First" : "Second",
                state: { name: after === null ? "Todo" : "In Progress" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
            pageInfo: after === null
              ? { hasNextPage: true, endCursor: "cursor-1" }
              : { hasNextPage: false, endCursor: null },
          },
        },
      });
    });

    expect(result).toEqual(ok([
      { id: "issue-1", identifier: "MT-1", title: "First", description: null, priority: null, state: "Todo", branchName: null, url: null, assigneeId: null, blockedBy: [], labels: [], assignedToWorker: true, createdAt: null, updatedAt: null },
      { id: "issue-2", identifier: "MT-2", title: "Second", description: null, priority: null, state: "In Progress", branchName: null, url: null, assigneeId: null, blockedBy: [], labels: [], assignedToWorker: true, createdAt: null, updatedAt: null },
    ]));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("SymphonyLinearPoll");
    expect(calls[0]?.variables).toEqual({
      projectSlug: "project",
      stateNames: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });
    expect(calls[1]?.variables).toMatchObject({ after: "cursor-1" });
  });

  test("nextPageCursor validates missing cursors on paginated responses", () => {
    expect(nextPageCursor({ hasNextPage: true, endCursor: "cursor-1" })).toEqual(ok("cursor-1"));
    expect(nextPageCursor({ hasNextPage: true, endCursor: "" })).toEqual({ ok: false, error: "linear_missing_end_cursor" });
    expect(nextPageCursor({ hasNextPage: false, endCursor: "ignored" })).toEqual(ok(null));
  });

  test("linearGraphql builds payloads, headers, and operationName", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: "linear-token", endpoint: "https://linear.example/graphql" },
    });
    const requests: unknown[] = [];

    const result = await linearGraphql(
      "query Viewer { viewer { id } }",
      { includeTeams: false },
      {
        operationName: " Viewer ",
        request: async (url, init) => {
          requests.push({ url, init });
          return { status: 200, body: { data: { viewer: { id: "usr_123" } } } };
        },
      },
    );

    expect(result).toEqual(ok({ data: { viewer: { id: "usr_123" } } }));
    expect(requests).toEqual([
      {
        url: "https://linear.example/graphql",
        init: {
          method: "POST",
          headers: { Authorization: "linear-token", "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query Viewer { viewer { id } }",
            variables: { includeTeams: false },
            operationName: "Viewer",
          }),
        },
      },
    ]);
  });

  test("linearGraphql reports auth, status, and request failures", async () => {
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    await writeWorkflowFile(workflowPath, { tracker: { api_key: null } });
    expect(await linearGraphql("query Viewer { viewer { id } }", {})).toEqual(err("missing_linear_api_token"));
    if (previousLinearApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = previousLinearApiKey;
    }

    await writeWorkflowFile(workflowPath, { tracker: { api_key: "linear-token" } });
    expect(
      await linearGraphql("query Viewer { viewer { id } }", {}, {
        request: async () => ({ status: 503, body: { errors: [{ message: "unavailable" }] } }),
      }),
    ).toEqual(err({ type: "linear_api_status", status: 503, body: { errors: [{ message: "unavailable" }] } }));

    expect(
      await linearGraphql("query Viewer { viewer { id } }", {}, {
        request: async () => {
          throw new Error("timeout");
        },
      }),
    ).toEqual(err({ type: "linear_api_request", reason: "timeout" }));
  });

  test("public Linear fetch helpers validate config and use workflow routing", async () => {
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    await writeWorkflowFile(workflowPath, { tracker: { api_key: null, project_slug: "project" } });
    expect(await fetchLinearCandidateIssues()).toEqual(err("missing_linear_api_token"));

    await writeWorkflowFile(workflowPath, { tracker: { api_key: "linear-token", project_slug: null } });
    expect(await fetchLinearCandidateIssues()).toEqual(err("missing_linear_project_slug"));
    expect(await fetchLinearIssuesByStates(["Todo"])).toEqual(err("missing_linear_project_slug"));

    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: "linear-token", project_slug: "project", active_states: ["Todo"], assignee: "user-1" },
    });
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const graphql = async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return ok({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "MT-1",
                title: "Assigned issue",
                state: { name: "Todo" },
                assignee: { id: "user-1" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
              {
                id: "issue-2",
                identifier: "MT-2",
                title: "Other issue",
                state: { name: "Todo" },
                assignee: { id: "user-2" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    };

    const result = await fetchLinearCandidateIssues(graphql);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((issue) => [issue.id, issue.assignedToWorker])).toEqual([
        ["issue-1", true],
        ["issue-2", false],
      ]);
    }
    expect(calls[0]?.variables).toMatchObject({ projectSlug: "project", stateNames: ["Todo"] });

    expect(await fetchLinearIssuesByStates([], graphql)).toEqual(ok([]));
    expect(await fetchLinearIssueStatesByIds([], graphql)).toEqual(ok([]));

    if (previousLinearApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = previousLinearApiKey;
    }
  });
});

describe("orchestrator dispatch helpers", () => {
  const state = (): OrchestratorState => ({
    maxConcurrentAgents: 3,
    running: {},
    claimed: new Set(),
    completed: new Set(),
    blocked: {},
    retryAttempts: {},
    codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  });

  test("sorts dispatch by priority then oldest createdAt", () => {
    const sorted = sortIssuesForDispatch([
      { id: "issue-old-low", identifier: "MT-199", title: "Old lower priority", state: "Todo", priority: 2, createdAt: new Date("2025-12-01T00:00:00Z") },
      { id: "issue-new-high", identifier: "MT-201", title: "New high priority", state: "Todo", priority: 1, createdAt: new Date("2026-01-02T00:00:00Z") },
      { id: "issue-old-high", identifier: "MT-200", title: "Old high priority", state: "Todo", priority: 1, createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    expect(sorted.map((issue) => issue.identifier)).toEqual(["MT-200", "MT-201", "MT-199"]);
  });

  test("todo issue with non-terminal blocker is not dispatch-eligible", async () => {
    expect(
      await shouldDispatchIssue(
        { id: "blocked-1", identifier: "MT-1001", title: "Blocked work", state: "Todo", blockedBy: [{ id: "blocker-1", identifier: "MT-1002", state: "In Progress" }] },
        state(),
      ),
    ).toBe(false);
  });

  test("issue assigned to another worker is not dispatch-eligible", async () => {
    await writeWorkflowFile(workflowPath, { tracker: { assignee: "dev@example.com" } });
    expect(
      await shouldDispatchIssue(
        { id: "assigned-away-1", identifier: "MT-1007", title: "Owned elsewhere", state: "Todo", assignedToWorker: false },
        state(),
      ),
    ).toBe(false);
  });

  test("issue without every required label is not dispatch-eligible", async () => {
    await writeWorkflowFile(workflowPath, { tracker: { required_labels: ["symphony", "javascript"] } });
    const issue: Issue = { id: "unlabeled-1", identifier: "MT-1008", title: "Not opted in", state: "Todo", labels: ["symphony"] };

    expect(await shouldDispatchIssue(issue, state())).toBe(false);
    expect(await shouldDispatchIssue({ ...issue, labels: ["Symphony", "JavaScript"] }, state())).toBe(true);
  });

  test("GitHub open issues are dispatch-eligible with GitHub state defaults", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        project_slug: "openai/symphony-ts",
        active_states: null,
        terminal_states: null,
      },
    });
    const issue: Issue = {
      id: "github-open",
      identifier: "#42",
      title: "GitHub issue",
      state: "open",
      labels: [],
      assignedToWorker: true,
    };

    expect(await shouldDispatchIssue(issue, state())).toBe(true);
  });

  test("todo issue with terminal blockers remains dispatch-eligible", async () => {
    expect(
      await shouldDispatchIssue(
        { id: "ready-1", identifier: "MT-1003", title: "Ready work", state: "Todo", blockedBy: [{ id: "blocker-2", identifier: "MT-1004", state: "Closed" }] },
        state(),
      ),
    ).toBe(true);
  });

  test("dispatch revalidation skips stale todo issue once a non-terminal blocker appears", async () => {
    const refreshedIssue: Issue = {
      id: "blocked-2",
      identifier: "MT-1005",
      title: "Stale blocked work",
      state: "Todo",
      blockedBy: [{ id: "blocker-3", identifier: "MT-1006", state: "In Progress" }],
    };

    const result = await revalidateIssueForDispatch(
      { id: "blocked-2", identifier: "MT-1005", title: "Stale blocked work", state: "Todo", blockedBy: [] },
      async (ids) => {
        expect(ids).toEqual(["blocked-2"]);
        return ok([refreshedIssue]);
      },
    );

    expect(result).toEqual({ status: "skip", issue: refreshedIssue });
  });

  test("dispatch revalidation skips an issue after a required label is removed", async () => {
    await writeWorkflowFile(workflowPath, { tracker: { required_labels: ["symphony"] } });
    const staleIssue: Issue = { id: "unlabeled-2", identifier: "MT-1009", title: "Initially opted in", state: "Todo", labels: ["symphony"] };
    const refreshedIssue: Issue = { ...staleIssue, labels: [] };

    expect(await revalidateIssueForDispatch(staleIssue, async () => ok([refreshedIssue]))).toEqual({
      status: "skip",
      issue: refreshedIssue,
    });
  });

  test("snapshot reflects last codex update and session id", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    let nextState = state();
    nextState.running["issue-snapshot"] = {
      identifier: "MT-188",
      issue: {
        id: "issue-snapshot",
        identifier: "MT-188",
        title: "Snapshot test",
        state: "In Progress",
        url: "https://example.org/issues/MT-188",
      },
      sessionId: null,
      turnCount: 0,
      startedAt: new Date("2026-06-14T23:59:00Z"),
    };

    nextState = applyCodexUpdateToState(nextState, "issue-snapshot", {
      event: "session_started",
      sessionId: "thread-live-turn-live",
      timestamp: now,
    });
    nextState = applyCodexUpdateToState(nextState, "issue-snapshot", {
      event: "notification",
      payload: { method: "some-event" },
      timestamp: now,
    });

    const snapshot = createOrchestratorSnapshot(nextState, { now, nowMs: 10_000 });
    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]).toMatchObject({
      issueId: "issue-snapshot",
      issueUrl: "https://example.org/issues/MT-188",
      sessionId: "thread-live-turn-live",
      turnCount: 1,
      lastCodexTimestamp: now,
      lastCodexMessage: { event: "notification", message: { method: "some-event" }, timestamp: now },
    });
  });

  test("tracks codex thread totals, app-server pid, and completion totals", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    let nextState = state();
    nextState.running["issue-usage"] = {
      identifier: "MT-201",
      issue: { id: "issue-usage", identifier: "MT-201", title: "Usage", state: "In Progress", url: "https://example.org/issues/MT-201" },
      sessionId: null,
      turnCount: 0,
      startedAt: new Date("2026-06-14T23:59:30Z"),
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      codexLastReportedInputTokens: 0,
      codexLastReportedOutputTokens: 0,
      codexLastReportedTotalTokens: 0,
    };

    nextState = applyCodexUpdateToState(nextState, "issue-usage", {
      event: "session_started",
      sessionId: "thread-usage-turn-usage",
      timestamp: now,
    });
    nextState = applyCodexUpdateToState(nextState, "issue-usage", {
      event: "notification",
      payload: {
        method: "thread/tokenUsage/updated",
        params: { tokenUsage: { total: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } },
      },
      timestamp: now,
      codexAppServerPid: 4242,
    });

    let snapshot = createOrchestratorSnapshot(nextState, { now, nowMs: 10_000 });
    expect(snapshot.running[0]).toMatchObject({
      codexAppServerPid: "4242",
      codexInputTokens: 12,
      codexOutputTokens: 4,
      codexTotalTokens: 16,
      turnCount: 1,
      runtimeSeconds: 30,
    });

    nextState = completeRunningIssue(nextState, "issue-usage", now);
    expect(nextState.codexTotals).toEqual({ inputTokens: 12, outputTokens: 4, totalTokens: 16, secondsRunning: 30 });
    snapshot = createOrchestratorSnapshot(nextState, { now, nowMs: 10_000 });
    expect(snapshot.running).toEqual([]);
  });

  test("tracks token-count cumulative usage payloads and ignores delta-only last usage", () => {
    let nextState = state();
    nextState.running["issue-token"] = {
      identifier: "MT-220",
      issue: { id: "issue-token", identifier: "MT-220", title: "Token", state: "In Progress" },
      startedAt: new Date("2026-06-15T00:00:00Z"),
    };

    nextState = applyCodexUpdateToState(nextState, "issue-token", {
      event: "notification",
      payload: {
        method: "codex/event/token_count",
        params: {
          msg: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: "2", output_tokens: 2, total_tokens: 4 } },
          },
        },
      },
      timestamp: new Date("2026-06-15T00:00:01Z"),
    });
    nextState = applyCodexUpdateToState(nextState, "issue-token", {
      event: "notification",
      payload: {
        method: "codex/event/token_count",
        params: {
          msg: {
            type: "token_count",
            info: { total_token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          },
        },
      },
      timestamp: new Date("2026-06-15T00:00:02Z"),
    });

    expect(createOrchestratorSnapshot(nextState).running[0]).toMatchObject({
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    nextState.running["issue-last-only"] = {
      identifier: "MT-224",
      issue: { id: "issue-last-only", identifier: "MT-224", title: "Last", state: "In Progress" },
      startedAt: new Date("2026-06-15T00:00:00Z"),
    };
    nextState = applyCodexUpdateToState(nextState, "issue-last-only", {
      event: "notification",
      payload: {
        method: "codex/event/token_count",
        params: {
          msg: {
            type: "event_msg",
            payload: { type: "token_count", info: { last_token_usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } },
          },
        },
      },
      timestamp: new Date("2026-06-15T00:00:03Z"),
    });
    const lastOnly = createOrchestratorSnapshot(nextState).running.find((entry) => entry.issueId === "issue-last-only");
    expect(lastOnly).toMatchObject({ codexInputTokens: 0, codexOutputTokens: 0, codexTotalTokens: 0 });
  });

  test("snapshot tracks rate limits, retry backoff entries, and polling countdown", () => {
    let nextState = state();
    const rateLimits = {
      limit_id: "codex",
      primary: { remaining: 90, limit: 100 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: null },
    };
    nextState.running["issue-rate"] = {
      identifier: "MT-221",
      issue: { id: "issue-rate", identifier: "MT-221", title: "Rate", state: "In Progress" },
      startedAt: new Date("2026-06-15T00:00:00Z"),
    };
    nextState = applyCodexUpdateToState(nextState, "issue-rate", {
      event: "notification",
      payload: { params: { msg: { payload: { rate_limits: rateLimits } } } },
      timestamp: new Date("2026-06-15T00:00:01Z"),
    });
    nextState.retryAttempts["mt-500"] = {
      attempt: 2,
      dueAtMs: 15_000,
      identifier: "MT-500",
      issueUrl: "https://example.org/issues/MT-500",
      error: "agent exited: :boom",
    };
    nextState.pollIntervalMs = 30_000;
    nextState.nextPollDueAtMs = 14_000;
    nextState.pollCheckInProgress = false;

    let snapshot = createOrchestratorSnapshot(nextState, { nowMs: 10_000 });
    expect(snapshot.rateLimits).toEqual(rateLimits);
    expect(snapshot.retrying).toEqual([
      {
        issueId: "mt-500",
        attempt: 2,
        dueInMs: 5_000,
        identifier: "MT-500",
        issueUrl: "https://example.org/issues/MT-500",
        error: "agent exited: :boom",
        workerHost: undefined,
        workspacePath: undefined,
      },
    ]);
    expect(snapshot.polling).toEqual({ checking: false, nextPollInMs: 4_000, pollIntervalMs: 30_000 });

    nextState.pollCheckInProgress = true;
    nextState.nextPollDueAtMs = null;
    snapshot = createOrchestratorSnapshot(nextState, { nowMs: 10_000 });
    expect(snapshot.polling).toEqual({ checking: true, nextPollInMs: null, pollIntervalMs: 30_000 });
  });

  test("reconciles active running issue state without stopping the worker", async () => {
    const nextState = state();
    const stopped: string[] = [];
    nextState.running["issue-active"] = {
      identifier: "MT-557",
      issue: { id: "issue-active", identifier: "MT-557", title: "Active", state: "Todo" },
      stop: () => stopped.push("issue-active"),
    };
    nextState.claimed.add("issue-active");

    const refreshedIssue: Issue = {
      id: "issue-active",
      identifier: "MT-557",
      title: "Active state refresh",
      state: "In Progress",
      labels: [],
    };

    const reconciled = await reconcileRunningIssueStates([refreshedIssue], nextState);

    expect(reconciled.running["issue-active"]?.issue).toEqual(refreshedIssue);
    expect(reconciled.claimed.has("issue-active")).toBe(true);
    expect(stopped).toEqual([]);
  });

  test("reconciles non-active running issues without cleaning the workspace", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root },
      tracker: { active_states: ["Todo", "In Progress", "In Review"], terminal_states: ["Closed", "Cancelled"] },
    });
    const workspace = join(root, "MT-555");
    await mkdir(workspace, { recursive: true });
    const nextState = state();
    const stopped: string[] = [];
    nextState.running["issue-non-active"] = {
      identifier: "MT-555",
      issue: { id: "issue-non-active", identifier: "MT-555", title: "Queued", state: "Todo" },
      stop: () => stopped.push("issue-non-active"),
    };
    nextState.claimed.add("issue-non-active");

    const reconciled = await reconcileRunningIssueStates(
      [{ id: "issue-non-active", identifier: "MT-555", title: "Queued", state: "Backlog", labels: [] }],
      nextState,
    );

    expect(reconciled.running["issue-non-active"]).toBeUndefined();
    expect(reconciled.claimed.has("issue-non-active")).toBe(false);
    expect(stopped).toEqual(["issue-non-active"]);
    await expect(lstat(workspace)).resolves.toBeTruthy();
  });

  test("reconciles terminal running issues and removes the workspace", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root },
      tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Closed", "Cancelled"] },
    });
    const workspace = join(root, "MT-556");
    await mkdir(workspace, { recursive: true });
    const nextState = state();
    const stopped: string[] = [];
    nextState.running["issue-terminal"] = {
      identifier: "MT-556",
      issue: { id: "issue-terminal", identifier: "MT-556", title: "Done", state: "In Progress" },
      stop: () => stopped.push("issue-terminal"),
    };
    nextState.claimed.add("issue-terminal");
    nextState.retryAttempts["issue-terminal"] = { attempt: 2, identifier: "MT-556" };

    const reconciled = await reconcileRunningIssueStates(
      [{ id: "issue-terminal", identifier: "MT-556", title: "Done", state: "Closed", labels: [] }],
      nextState,
    );

    expect(reconciled.running["issue-terminal"]).toBeUndefined();
    expect(reconciled.claimed.has("issue-terminal")).toBe(false);
    expect(reconciled.retryAttempts["issue-terminal"]).toBeUndefined();
    expect(stopped).toEqual(["issue-terminal"]);
    await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reconciles reassigned or unlabeled running issues by stopping without cleanup", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root },
      tracker: { required_labels: ["symphony"], active_states: ["Todo", "In Progress"] },
    });
    const workspace = join(root, "MT-562");
    await mkdir(workspace, { recursive: true });
    const nextState = state();
    const stopped: string[] = [];
    nextState.running["issue-unlabeled"] = {
      identifier: "MT-562",
      issue: {
        id: "issue-unlabeled",
        identifier: "MT-562",
        title: "Opted in",
        state: "In Progress",
        labels: ["symphony"],
        assignedToWorker: true,
      },
      stop: () => stopped.push("issue-unlabeled"),
    };
    nextState.claimed.add("issue-unlabeled");

    const reconciled = await reconcileRunningIssueStates(
      [{
        id: "issue-unlabeled",
        identifier: "MT-562",
        title: "Opted out",
        state: "In Progress",
        labels: [],
        assignedToWorker: true,
      }],
      nextState,
    );

    expect(reconciled.running["issue-unlabeled"]).toBeUndefined();
    expect(reconciled.claimed.has("issue-unlabeled")).toBe(false);
    expect(stopped).toEqual(["issue-unlabeled"]);
    await expect(lstat(workspace)).resolves.toBeTruthy();
  });

  test("reconciles blocked issues by refreshing active issues and releasing opted-out issues", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: { required_labels: ["symphony"], active_states: ["Todo", "In Progress"] },
    });
    const nextState = state();
    nextState.blocked["blocked-active"] = {
      identifier: "MT-564",
      issue: { id: "blocked-active", identifier: "MT-564", title: "Blocked", state: "Todo", labels: ["symphony"] },
    };
    nextState.blocked["blocked-unlabeled"] = {
      identifier: "MT-565",
      issue: { id: "blocked-unlabeled", identifier: "MT-565", title: "Blocked", state: "In Progress", labels: ["symphony"] },
    };
    nextState.claimed.add("blocked-active");
    nextState.claimed.add("blocked-unlabeled");
    const refreshedActive: Issue = {
      id: "blocked-active",
      identifier: "MT-564",
      title: "Blocked but active",
      state: "In Progress",
      labels: ["symphony"],
    };

    const reconciled = await reconcileBlockedIssueStates(
      [
        refreshedActive,
        { id: "blocked-unlabeled", identifier: "MT-565", title: "Opted out", state: "In Progress", labels: [] },
      ],
      nextState,
    );

    expect(reconciled.blocked["blocked-active"]).toMatchObject({ issue: refreshedActive });
    expect(reconciled.claimed.has("blocked-active")).toBe(true);
    expect(reconciled.blocked["blocked-unlabeled"]).toBeUndefined();
    expect(reconciled.claimed.has("blocked-unlabeled")).toBe(false);
  });

  test("reconciles terminal blocked issues by cleaning the workspace and releasing the claim", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root },
      tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Closed", "Cancelled"] },
    });
    const workspace = join(root, "MT-566");
    await mkdir(workspace, { recursive: true });
    const nextState = state();
    nextState.blocked["blocked-terminal"] = {
      identifier: "MT-566",
      issue: { id: "blocked-terminal", identifier: "MT-566", title: "Blocked", state: "In Progress" },
    };
    nextState.claimed.add("blocked-terminal");

    const reconciled = await reconcileBlockedIssueStates(
      [{ id: "blocked-terminal", identifier: "MT-566", title: "Done", state: "Closed", labels: [] }],
      nextState,
    );

    expect(reconciled.blocked["blocked-terminal"]).toBeUndefined();
    expect(reconciled.claimed.has("blocked-terminal")).toBe(false);
    await expect(lstat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retry lookup releases claims when refreshed issue is no longer a retry candidate", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: { required_labels: ["symphony"], active_states: ["Todo", "In Progress"] },
    });
    const nextState = state();
    nextState.claimed.add("retry-unlabeled");
    nextState.retryAttempts["retry-unlabeled"] = { attempt: 1, identifier: "MT-567", error: "agent exited" };

    const reconciled = await handleRetryIssueLookup(
      { id: "retry-unlabeled", identifier: "MT-567", title: "Retry opted out", state: "In Progress", labels: [] },
      nextState,
      "retry-unlabeled",
      2,
      { identifier: "MT-567", error: "agent exited" },
    );

    expect(reconciled.claimed.has("retry-unlabeled")).toBe(false);
    expect(reconciled.retryAttempts["retry-unlabeled"]).toBeUndefined();
  });

  test("continueWithIssue stops when revalidation removes required labels", async () => {
    await writeWorkflowFile(workflowPath, { tracker: { required_labels: ["symphony"] } });
    const issue: Issue = {
      id: "issue-label-continuation",
      identifier: "MT-568",
      title: "Stop after opt-out",
      state: "In Progress",
      labels: ["symphony"],
    };
    const refreshedIssue: Issue = { ...issue, labels: [] };

    expect(await continueWithIssue(issue, async () => ok([refreshedIssue]))).toEqual({
      status: "done",
      issue: refreshedIssue,
    });
  });

  test("normal worker exit schedules an active-state continuation retry", () => {
    const nextState = state();
    nextState.running["issue-resume"] = {
      identifier: "MT-569",
      issue: {
        id: "issue-resume",
        identifier: "MT-569",
        title: "Resume",
        state: "In Progress",
        url: "https://example.org/issues/MT-569",
      },
      workerHost: "host-a",
      workspacePath: "/tmp/MT-569",
    };
    nextState.claimed.add("issue-resume");

    const updated = handleWorkerExit(nextState, "issue-resume", "normal", 10_000);

    expect(updated.running["issue-resume"]).toBeUndefined();
    expect(updated.claimed.has("issue-resume")).toBe(true);
    expect(updated.completed.has("issue-resume")).toBe(true);
    expect(updated.retryAttempts["issue-resume"]).toMatchObject({
      attempt: 1,
      dueAtMs: 10_750,
      identifier: "MT-569",
      issueUrl: "https://example.org/issues/MT-569",
      workerHost: "host-a",
      workspacePath: "/tmp/MT-569",
    });
  });

  test("abnormal worker exit increments retry attempt progressively", () => {
    const nextState = state();
    nextState.running["issue-crash"] = {
      identifier: "MT-570",
      retryAttempt: 2,
      issue: {
        id: "issue-crash",
        identifier: "MT-570",
        title: "Crash",
        state: "In Progress",
        url: "https://example.org/issues/MT-570",
      },
    };
    nextState.claimed.add("issue-crash");

    const updated = handleWorkerExit(nextState, "issue-crash", "boom", 20_000);

    expect(updated.running["issue-crash"]).toBeUndefined();
    expect(updated.claimed.has("issue-crash")).toBe(true);
    expect(updated.completed.has("issue-crash")).toBe(false);
    expect(updated.retryAttempts["issue-crash"]).toMatchObject({
      attempt: 3,
      dueAtMs: 60_000,
      identifier: "MT-570",
      error: "agent exited: boom",
    });
  });

  test("first abnormal worker exit waits before retrying", () => {
    const nextState = state();
    nextState.running["issue-crash-initial"] = {
      identifier: "MT-571",
      issue: {
        id: "issue-crash-initial",
        identifier: "MT-571",
        title: "Initial crash",
        state: "In Progress",
      },
    };
    nextState.claimed.add("issue-crash-initial");

    const updated = handleWorkerExit(nextState, "issue-crash-initial", "boom", 30_000);

    expect(updated.running["issue-crash-initial"]).toBeUndefined();
    expect(updated.claimed.has("issue-crash-initial")).toBe(true);
    expect(updated.completed.has("issue-crash-initial")).toBe(false);
    expect(updated.retryAttempts["issue-crash-initial"]).toMatchObject({
      attempt: 1,
      dueAtMs: 40_000,
      identifier: "MT-571",
      error: "agent exited: boom",
    });
  });

  test("selectWorkerHostForTest skips full ssh hosts under the shared per-host cap", async () => {
    await writeWorkflowFile(workflowPath, {
      worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 1 },
    });

    const nextState = state();
    nextState.running["issue-1"] = { workerHost: "worker-a" };

    expect(await selectWorkerHostForTest(nextState, null)).toBe("worker-b");
  });

  test("selectWorkerHostForTest returns no_worker_capacity when every ssh host is full", async () => {
    await writeWorkflowFile(workflowPath, {
      worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 1 },
    });

    const nextState = state();
    nextState.running["issue-1"] = { workerHost: "worker-a" };
    nextState.running["issue-2"] = { workerHost: "worker-b" };

    expect(await selectWorkerHostForTest(nextState, null)).toBe("no_worker_capacity");
  });

  test("selectWorkerHostForTest keeps the preferred ssh host when it still has capacity", async () => {
    await writeWorkflowFile(workflowPath, {
      worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 2 },
    });

    const nextState = state();
    nextState.running["issue-1"] = { workerHost: "worker-a" };
    nextState.running["issue-2"] = { workerHost: "worker-b" };

    expect(await selectWorkerHostForTest(nextState, "worker-a")).toBe("worker-a");
  });
});
