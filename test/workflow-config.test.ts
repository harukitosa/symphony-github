import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import {
  clearWorkflowFilePath,
  loadWorkflow,
  setWorkflowFilePath,
  workflowFilePath,
} from "../src/workflow";
import { WorkflowStore } from "../src/workflow-store";
import {
  codexRuntimeSettings,
  codexTurnSandboxPolicy,
  maxConcurrentAgentsForState,
  settings,
  validateConfig,
  workflowPrompt,
} from "../src/config";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-workflow");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_ASSIGNEE;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_ASSIGNEE;
  await cleanup(root);
});

describe("workflow loading", () => {
  test("workflow file path defaults to WORKFLOW.md in cwd when unset", () => {
    clearWorkflowFilePath();
    expect(workflowFilePath()).toBe(join(process.cwd(), "WORKFLOW.md"));
  });

  test("workflow file path resolves from override when set", () => {
    setWorkflowFilePath("/tmp/app/WORKFLOW.md");
    expect(workflowFilePath()).toBe("/tmp/app/WORKFLOW.md");
  });

  test("accepts prompt-only files without front matter", async () => {
    const path = join(root, "PROMPT_ONLY_WORKFLOW.md");
    await writeFile(path, "Prompt only\n");

    const loaded = await loadWorkflow(path);
    expect(loaded).toEqual({
      ok: true,
      value: { config: {}, prompt: "Prompt only", promptTemplate: "Prompt only" },
    });
  });

  test("accepts unterminated front matter with an empty prompt", async () => {
    const path = join(root, "UNTERMINATED_WORKFLOW.md");
    await writeFile(path, "---\ntracker:\n  kind: linear\n");

    const loaded = await loadWorkflow(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.config).toEqual({ tracker: { kind: "linear" } });
      expect(loaded.value.prompt).toBe("");
    }
  });

  test("rejects non-map front matter", async () => {
    const path = join(root, "INVALID_FRONT_MATTER_WORKFLOW.md");
    await writeFile(path, "---\n- not-a-map\n---\nPrompt body\n");

    expect(await loadWorkflow(path)).toEqual({ ok: false, error: "workflow_front_matter_not_a_map" });
  });

  test("workflow store reloads changes and keeps the last good workflow on parse errors", async () => {
    const started = await WorkflowStore.start();
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("workflow store did not start");
    const store = started.value;
    expect(store.current()).toEqual({
      ok: true,
      value: expect.objectContaining({ prompt: "You are an agent for this repository." }),
    });

    await writeWorkflowFile(workflowPath, { prompt: "Second prompt" });
    expect(await store.poll()).toEqual({ ok: true, value: undefined });
    expect(store.current()).toEqual({
      ok: true,
      value: expect.objectContaining({ prompt: "Second prompt" }),
    });

    await writeFile(workflowPath, "---\ntracker: [\n---\nBroken prompt\n");
    const reloaded = await store.forceReload();
    expect(reloaded.ok).toBe(false);
    expect(store.current()).toEqual({
      ok: true,
      value: expect.objectContaining({ prompt: "Second prompt" }),
    });

    const thirdWorkflow = join(root, "THIRD_WORKFLOW.md");
    await writeWorkflowFile(thirdWorkflow, { prompt: "Third prompt" });
    setWorkflowFilePath(thirdWorkflow);
    expect(await store.forceReload()).toEqual({ ok: true, value: undefined });
    expect(store.current()).toEqual({
      ok: true,
      value: expect.objectContaining({ prompt: "Third prompt" }),
    });
  });

  test("workflow store start returns a missing workflow error", async () => {
    const missingPath = join(root, "MISSING_WORKFLOW.md");
    setWorkflowFilePath(missingPath);

    expect(await WorkflowStore.start()).toEqual({
      ok: false,
      error: { type: "missing_workflow_file", path: missingPath, reason: "ENOENT" },
    });
  });

  test("workflow store poll keeps last good workflow when the file disappears", async () => {
    const started = await WorkflowStore.start();
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("workflow store did not start");
    const store = started.value;
    expect(store.current().ok).toBe(true);

    await cleanup(workflowPath);
    const pollResult = await store.poll();
    expect(pollResult.ok).toBe(false);
    expect(store.current()).toEqual({
      ok: true,
      value: expect.objectContaining({ prompt: "You are an agent for this repository." }),
    });
  });
});

