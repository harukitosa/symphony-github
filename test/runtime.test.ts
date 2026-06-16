import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import { createRuntimeState, runPollOnce } from "../src/runtime";
import type { Issue } from "../src/linear";
import { ok, err } from "../src/result";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-runtime");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath, {
    tracker: { kind: "github", api_key: "token", project_slug: "owner/repo", active_states: ["open"], terminal_states: ["closed"] },
    agent: { max_concurrent_agents: 1 },
  });
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("runtime polling", () => {
  test("dispatches a routable candidate issue", async () => {
    const issue: Issue = { id: "42", identifier: "#42", title: "Fix bug", state: "open", labels: [] };
    const state = createRuntimeState({ maxConcurrentAgents: 1, pollIntervalMs: 30_000 });
    const started: string[] = [];

    const result = await runPollOnce(state, {
      fetchCandidateIssues: async () => ok([issue]),
      runAgentIssue: async (candidate) => {
        started.push(candidate.id ?? "");
        return ok(undefined);
      },
    });

    expect(result).toEqual(ok(["42"]));
    expect(started).toEqual(["42"]);
    expect(state.completed.has("42")).toBe(true);
    expect(state.claimed.has("42")).toBe(false);
    expect(state.running["42"]).toBeUndefined();
  });

  test("keeps failed issue claimed and blocked", async () => {
    const issue: Issue = { id: "99", identifier: "#99", title: "Needs input", state: "open", labels: [] };
    const state = createRuntimeState({ maxConcurrentAgents: 1, pollIntervalMs: 30_000 });

    const result = await runPollOnce(state, {
      fetchCandidateIssues: async () => ok([issue]),
      runAgentIssue: async () => err({ type: "agent_run_failed", reason: { type: "input_required" } }),
    });

    expect(result).toEqual(ok(["99"]));
    expect(state.completed.has("99")).toBe(false);
    expect(state.claimed.has("99")).toBe(true);
    expect(state.blocked["99"]).toMatchObject({ issue, error: { type: "agent_run_failed" } });
  });

  test("surfaces tracker fetch failures", async () => {
    const state = createRuntimeState({ maxConcurrentAgents: 1, pollIntervalMs: 30_000 });

    expect(await runPollOnce(state, { fetchCandidateIssues: async () => err("boom") })).toEqual(err("boom"));
    expect(state.pollCheckInProgress).toBe(false);
  });
});
