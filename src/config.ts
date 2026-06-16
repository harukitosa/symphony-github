import { isAbsolute, join, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";
import { err, ok, type Result } from "./result";
import { loadWorkflow } from "./workflow";

const DEFAULT_PROMPT_TEMPLATE = `You are working on a Linear issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}`;

const GITHUB_DEFAULT_PROMPT_TEMPLATE = `You are working on a GitHub issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}`;

export type Settings = {
  tracker: {
    kind: string | null;
    endpoint: string;
    api_key: string | null;
    project_slug: string | null;
    assignee: string | null;
    required_labels: string[];
    active_states: string[];
    terminal_states: string[];
  };
  polling: { interval_ms: number };
  workspace: { root: string };
  worker: { ssh_hosts: string[]; max_concurrent_agents_per_host: number | null };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  codex: {
    command: string;
    approval_policy: string | Record<string, unknown>;
    thread_sandbox: string;
    turn_sandbox_policy: Record<string, unknown> | null;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  observability: { dashboard_enabled: boolean; refresh_ms: number; render_interval_ms: number };
  server: { port: number | null; host: string };
};

export async function settings(): Promise<Settings> {
  const loaded = await loadWorkflow();
  if (!loaded.ok) throw new Error(formatConfigError(loaded.error));

  const parsed = parseSettings(loaded.value.config);
  if (!parsed.ok) throw new Error(formatConfigError(parsed.error));
  return parsed.value;
}

export async function validateConfig(): Promise<Result<void, unknown>> {
  const parsed = await settingsResult();
  if (!parsed.ok) return parsed;

  const config = parsed.value;
  if (config.tracker.kind === null) return err("missing_tracker_kind");
  if (!["linear", "memory", "github"].includes(config.tracker.kind)) {
    return err({ type: "unsupported_tracker_kind", kind: config.tracker.kind });
  }
  if (config.tracker.kind === "linear" && config.tracker.api_key === null) {
    return err("missing_linear_api_token");
  }
  if (config.tracker.kind === "linear" && config.tracker.project_slug === null) {
    return err("missing_linear_project_slug");
  }
  if (config.tracker.kind === "github" && config.tracker.api_key === null) {
    return err("missing_github_token");
  }
  if (config.tracker.kind === "github" && config.tracker.project_slug === null) {
    return err("missing_github_repository");
  }
  if (config.tracker.kind === "github" && !validGitHubRepositorySlug(config.tracker.project_slug)) {
    return err("missing_github_repository");
  }

  return ok(undefined);
}

export async function workflowPrompt(): Promise<string> {
  const loaded = await loadWorkflow();
  if (!loaded.ok) return DEFAULT_PROMPT_TEMPLATE;
  return loaded.value.promptTemplate.trim() === ""
    ? defaultPromptTemplateForConfig(loaded.value.config)
    : loaded.value.promptTemplate;
}

export async function codexTurnSandboxPolicy(workspace?: string | null): Promise<Record<string, unknown>> {
  const config = await settings();
  return resolveRuntimeTurnSandboxPolicy(config, workspace);
}

export async function codexRuntimeSettings(
  workspace?: string | null,
  opts: { remote?: boolean } = {},
): Promise<{
  approval_policy: string | Record<string, unknown>;
  thread_sandbox: string;
  turn_sandbox_policy: Record<string, unknown>;
}> {
  const config = await settings();
  return {
    approval_policy: config.codex.approval_policy,
    thread_sandbox: config.codex.thread_sandbox,
    turn_sandbox_policy: resolveRuntimeTurnSandboxPolicy(config, workspace, opts),
  };
}

export async function maxConcurrentAgentsForState(stateName: unknown): Promise<number> {
  const config = await settings();
  if (typeof stateName !== "string") return config.agent.max_concurrent_agents;
  return config.agent.max_concurrent_agents_by_state[normalizeIssueState(stateName)] ?? config.agent.max_concurrent_agents;
}

function resolveRuntimeTurnSandboxPolicy(
  config: Settings,
  workspace?: string | null,
  opts: { remote?: boolean } = {},
): Record<string, unknown> {
  if (config.codex.turn_sandbox_policy !== null) return config.codex.turn_sandbox_policy;
  const root = workspace === undefined || workspace === null || workspace === "" ? config.workspace.root : workspace;
  const writableRoot = opts.remote === true ? root : expandLocalPath(root);
  return {
    type: "workspaceWrite",
    writableRoots: [writableRoot],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

async function settingsResult(): Promise<Result<Settings, unknown>> {
  const loaded = await loadWorkflow();
  if (!loaded.ok) return err(loaded.error);
  return parseSettings(loaded.value.config);
}

function parseSettings(config: Record<string, unknown>): Result<Settings, unknown> {
  const tracker = section(config, "tracker");
  const polling = section(config, "polling");
  const workspace = section(config, "workspace");
  const worker = section(config, "worker");
  const agent = section(config, "agent");
  const codex = section(config, "codex");
  const hooks = section(config, "hooks");
  const observability = section(config, "observability");
  const server = section(config, "server");

  const errors: string[] = [];
  const requirePositive = (path: string, value: unknown, fallback: number): number => {
    if (value === null || value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) <= 0) {
      errors.push(`${path} must be a positive integer`);
      return fallback;
    }
    return value as number;
  };
  const requireNonNegative = (path: string, value: unknown, fallback: number): number => {
    if (value === null || value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 0) {
      errors.push(`${path} must be a non-negative integer`);
      return fallback;
    }
    return value as number;
  };
  const stringOrNull = (path: string, value: unknown, fallback: string | null): string | null => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== "string") {
      errors.push(`${path} must be a string`);
      return fallback;
    }
    return value;
  };
  const stringArray = (path: string, value: unknown, fallback: string[]): string[] => {
    if (value === null || value === undefined) return fallback;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push(`${path} must be an array of strings`);
      return fallback;
    }
    return value;
  };
  const optionalMap = (path: string, value: unknown): Record<string, unknown> | null => {
    if (value === null || value === undefined) return null;
    if (!isRecord(value)) {
      errors.push(`${path} must be a map`);
      return null;
    }
    return normalizeKeys(value);
  };

  const approvalPolicy = codex.approval_policy;
  if (
    approvalPolicy !== null &&
    approvalPolicy !== undefined &&
    typeof approvalPolicy !== "string" &&
    !isRecord(approvalPolicy)
  ) {
    errors.push("codex.approval_policy must be a string or map");
  }

  const threadSandbox = codex.thread_sandbox;
  if (threadSandbox !== null && threadSandbox !== undefined && typeof threadSandbox !== "string") {
    errors.push("codex.thread_sandbox must be a string");
  }

  const command = stringOrNull("codex.command", codex.command, "codex app-server");
  if (command === "") errors.push("codex.command can't be blank");

  const stateLimits = normalizeStateLimits(agent.max_concurrent_agents_by_state, errors);
  const resolvedWorkspaceRoot = resolvePathValue(
    stringOrNull("workspace.root", workspace.root, join(tmpdir(), "symphony_workspaces")),
    join(tmpdir(), "symphony_workspaces"),
  );

  const trackerKind = stringOrNull("tracker.kind", tracker.kind, null);
  const trackerEndpointDefault = trackerKind === "github" ? "https://api.github.com" : "https://api.linear.app/graphql";
  const trackerTokenFallback = trackerKind === "github" ? process.env.GITHUB_TOKEN : process.env.LINEAR_API_KEY;
  const trackerAssigneeFallback = trackerKind === "github" ? process.env.GITHUB_ASSIGNEE : process.env.LINEAR_ASSIGNEE;
  const trackerActiveStatesDefault = trackerKind === "github" ? ["open"] : ["Todo", "In Progress"];
  const trackerTerminalStatesDefault =
    trackerKind === "github" ? ["closed"] : ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

  const parsedSettings: Settings = {
    tracker: {
      kind: trackerKind,
      endpoint: stringOrNull("tracker.endpoint", tracker.endpoint, trackerEndpointDefault) ?? trackerEndpointDefault,
      api_key: resolveSecret(stringOrNull("tracker.api_key", tracker.api_key, null), trackerTokenFallback),
      project_slug: stringOrNull("tracker.project_slug", tracker.project_slug, null),
      assignee: resolveSecret(stringOrNull("tracker.assignee", tracker.assignee, null), trackerAssigneeFallback),
      required_labels: normalizeRequiredLabels(stringArray("tracker.required_labels", tracker.required_labels, [])),
      active_states: stringArray("tracker.active_states", tracker.active_states, trackerActiveStatesDefault),
      terminal_states: stringArray("tracker.terminal_states", tracker.terminal_states, trackerTerminalStatesDefault),
    },
    polling: { interval_ms: requirePositive("polling.interval_ms", polling.interval_ms, 30_000) },
    workspace: { root: resolvedWorkspaceRoot },
    worker: {
      ssh_hosts: stringArray("worker.ssh_hosts", worker.ssh_hosts, []),
      max_concurrent_agents_per_host:
        worker.max_concurrent_agents_per_host === null || worker.max_concurrent_agents_per_host === undefined
          ? null
          : requirePositive(
              "worker.max_concurrent_agents_per_host",
              worker.max_concurrent_agents_per_host,
              1,
            ),
    },
    agent: {
      max_concurrent_agents: requirePositive("agent.max_concurrent_agents", agent.max_concurrent_agents, 10),
      max_turns: requirePositive("agent.max_turns", agent.max_turns, 20),
      max_retry_backoff_ms: requirePositive("agent.max_retry_backoff_ms", agent.max_retry_backoff_ms, 300_000),
      max_concurrent_agents_by_state: stateLimits,
    },
    codex: {
      command: command ?? "codex app-server",
      approval_policy:
        typeof approvalPolicy === "string"
          ? approvalPolicy
          : normalizeKeys(
              isRecord(approvalPolicy)
                ? approvalPolicy
                : { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } },
            ),
      thread_sandbox: typeof threadSandbox === "string" ? threadSandbox : "workspace-write",
      turn_sandbox_policy: optionalMap("codex.turn_sandbox_policy", codex.turn_sandbox_policy),
      turn_timeout_ms: requirePositive("codex.turn_timeout_ms", codex.turn_timeout_ms, 3_600_000),
      read_timeout_ms: requirePositive("codex.read_timeout_ms", codex.read_timeout_ms, 5_000),
      stall_timeout_ms: requireNonNegative("codex.stall_timeout_ms", codex.stall_timeout_ms, 300_000),
    },
    hooks: {
      after_create: stringOrNull("hooks.after_create", hooks.after_create, null),
      before_run: stringOrNull("hooks.before_run", hooks.before_run, null),
      after_run: stringOrNull("hooks.after_run", hooks.after_run, null),
      before_remove: stringOrNull("hooks.before_remove", hooks.before_remove, null),
      timeout_ms: requirePositive("hooks.timeout_ms", hooks.timeout_ms, 60_000),
    },
    observability: {
      dashboard_enabled:
        typeof observability.dashboard_enabled === "boolean" ? observability.dashboard_enabled : true,
      refresh_ms: requirePositive("observability.refresh_ms", observability.refresh_ms, 1_000),
      render_interval_ms: requirePositive("observability.render_interval_ms", observability.render_interval_ms, 16),
    },
    server: {
      port:
        server.port === null || server.port === undefined
          ? null
          : requireNonNegative("server.port", server.port, 0),
      host: stringOrNull("server.host", server.host, "127.0.0.1") ?? "127.0.0.1",
    },
  };

  if (errors.length > 0) {
    return err({ type: "invalid_workflow_config", message: errors.join(", ") });
  }

  return ok(parsedSettings);
}