describe("config", () => {
  test("defaults and validation checks match the reference implementation", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: null, project_slug: null, active_states: null, terminal_states: null },
      polling: { interval_ms: null },
      codex: { command: null },
    });

    let config = await settings();
    expect(config.polling.interval_ms).toBe(30_000);
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminal_states).toEqual(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]);
    expect(config.tracker.assignee).toBeNull();
    expect(config.agent.max_turns).toBe(20);

    await writeWorkflowFile(workflowPath, { polling: { interval_ms: "invalid" } });
    await expect(settings()).rejects.toThrow(/polling\.interval_ms/);
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("polling.interval_ms") },
    });

    await writeWorkflowFile(workflowPath, { polling: { interval_ms: 45_000 } });
    config = await settings();
    expect(config.polling.interval_ms).toBe(45_000);

    await writeWorkflowFile(workflowPath, { agent: { max_turns: 0 } });
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("agent.max_turns") },
    });

    await writeWorkflowFile(workflowPath, { agent: { max_turns: 5 } });
    config = await settings();
    expect(config.agent.max_turns).toBe(5);

    await writeWorkflowFile(workflowPath, { tracker: { active_states: "Todo, Review," } });
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("tracker.active_states") },
    });

    await writeWorkflowFile(workflowPath, { tracker: { api_key: "token", project_slug: null } });
    expect(await validateConfig()).toEqual({ ok: false, error: "missing_linear_project_slug" });

    await writeWorkflowFile(workflowPath, { tracker: { project_slug: "project" }, codex: { command: "" } });
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("codex.command") },
    });

    await writeWorkflowFile(workflowPath, { codex: { command: "   " } });
    expect(await validateConfig()).toEqual({ ok: true, value: undefined });

    await writeWorkflowFile(workflowPath, { codex: { approval_policy: 123 } });
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("codex.approval_policy") },
    });

    await writeWorkflowFile(workflowPath, { codex: { thread_sandbox: 123 } });
    expect(await validateConfig()).toEqual({
      ok: false,
      error: { type: "invalid_workflow_config", message: expect.stringContaining("codex.thread_sandbox") },
    });

    await writeWorkflowFile(workflowPath, { tracker: { kind: "123" } });
    expect(await validateConfig()).toEqual({ ok: false, error: { type: "unsupported_tracker_kind", kind: "123" } });
  });

  test("linear api token and assignee resolve from env vars", async () => {
    process.env.LINEAR_API_KEY = "test-linear-api-key";
    process.env.LINEAR_ASSIGNEE = "dev@example.com";
    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: null, assignee: null, project_slug: "project" },
      codex: { command: "/bin/sh app-server" },
    });

    const config = await settings();
    expect(config.tracker.api_key).toBe("test-linear-api-key");
    expect(config.tracker.assignee).toBe("dev@example.com");
    expect(await validateConfig()).toEqual({ ok: true, value: undefined });
  });

  test("github tracker token resolves from env and validates repository slug", async () => {
    process.env.GITHUB_TOKEN = "test-github-token";
    process.env.GITHUB_ASSIGNEE = "octocat";
    process.env.LINEAR_ASSIGNEE = "linear-user";
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        endpoint: null,
        api_key: null,
        project_slug: "openai/symphony-ts",
        active_states: null,
        terminal_states: null,
      },
    });

    const config = await settings();
    expect(config.tracker.endpoint).toBe("https://api.github.com");
    expect(config.tracker.api_key).toBe("test-github-token");
    expect(config.tracker.assignee).toBe("octocat");
    expect(config.tracker.active_states).toEqual(["open"]);
    expect(config.tracker.terminal_states).toEqual(["closed"]);
    expect(await validateConfig()).toEqual({ ok: true, value: undefined });

    delete process.env.GITHUB_TOKEN;
    await writeWorkflowFile(workflowPath, {
      tracker: { kind: "github", endpoint: null, api_key: null, project_slug: "openai/symphony-ts" },
    });
    expect(await validateConfig()).toEqual({ ok: false, error: "missing_github_token" });

    await writeWorkflowFile(workflowPath, { tracker: { kind: "github", api_key: "token", project_slug: null } });
    expect(await validateConfig()).toEqual({ ok: false, error: "missing_github_repository" });

    await writeWorkflowFile(workflowPath, { tracker: { kind: "github", api_key: "token", project_slug: "openai" } });
    expect(await validateConfig()).toEqual({ ok: false, error: "missing_github_repository" });

    await writeWorkflowFile(workflowPath, { tracker: { kind: "github", api_key: "token", project_slug: "openai/symphony/extra" } });
    expect(await validateConfig()).toEqual({ ok: false, error: "missing_github_repository" });
  });

  test("resolves $VAR references for env-backed secret and path values", async () => {
    const workspaceEnvVar = `SYMP_WORKSPACE_ROOT_${Date.now()}`;
    const apiKeyEnvVar = `SYMP_LINEAR_API_KEY_${Date.now()}`;
    const workspaceRoot = join(root, "env-workspaces");
    process.env[workspaceEnvVar] = workspaceRoot;
    process.env[apiKeyEnvVar] = "resolved-secret";

    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: `$${apiKeyEnvVar}` },
      workspace: { root: `$${workspaceEnvVar}` },
      codex: { command: "~/bin/codex app-server" },
    });

    const config = await settings();
    expect(config.tracker.api_key).toBe("resolved-secret");
    expect(config.workspace.root).toBe(workspaceRoot);
    expect(config.codex.command).toBe("~/bin/codex app-server");

    delete process.env[workspaceEnvVar];
    delete process.env[apiKeyEnvVar];
  });

  test("does not resolve legacy env: references", async () => {
    const workspaceEnvVar = `SYMP_WORKSPACE_ROOT_${Date.now()}`;
    const apiKeyEnvVar = `SYMP_LINEAR_API_KEY_${Date.now()}`;
    process.env[workspaceEnvVar] = join(root, "legacy-env-workspaces");
    process.env[apiKeyEnvVar] = "resolved-secret";

    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: `env:${apiKeyEnvVar}` },
      workspace: { root: `env:${workspaceEnvVar}` },
    });

    const config = await settings();
    expect(config.tracker.api_key).toBe(`env:${apiKeyEnvVar}`);
    expect(config.workspace.root).toBe(`env:${workspaceEnvVar}`);

    delete process.env[workspaceEnvVar];
    delete process.env[apiKeyEnvVar];
  });

  test("workflow prompt returns file prompt or default template when blank", async () => {
    expect(await workflowPrompt()).toBe("You are an agent for this repository.");

    await mkdir(root, { recursive: true });
    await writeFile(workflowPath, "---\ntracker:\n  kind: memory\n---\n\n");
    expect(await workflowPrompt()).toContain("You are working on a Linear issue.");

    await writeFile(workflowPath, "---\ntracker:\n  kind: github\n---\n\n");
    expect(await workflowPrompt()).toContain("You are working on a GitHub issue.");
    expect(await workflowPrompt()).not.toContain("Linear issue");
  });

  test("reads defaults for optional settings and normalizes required labels", async () => {
    delete process.env.LINEAR_API_KEY;
    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: null, project_slug: null },
      workspace: { root: null },
      agent: { max_concurrent_agents: null },
      codex: {
        approval_policy: null,
        thread_sandbox: null,
        turn_sandbox_policy: null,
        turn_timeout_ms: null,
        read_timeout_ms: null,
        stall_timeout_ms: null,
      },
    });

    let config = await settings();
    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.api_key).toBeNull();
    expect(config.tracker.project_slug).toBeNull();
    expect(config.tracker.required_labels).toEqual([]);
    expect(config.workspace.root).toBe(join(tmpdir(), "symphony_workspaces"));
    expect(config.worker.max_concurrent_agents_per_host).toBeNull();
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.codex.command).toBe("codex app-server");
    expect(config.codex.approval_policy).toEqual({
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    });
    expect(config.codex.thread_sandbox).toBe("workspace-write");
    expect(config.codex.turn_timeout_ms).toBe(3_600_000);
    expect(config.codex.read_timeout_ms).toBe(5_000);
    expect(config.codex.stall_timeout_ms).toBe(300_000);

    const sandboxPolicy = await codexTurnSandboxPolicy();
    expect(sandboxPolicy.type).toBe("workspaceWrite");
    expect(sandboxPolicy.writableRoots).toEqual([config.workspace.root]);
    expect(sandboxPolicy.networkAccess).toBe(false);

    await writeWorkflowFile(workflowPath, {
      tracker: { required_labels: [" Symphony ", "SYMPHONY", "JavaScript"] },
    });
    config = await settings();
    expect(config.tracker.required_labels).toEqual(["symphony", "javascript"]);

    await writeWorkflowFile(workflowPath, { tracker: { required_labels: [" "] } });
    config = await settings();
    expect(config.tracker.required_labels).toEqual([""]);
  });

  test("supports per-state max concurrent agent overrides", async () => {
    await writeWorkflowFile(workflowPath, {
      agent: {
        max_concurrent_agents: 10,
        max_concurrent_agents_by_state: {
          todo: 1,
          "In Progress": 4,
          "In Review": 2,
        },
      },
    });

    expect((await settings()).agent.max_concurrent_agents).toBe(10);
    expect(await maxConcurrentAgentsForState("Todo")).toBe(1);
    expect(await maxConcurrentAgentsForState("In Progress")).toBe(4);
    expect(await maxConcurrentAgentsForState("In Review")).toBe(2);
    expect(await maxConcurrentAgentsForState("Closed")).toBe(10);
    expect(await maxConcurrentAgentsForState(Symbol("not-a-string"))).toBe(10);
  });

  test("resolves sandbox policies from explicit and default workspaces", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root: "" },
      codex: { turn_sandbox_policy: null },
    });

    expect(await codexTurnSandboxPolicy()).toEqual({
      type: "workspaceWrite",
      writableRoots: [join(tmpdir(), "symphony_workspaces")],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    expect(await codexTurnSandboxPolicy("/tmp/workspace")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/tmp/workspace"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    await writeWorkflowFile(workflowPath, {
      codex: {
        turn_sandbox_policy: {
          type: "workspaceWrite",
          writableRoots: ["relative/path"],
          networkAccess: true,
        },
      },
    });

    expect(await codexTurnSandboxPolicy("/tmp/ignored")).toEqual({
      type: "workspaceWrite",
      writableRoots: ["relative/path"],
      networkAccess: true,
    });
  });

  test("keeps workspace roots raw while sandbox helpers expand local use and preserve remote roots", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root: "~/.symphony-workspaces" },
      codex: { turn_sandbox_policy: null },
    });

    expect((await settings()).workspace.root).toBe("~/.symphony-workspaces");
    expect(await codexTurnSandboxPolicy()).toEqual({
      type: "workspaceWrite",
      writableRoots: [join(homedir(), ".symphony-workspaces")],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });

    const remoteSettings = await codexRuntimeSettings(null, { remote: true });
    expect(remoteSettings.turn_sandbox_policy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["~/.symphony-workspaces"],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });
});
