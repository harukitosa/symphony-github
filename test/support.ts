import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { setWorkflowFilePath } from "../src/workflow";

export async function makeTempRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

export async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function writeWorkflowFile(
  path: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const prompt = typeof overrides.prompt === "string" ? overrides.prompt : "You are an agent for this repository.";
  const { prompt: _prompt, ...configOverrides } = overrides;
  const config = {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "token",
      project_slug: "project",
      assignee: null,
      required_labels: [],
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: join(tmpdir(), "symphony_workspaces") },
    worker: { ssh_hosts: [], max_concurrent_agents_per_host: null },
    agent: {
      max_concurrent_agents: 10,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: "codex app-server",
      approval_policy: { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } },
      thread_sandbox: "workspace-write",
      turn_sandbox_policy: null,
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60_000,
    },
    observability: { dashboard_enabled: true, refresh_ms: 1_000, render_interval_ms: 16 },
    server: { port: null, host: null },
  };

  const merged = deepMerge(config, configOverrides);
  await writeFile(path, `---\n${YAML.stringify(merged)}---\n${prompt}\n`);
  setWorkflowFilePath(path);
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
