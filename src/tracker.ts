import { settings } from "./config";
import {
  createGitHubComment,
  fetchGitHubCandidateIssues,
  fetchGitHubIssuesByStates,
  fetchGitHubIssueStatesByIds,
  updateGitHubIssueState,
  type GitHubRequest,
} from "./github";
import {
  fetchCandidateIssues as fetchLinearCandidateIssues,
  fetchIssuesByStates as fetchLinearIssuesByStates,
  fetchIssueStatesByIds as fetchLinearIssueStatesByIds,
  type Issue,
} from "./linear";
import { err, ok, type Result } from "./result";

export type GraphqlClient = (
  query: string,
  variables: Record<string, unknown>,
  opts?: unknown[],
) => Promise<Result<Record<string, unknown>, unknown>>;

export type TrackerDeps = {
  memoryIssues?: unknown[];
  memoryEventSink?: (event: unknown) => void;
  linearClient?: GraphqlClient & Partial<LinearReadClient>;
  githubRequest?: GitHubRequest;
};

type LinearReadClient = {
  fetchCandidateIssues: () => Promise<Result<unknown[], unknown>>;
  fetchIssuesByStates: (states: string[]) => Promise<Result<unknown[], unknown>>;
  fetchIssueStatesByIds: (ids: string[]) => Promise<Result<unknown[], unknown>>;
};

export async function trackerAdapterName(): Promise<"memory" | "linear" | "github"> {
  const kind = (await settings()).tracker.kind;
  if (kind === "memory" || kind === "github") return kind;
  return "linear";
}

export async function fetchCandidateIssues(deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
  const adapter = await trackerAdapterName();
  if (adapter === "memory") return memoryAdapter.fetchCandidateIssues(deps);
  if (adapter === "github") return githubAdapter.fetchCandidateIssues(deps);
  return linearAdapter.fetchCandidateIssues(deps);
}

export async function fetchIssuesByStates(states: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
  const adapter = await trackerAdapterName();
  if (adapter === "memory") return memoryAdapter.fetchIssuesByStates(states, deps);
  if (adapter === "github") return githubAdapter.fetchIssuesByStates(states, deps);
  return linearAdapter.fetchIssuesByStates(states, deps);
}

export async function fetchIssueStatesByIds(ids: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
  const adapter = await trackerAdapterName();
  if (adapter === "memory") return memoryAdapter.fetchIssueStatesByIds(ids, deps);
  if (adapter === "github") return githubAdapter.fetchIssueStatesByIds(ids, deps);
  return linearAdapter.fetchIssueStatesByIds(ids, deps);
}

export async function createComment(issueId: string, body: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
  const adapter = await trackerAdapterName();
  if (adapter === "memory") return memoryAdapter.createComment(issueId, body, deps);
  if (adapter === "github") return githubAdapter.createComment(issueId, body, deps);
  return linearAdapter.createComment(issueId, body, deps);
}

export async function updateIssueState(issueId: string, stateName: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
  const adapter = await trackerAdapterName();
  if (adapter === "memory") return memoryAdapter.updateIssueState(issueId, stateName, deps);
  if (adapter === "github") return githubAdapter.updateIssueState(issueId, stateName, deps);
  return linearAdapter.updateIssueState(issueId, stateName, deps);
}

export const memoryAdapter = {
  async fetchCandidateIssues(deps: TrackerDeps = {}): Promise<Result<Issue[], unknown>> {
    return ok(issueEntries(deps));
  },

  async fetchIssuesByStates(states: string[], deps: TrackerDeps = {}): Promise<Result<Issue[], unknown>> {
    const normalized = new Set(states.map(normalizeState));
    return ok(issueEntries(deps).filter((issue) => normalized.has(normalizeState(issue.state))));
  },

  async fetchIssueStatesByIds(ids: string[], deps: TrackerDeps = {}): Promise<Result<Issue[], unknown>> {
    const wanted = new Set(ids);
    return ok(issueEntries(deps).filter((issue) => typeof issue.id === "string" && wanted.has(issue.id)));
  },

  async createComment(issueId: string, body: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    deps.memoryEventSink?.({ type: "memory_tracker_comment", issueId, body });
    return ok(undefined);
  },

  async updateIssueState(issueId: string, stateName: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    deps.memoryEventSink?.({ type: "memory_tracker_state_update", issueId, stateName });
    return ok(undefined);
  },
};

