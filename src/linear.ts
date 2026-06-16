import { err, ok, type Result } from "./result";
import { settings } from "./config";

export type BlockerRef = { id?: string | null; identifier?: string | null; state?: string | null };

export type Issue = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  state?: string | null;
  branchName?: string | null;
  url?: string | null;
  assigneeId?: string | null;
  blockedBy?: BlockerRef[];
  labels?: string[];
  assignedToWorker?: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

export type LinearGraphqlRequest = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type LinearGraphqlOptions = {
  operationName?: string | null;
  request?: LinearGraphqlRequest;
};

export type LinearGraphqlClient = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Result<Record<string, unknown>, unknown>>;

const ISSUE_PAGE_SIZE = 50;
const QUERY_BY_STATES = `query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes { id identifier title description priority state { name } branchName url assignee { id } labels { nodes { name } } inverseRelations(first: $relationFirst) { nodes { type issue { id identifier state { name } } } } createdAt updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;
const QUERY_BY_IDS = `query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes { id identifier title description priority state { name } branchName url assignee { id } labels { nodes { name } } inverseRelations(first: $relationFirst) { nodes { type issue { id identifier state { name } } } } createdAt updatedAt }
  }
}`;

export function labelNames(issue: Issue): string[] {
  return issue.labels ?? [];
}

export async function fetchCandidateIssues(
  graphql: LinearGraphqlClient = linearGraphql,
): Promise<Result<Issue[], unknown>> {
  const config = await settings();
  if (config.tracker.api_key === null) return err("missing_linear_api_token");
  if (config.tracker.project_slug === null) return err("missing_linear_project_slug");
  return fetchIssuesByStatesForProject(
    config.tracker.project_slug,
    config.tracker.active_states,
    config.tracker.assignee,
    graphql,
  );
}

export async function fetchIssuesByStates(
  stateNames: string[],
  graphql: LinearGraphqlClient = linearGraphql,
): Promise<Result<Issue[], unknown>> {
  const normalizedStates = Array.from(new Set(stateNames.map(String)));
  if (normalizedStates.length === 0) return ok([]);

  const config = await settings();
  if (config.tracker.api_key === null) return err("missing_linear_api_token");
  if (config.tracker.project_slug === null) return err("missing_linear_project_slug");
  return fetchIssuesByStatesForProject(config.tracker.project_slug, normalizedStates, null, graphql);
}

export async function fetchIssueStatesByIds(
  issueIds: string[],
  graphql: LinearGraphqlClient = linearGraphql,
): Promise<Result<Issue[], unknown>> {
  const ids = Array.from(new Set(issueIds));
  if (ids.length === 0) return ok([]);

  const config = await settings();
  return fetchIssueStatesByIdsWithAssignee(ids, config.tracker.assignee, graphql);
}

export async function linearGraphql(
  query: string,
  variables: Record<string, unknown> = {},
  opts: LinearGraphqlOptions = {},
): Promise<Result<Record<string, unknown>, unknown>> {
  const config = await settings();
  const token = config.tracker.api_key;
  if (token === null) return err("missing_linear_api_token");

  const payload = buildGraphqlPayload(query, variables, opts.operationName);
  const request = opts.request ?? fetchLinearGraphql;
  try {
    const response = await request(config.tracker.endpoint, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status !== 200) {
      return err({ type: "linear_api_status", status: response.status, body: response.body });
    }
    return ok(response.body);
  } catch (error) {
    return err({ type: "linear_api_request", reason: error instanceof Error ? error.message : String(error) });
  }
}

export function routable(issue: Issue, requiredLabels: string[]): boolean {
  if (issue.assignedToWorker === false) return false;
  const labels = new Set((issue.labels ?? []).map(normalizeLabel));
  return requiredLabels.every((label) => labels.has(normalizeLabel(label)));
}

export function normalizeIssue(raw: unknown, assignee?: string | null): Issue | null {
  if (!isRecord(raw)) return null;
  const assigneeRecord = isRecord(raw.assignee) ? raw.assignee : null;
  const assigneeId = stringOrNull(assigneeRecord?.id);

  return {
    id: stringOrNull(raw.id),
    identifier: stringOrNull(raw.identifier),
    title: stringOrNull(raw.title),
    description: stringOrNull(raw.description),
    priority: Number.isInteger(raw.priority) ? (raw.priority as number) : null,
    state: nestedString(raw, ["state", "name"]),
    branchName: stringOrNull(raw.branchName),
    url: stringOrNull(raw.url),
    assigneeId,
    blockedBy: extractBlockers(raw),
    labels: extractLabels(raw),
    assignedToWorker: assignedToWorker(assigneeId, assignee),
    createdAt: parseDate(raw.createdAt),
    updatedAt: parseDate(raw.updatedAt),
  };
}

export function mergeIssuePagesForTest(issuePages: Issue[][]): Issue[] {
  return issuePages.reduce<Issue[]>((acc, page) => acc.concat(page), []);
}

export async function fetchIssuesByStatesForTest(
  projectSlug: string,
  stateNames: string[],
  graphql: (query: string, variables: Record<string, unknown>) => Promise<Result<Record<string, unknown>, unknown>>,
): Promise<Result<Issue[], unknown>> {
  const normalizedStates = Array.from(new Set(stateNames.map(String)));
  if (normalizedStates.length === 0) return ok([]);
  return fetchIssuesByStatesForProject(projectSlug, normalizedStates, null, graphql);
}

export async function fetchIssueStatesByIdsForTest(
  issueIds: string[],
  graphql: (query: string, variables: Record<string, unknown>) => Promise<Result<Record<string, unknown>, unknown>>,
): Promise<Result<Issue[], unknown>> {
  const ids = Array.from(new Set(issueIds));
  return fetchIssueStatesByIdsWithAssignee(ids, null, graphql);
}

export function nextPageCursor(pageInfo: unknown): Result<string | null, unknown> {
  if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true) return ok(null);
  return typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0
    ? ok(pageInfo.endCursor)
    : err("linear_missing_end_cursor");
}

async function fetchIssueStatesByIdsWithAssignee(
  ids: string[],
  assignee: string | null,
  graphql: LinearGraphqlClient,
): Promise<Result<Issue[], unknown>> {
  const order = new Map(ids.map((id, index) => [id, index]));
  const issues: Issue[] = [];

  for (let index = 0; index < ids.length; index += ISSUE_PAGE_SIZE) {
    const batch = ids.slice(index, index + ISSUE_PAGE_SIZE);
    const response = await graphql(QUERY_BY_IDS, { ids: batch, first: batch.length, relationFirst: ISSUE_PAGE_SIZE });
    if (!response.ok) return response;

    const nodes = nestedValue(response.value, ["data", "issues", "nodes"]);
    if (!Array.isArray(nodes)) return err("linear_unknown_payload");
    for (const node of nodes) {
      const issue = normalizeIssue(node, assignee);
      if (issue !== null) issues.push(issue);
    }
  }

  issues.sort((left, right) => (order.get(left.id ?? "") ?? ids.length) - (order.get(right.id ?? "") ?? ids.length));
  return ok(issues);
}

function fetchIssuesByStatesForProject(
  projectSlug: string,
  stateNames: string[],
  assignee: string | null,
  graphql: LinearGraphqlClient,
): Promise<Result<Issue[], unknown>> {
  return fetchIssuesByStatesPage(projectSlug, stateNames, assignee, null, [], graphql);
}

async function fetchIssuesByStatesPage(
  projectSlug: string,
  stateNames: string[],
  assignee: string | null,
  after: string | null,
  acc: Issue[],
  graphql: (query: string, variables: Record<string, unknown>) => Promise<Result<Record<string, unknown>, unknown>>,
): Promise<Result<Issue[], unknown>> {
  const response = await graphql(QUERY_BY_STATES, {
    projectSlug,
    stateNames,
    first: ISSUE_PAGE_SIZE,
    relationFirst: ISSUE_PAGE_SIZE,
    after,
  });
  if (!response.ok) return response;

  const decoded = decodeLinearPageResponse(response.value, assignee);
  if (!decoded.ok) return decoded;
  const nextIssues = acc.concat(decoded.value.issues);
  const cursor = nextPageCursor(decoded.value.pageInfo);
  if (!cursor.ok) return cursor;
  if (cursor.value === null) return ok(nextIssues);
  return fetchIssuesByStatesPage(projectSlug, stateNames, assignee, cursor.value, nextIssues, graphql);
}

function decodeLinearPageResponse(
  payload: Record<string, unknown>,
  assignee: string | null,
): Result<{ issues: Issue[]; pageInfo: unknown }, unknown> {
  if (Array.isArray(payload.errors)) return err({ type: "linear_graphql_errors", errors: payload.errors });
  const nodes = nestedValue(payload, ["data", "issues", "nodes"]);
  const pageInfo = nestedValue(payload, ["data", "issues", "pageInfo"]);
  if (!Array.isArray(nodes) || pageInfo === undefined) return err("linear_unknown_payload");
  return ok({ issues: nodes.flatMap((node) => normalizeIssue(node, assignee) ?? []), pageInfo });
}

function extractLabels(raw: Record<string, unknown>): string[] {
  const nodes = nestedValue(raw, ["labels", "nodes"]);
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((label) => (isRecord(label) ? stringOrNull(label.name) : null))
    .filter((label): label is string => label !== null)
    .map(normalizeLabel);
}

function buildGraphqlPayload(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { query, variables };
  if (typeof operationName === "string" && operationName.trim() !== "") {
    payload.operationName = operationName.trim();
  }
  return payload;
}

async function fetchLinearGraphql(
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: isRecord(body) ? body : { body } };
}

function extractBlockers(raw: Record<string, unknown>): BlockerRef[] {
  const nodes = nestedValue(raw, ["inverseRelations", "nodes"]);
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((relation) => {
    if (!isRecord(relation) || normalizeLabel(stringOrNull(relation.type) ?? "") !== "blocks") return [];
    const issue = isRecord(relation.issue) ? relation.issue : {};
    return [{
      id: stringOrNull(issue.id),
      identifier: stringOrNull(issue.identifier),
      state: nestedString(issue, ["state", "name"]),
    }];
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

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nestedString(value: unknown, path: string[]): string | null {
  return stringOrNull(nestedValue(value, path));
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