function defaultPromptTemplateForConfig(config: Record<string, unknown>): string {
  const tracker = section(config, "tracker");
  return tracker.kind === "github" ? GITHUB_DEFAULT_PROMPT_TEMPLATE : DEFAULT_PROMPT_TEMPLATE;
}

function validGitHubRepositorySlug(slug: string | null): boolean {
  if (slug === null) return false;
  const [owner, repo, ...rest] = slug.split("/");
  return Boolean(owner && repo && rest.length === 0);
}

function section(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return isRecord(value) ? value : {};
}

function normalizeRequiredLabels(labels: string[]): string[] {
  return Array.from(new Set(labels.map((label) => label.trim().toLowerCase())));
}

function normalizeStateLimits(value: unknown, errors: string[]): Record<string, number> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    errors.push("agent.max_concurrent_agents_by_state must be a map");
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [state, limit] of Object.entries(value)) {
    if (state === "") errors.push("agent.max_concurrent_agents_by_state state names must not be blank");
    if (!Number.isInteger(limit) || (limit as number) <= 0) {
      errors.push("agent.max_concurrent_agents_by_state limits must be positive integers");
      continue;
    }
    normalized[normalizeIssueState(state)] = limit as number;
  }
  return normalized;
}

function normalizeIssueState(state: string): string {
  return state.trim().toLowerCase();
}

function resolveSecret(value: string | null, fallback: string | undefined): string | null {
  const resolved = value === null ? fallback : resolveEnvReference(value, fallback);
  return resolved === undefined || resolved === "" ? null : resolved;
}

function resolvePathValue(value: string | null, fallback: string): string {
  if (value === null || value === "") return fallback;
  const resolved = resolveEnvReference(value, undefined);
  return resolved === undefined || resolved === "" ? fallback : resolved;
}

function expandLocalPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? normalize(path) : normalize(path);
}

function resolveEnvReference(value: string, fallback: string | undefined): string | undefined {
  if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  const envValue = process.env[value.slice(1)];
  return envValue === undefined ? fallback : envValue;
}

function normalizeKeys(value: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    normalized[key] = isRecord(rawValue) ? normalizeKeys(rawValue) : rawValue;
  }
  return normalized;
}

function formatConfigError(reason: unknown): string {
  if (isRecord(reason) && reason.type === "invalid_workflow_config" && typeof reason.message === "string") {
    return `Invalid WORKFLOW.md config: ${reason.message}`;
  }
  return `Invalid WORKFLOW.md config: ${JSON.stringify(reason)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
