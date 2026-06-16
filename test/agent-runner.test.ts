import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import { runAgentIssue, continuationPromptForTurn, type AgentRunnerEvent } from "../src/agent-runner";
import type { Issue } from "../src/linear";
import { err, ok } from "../src/result";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-agent-runner");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath, {
    prompt: "Handle {{ issue.identifier }}: {{ issue.title }} attempt={{ attempt }}",
    tracker: { active_states: ["Todo", "In Progress"], required_labels: ["symphony"] },
    agent: { max_turns: 3 },
  });
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("agent runner", () => {
  test("creates a workspace, runs hooks, and continues active issues across turns", async () => {
    const issue: Issue = {
      id: "issue-1",
      identifier: "GH-1",
      title: "Port Symphony",
      state: "In Progress",
      labels: ["symphony"],
    };
    const events: AgentRunnerEvent[] = [];
    const calls: Array<{ prompt: string; workerHost: string | null }> = [];
    const refreshedActive: Issue = { ...issue, title: "Port Symphony refreshed" };
    const refreshedDone: Issue = { ...issue, state: "Done" };

    const result = await runAgentIssue(issue, {
      workerHost: "worker-a",
      eventSink: (event) => events.push(event),
      createWorkspace: async (identifier, workerHost) => ok(`/work/${workerHost}/${identifier}`),
      runBeforeRunHook: async (workspace, identifier, workerHost) => {
        events.push({ type: "test_before_run", workspace, identifier, workerHost });
        return ok(undefined);
      },
      runAfterRunHook: async (workspace, identifier, workerHost) => {
        events.push({ type: "test_after_run", workspace, identifier, workerHost });
        return ok(undefined);
      },
      runAppServer: async (workspace, prompt, currentIssue, opts) => {
        calls.push({ prompt, workerHost: opts.workerHost ?? null });
        opts.onMessage?.({ event: "turn_started", issueId: currentIssue.id, workspace });
        return ok({
          result: "turn_completed",
          sessionId: `session-${calls.length}`,
          threadId: "thread",
          turnId: `turn-${calls.length}`,
        });
      },
      fetchIssueStatesByIds: async () => ok(calls.length === 1 ? [refreshedActive] : [refreshedDone]),
    });

    expect(result).toEqual(ok(undefined));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("Handle GH-1: Port Symphony attempt=");
    expect(calls[1]?.prompt).toContain("Continuation guidance:");
    expect(calls[1]?.prompt).toContain("turn #2 of 3");
    expect(calls.map((call) => call.workerHost)).toEqual(["worker-a", "worker-a"]);
    expect(events).toContainEqual({
      type: "worker_runtime_info",
      issueId: "issue-1",
      workerHost: "worker-a",
      workspacePath: "/work/worker-a/GH-1",
    });
    expect(events).toContainEqual({
      type: "codex_worker_update",
      issueId: "issue-1",
      message: { event: "turn_started", issueId: "issue-1", workspace: "/work/worker-a/GH-1" },
    });
    expect(events.at(-1)).toEqual({
      type: "test_after_run",
      workspace: "/work/worker-a/GH-1",
      identifier: "GH-1",
      workerHost: "worker-a",
    });
  });

  test("runs after_run when before_run or Codex fails", async () => {
    const issue: Issue = { id: "issue-2", identifier: "GH-2", title: "Hook failure", state: "Todo", labels: ["symphony"] };
    const events: string[] = [];

    const beforeFailure = await runAgentIssue(issue, {
      createWorkspace: async () => ok("/work/GH-2"),
      runBeforeRunHook: async () => {
        events.push("before");
        return err({ type: "workspace_hook_failed", hook: "before_run", status: 1, output: "nope" });
      },
      runAfterRunHook: async () => {
        events.push("after");
        return ok(undefined);
      },
      runAppServer: async () => ok({ result: "unused", sessionId: "s", threadId: "t", turnId: "r" }),
    });

    expect(beforeFailure).toEqual(err({ type: "agent_before_run_failed", reason: { type: "workspace_hook_failed", hook: "before_run", status: 1, output: "nope" } }));
    expect(events).toEqual(["before", "after"]);

    const codexFailure = await runAgentIssue(issue, {
      createWorkspace: async () => ok("/work/GH-2"),
      runBeforeRunHook: async () => ok(undefined),
      runAfterRunHook: async () => {
        events.push("after-codex");
        return ok(undefined);
      },
      runAppServer: async () => err({ type: "turn_failed", payload: { message: "boom" } }),
    });

    expect(codexFailure).toEqual(err({ type: "agent_run_failed", reason: { type: "turn_failed", payload: { message: "boom" } } }));
    expect(events.at(-1)).toBe("after-codex");
  });

  test("continuation prompt is tracker-neutral", () => {
    expect(continuationPromptForTurn(2, 4)).toContain("the issue is still in an active state");
    expect(continuationPromptForTurn(2, 4)).not.toContain("Linear");
  });
});
