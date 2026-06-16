import { settings } from "./config";
import type { BlockerRef, Issue } from "./linear";
import { err, ok, type Result } from "./result";

export type GitHubRequest = (
  url: string,
  init: { method: "GET" | "POST" | "PATCH"; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;

export async function fetchGitHubCandidateIssues(
  request: GitHubRequest = fetchGitHubJson,
): Promise<Result<Issue[], unknown>> {
  const config = await githubConfig();
  if (!config.ok) return config;
  return fetchGitHubIssuesByStates(config.value.activeStates, request);
}

export async function fetchGitHubIssuesByStates(
  states: string[],
  request: GitHubRequest = fetchGitHubJson,
): Promise<Result<Issue[], unknown>> {
  const config = await githubConfig();
  if (!config.ok) return config;
  const state = githubStateParam(states);
  let url: string | null = `${repoUrl(config.value)}/issues?state=${encodeURIComponent(state)}&per_page=100`;
  const issues: Issue[] = [];
  while (url !== null) {
    const response = await request(url, { method: "GET", headers: githubHeaders(config.value.token) });
    if (response.status !== 200 || !Array.isArray(response.body)) {
      return githubStatusError(response);
    }
    const pageIssues = response.body.flatMap((entry) => normalizeGitHubIssue(entry, config.value.assignee) ?? []);
    const issuesWithBlockers = await attachGitHubBlockers(pageIssues, config.value, request);
    if (!issuesWithBlockers.ok) return issuesWithBlockers;
    issues.push(...issuesWithBlockers.value);
    url = nextPageUrl(response.headers);
  }
  return ok(issues);
}

export async function fetchGitHubIssueStatesByIds(
  ids: string[],
  request: GitHubRequest = fetchGitHubJson,
): Promise<Result<Issue[], unknown>> {
  const config = await githubConfig();
  if (!config.ok) return config;
  const issues: Issue[] = [];
  for (const id of Array.from(new Set(ids))) {
    const response = await request(`${repoUrl(config.value)}/issues/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: githubHeaders(config.value.token),
    });
    if (response.status !== 200) return githubStatusError(response);
    const issue = normalizeGitHubIssue(response.body, config.value.assignee);
    if (issue !== null) issues.push(issue);
  }
  return attachGitHubBlockers(issues, config.value, request);
}

export async function createGitHubComment(
  issueId: string,
  body: string,
  request: GitHubRequest = fetchGitHubJson,
): Promise<Result<void, unknown>> {
  const config = await githubConfig();
  if (!config.ok) return config;
  const response = await request(`${repoUrl(config.value)}/issues/${encodeURIComponent(issueId)}/comments`, {
    method: "POST",
    headers: githubHeaders(config.value.token),
    body: JSON.stringify({ body }),
  });
  return response.status >= 200 && response.status < 300 ? ok(undefined) : err("github_comment_create_failed");
}

export async function updateGitHubIssueState(
  issueId: string,
  stateName: string,
  request: GitHubRequest = fetchGitHubJson,
): Promise<Result<void, unknown>> {
  const config = await githubConfig();
  if (!config.ok) return config;
  const response = await request(`${repoUrl(config.value)}/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: githubHeaders(config.value.token),
    body: JSON.stringify(githubMutationStatePayload(stateName)),
  });
  return response.status >= 200 && response.status < 300 ? ok(undefined) : err("github_issue_update_failed");
}

export function normalizeGitHubIssue(raw: unknown, assignee?: string | null): Issue | null {
  if (!isRecord(raw) || isRecord(raw.pull_request)) return null;
  const number = typeof raw.number === "number" ? raw.number : null;
  const assigneeId = githubAssigneeId(raw, assignee);
  return {
    id: number === null ? stringOrNull(raw.id) ?? stringOrNull(raw.node_id) : String(number),
    identifier: number === null ? null : `#${number}`,
    title: stringOrNull(raw.title),
    description: stringOrNull(raw.body),
    priority: null,
    state: stringOrNull(raw.state),
    branchName: null,
    url: stringOrNull(raw.html_url),
    assigneeId,
    blockedBy: [],
    labels: githubLabels(raw.labels),
    assignedToWorker: assignedToWorker(assigneeId, assignee),
    createdAt: parseDate(raw.created_at),
    updatedAt: parseDate(raw.updated_at),
  };
}

function githubAssigneeId(raw: Record<string, unknown>, assignee?: string | null): string | null {
  const configuredAssignee = normalizeAssignee(assignee);
  const assigneeLogins = githubAssigneeLogins(raw.assignees);
  if (configuredAssignee !== null) {
    const matched = assigneeLogins.find((login) => normalizeAssignee(login) === configuredAssignee);
    if (matched !== undefined) return matched;
  }
  const assigneeRecord = isRecord(raw.assignee) ? raw.assignee : null;
  return stringOrNull(assigneeRecord?.login) ?? assigneeLogins[0] ?? null;
}

function githubAssigneeLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((assignee) => {
    if (!isRecord(assignee)) return [];
    const login = stringOrNull(assignee.login);
    return login === null ? [] : [login];
  });
}

async function attachGitHubBlockers(
  issues: Issue[],
  config: { endpoint: string; owner: string; repo: string; token: string },
  request: GitHubRequest,
): Promise<Result<Issue[], unknown>> {
  const enriched: Issue[] = [];
  for (const issue of issues) {
    const issueId = typeof issue.id === "string" ? issue.id.trim() : "";
    if (issueId === "") {
      enriched.push(issue);
      continue;
    }
    const blockers = await fetchGitHubBlockedBy(issueId, config, request);
    if (!blockers.ok) return blockers;
    enriched.push({ ...issue, blockedBy: blockers.value });
  }
  return ok(enriched);
}

async function fetchGitHubBlockedBy(
  issueId: string,
  config: { endpoint: string; owner: string; repo: string; token: string },
  request: GitHubRequest,
): Promise<Result<BlockerRef[], unknown>> {
  let url: string | null = `${repoUrl(config)}/issues/${encodeURIComponent(issueId)}/dependencies/blocked_by?per_page=100`;
  const blockers: BlockerRef[] = [];
  while (url !== null) {
    const response = await request(url, { method: "GET", headers: githubHeaders(config.token) });
    if (response.status === 404 || response.status === 410) return ok([]);
    if (response.status !== 200 || !Array.isArray(response.body)) return githubStatusError(response);
    blockers.push(...response.body.flatMap((entry) => normalizeGitHubBlocker(entry) ?? []));
    url = nextPageUrl(response.headers);
  }
  return ok(blockers);
}

function normalizeGitHubBlocker(raw: unknown): BlockerRef | null {
  if (!isRecord(raw) || isRecord(raw.pull_request)) return null;
  const number = typeof raw.number === "number" ? raw.number : null;
  return {
    id: number === null ? stringOrNull(raw.id) ?? stringOrNull(raw.node_id) : String(number),
    identifier: number === null ? null : `#${number}`,
    state: stringOrNull(raw.state),
  };
}

async function githubConfig(): Promise<Result<{
  endpoint: string;
  owner: string;
  repo: string;
  token: string;
  assignee: string | null;
  activeStates: string[];
}, unknown>> {
  const config = await settings();
  if (config.tracker.api_key === null) return err("missing_github_token");
  if (config.tracker.project_slug === null) return err("missing_github_repository");
  const [owner, repo, ...rest] = config.tracker.project_slug.split("/");
  if (!owner || !repo || rest.length > 0) return err("missing_github_repository");
  return ok({
    endpoint: config.tracker.endpoint.replace(/\/+$/, ""),
    owner,
    repo,
    token: config.tracker.api_key,
    assignee: config.tracker.assignee,
    activeStates: config.tracker.active_states,
  });
}

function repoUrl(config: { endpoint: string; owner: string; repo: string }): string {
  return `${config.endpoint}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function githubStateParam(states: string[]): "all" | "open" | "closed" {
  const normalized = new Set(states.map((state) => state.trim().toLowerCase()));
  if (normalized.size === 1 && normalized.has("closed")) return "closed";
  if (normalized.size === 1 && normalized.has("open")) return "open";
  return "all";
}

function nextPageUrl(headers: Record<string, string> | undefined): string | null {
  const link = headerValue(headers, "link");
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

function githubStatusError(response: { status: number; body: unknown; headers?: Record<string, string> }): Result<never, unknown> {
  const payload: { type: "github_api_status"; status: number; body: unknown; headers?: Record<string, string> } = {
    type: "github_api_status",
    status: response.status,
    body: response.body,
  };
  if (response.headers !== undefined) payload.headers = response.headers;
  return err(payload);
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
  if (headers === undefined) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function githubMutationStatePayload(stateName: string): { state: "open" | "closed"; state_reason: "completed" | "not_planned" | "duplicate" | "reopened" } {
  const normalized = stateName.trim().toLowerCase();
  if (normalized === "duplicate") return { state: "closed", state_reason: "duplicate" };
  if (["cancelled", "canceled"].includes(normalized)) return { state: "closed", state_reason: "not_planned" };
  if (["closed", "done"].includes(normalized)) return { state: "closed", state_reason: "completed" };
  return { state: "open", state_reason: "reopened" };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchGitHubJson(
  url: string,
  init: { method: "GET" | "POST" | "PATCH"; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
}

function githubLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    if (typeof label === "string") return [normalizeLabel(label)];
    if (isRecord(label) && typeof label.name === "string") return [normalizeLabel(label.name)];
    return [];
  });
}

function assignedToWorker(assigneeId: string | null, assignee?: string | null): boolean {
  const normalizedAssignee = normalizeAssignee(assignee);
  if (normalizedAssignee === null) return true;
  if (assigneeId === null) return false;
  return normalizeAssignee(assigneeId) === normalizedAssignee;
}

function normalizeAssignee(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