export const linearAdapter = {
  async fetchCandidateIssues(deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return deps.linearClient?.fetchCandidateIssues?.() ?? fetchLinearCandidateIssues();
  },

  async fetchIssuesByStates(states: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return deps.linearClient?.fetchIssuesByStates?.(states) ?? fetchLinearIssuesByStates(states);
  },

  async fetchIssueStatesByIds(ids: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return deps.linearClient?.fetchIssueStatesByIds?.(ids) ?? fetchLinearIssueStatesByIds(ids);
  },

  async createComment(issueId: string, body: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    const client = deps.linearClient;
    if (client === undefined) return err("missing_linear_client");
    const response = await client(CREATE_COMMENT_MUTATION, { issueId, body });
    if (!response.ok) return response;
    return mapAtPath(response.value, ["data", "commentCreate", "success"]) === true
      ? ok(undefined)
      : err("comment_create_failed");
  },

  async updateIssueState(issueId: string, stateName: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    const client = deps.linearClient;
    if (client === undefined) return err("missing_linear_client");
    const resolved = await resolveStateId(issueId, stateName, client);
    if (!resolved.ok) return resolved;
    const response = await client(UPDATE_STATE_MUTATION, { issueId, stateId: resolved.value });
    if (!response.ok) return response;
    return mapAtPath(response.value, ["data", "issueUpdate", "success"]) === true
      ? ok(undefined)
      : err("issue_update_failed");
  },
};

export const githubAdapter = {
  async fetchCandidateIssues(deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return fetchGitHubCandidateIssues(deps.githubRequest);
  },

  async fetchIssuesByStates(states: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return fetchGitHubIssuesByStates(states, deps.githubRequest);
  },

  async fetchIssueStatesByIds(ids: string[], deps: TrackerDeps = {}): Promise<Result<unknown[], unknown>> {
    return fetchGitHubIssueStatesByIds(ids, deps.githubRequest);
  },

  async createComment(issueId: string, body: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    return createGitHubComment(issueId, body, deps.githubRequest);
  },

  async updateIssueState(issueId: string, stateName: string, deps: TrackerDeps = {}): Promise<Result<void, unknown>> {
    return updateGitHubIssueState(issueId, stateName, deps.githubRequest);
  },
};

const CREATE_COMMENT_MUTATION = `mutation SymphonyCreateComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) { success }
}`;

const UPDATE_STATE_MUTATION = `mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {stateId: $stateId}) { success }
}`;

const STATE_LOOKUP_QUERY = `query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
  issue(id: $issueId) { team { states(filter: {name: {eq: $stateName}}, first: 1) { nodes { id } } } }
}`;

async function resolveStateId(
  issueId: string,
  stateName: string,
  client: GraphqlClient,
): Promise<Result<string, unknown>> {
  const response = await client(STATE_LOOKUP_QUERY, { issueId, stateName });
  if (!response.ok) return response;
  const stateId = mapAtPath(response.value, ["data", "issue", "team", "states", "nodes", 0, "id"]);
  return typeof stateId === "string" ? ok(stateId) : err("state_not_found");
}

function issueEntries(deps: TrackerDeps): Issue[] {
  return (deps.memoryIssues ?? []).filter(isIssue);
}

function isIssue(value: unknown): value is Issue {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.identifier === "string" || typeof value.state === "string" || typeof value.title === "string")
  );
}

function normalizeState(state: unknown): string {
  return typeof state === "string" ? state.trim().toLowerCase() : "";
}

function mapAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[key];
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
