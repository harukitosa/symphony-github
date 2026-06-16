import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import type { Issue } from "../src/linear";
import {
  createComment,
  fetchCandidateIssues,
  fetchIssueStatesByIds,
  fetchIssuesByStates,
  githubAdapter,
  linearAdapter,
  memoryAdapter,
  trackerAdapterName,
  updateIssueState,
  type GraphqlClient,
} from "../src/tracker";
import { err, ok } from "../src/result";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-tracker");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  delete process.env.GITHUB_TOKEN;
  await cleanup(root);
});

describe("tracker adapter", () => {
  test("delegates to memory and linear adapters", async () => {
    const issue: Issue = { id: "issue-1", identifier: "MT-1", state: "In Progress" };
    const events: unknown[] = [];
    await writeWorkflowFile(workflowPath, { tracker: { kind: "memory" } });

    const deps = { memoryIssues: [issue, { id: "ignored" }], memoryEventSink: (event: unknown) => events.push(event) };
    expect(await trackerAdapterName()).toBe("memory");
    expect(await fetchCandidateIssues(deps)).toEqual(ok([issue]));
    expect(await fetchIssuesByStates([" in progress ", "not matching"], deps)).toEqual(ok([issue]));
    expect(await fetchIssueStatesByIds(["issue-1"], deps)).toEqual(ok([issue]));
    expect(await createComment("issue-1", "comment", deps)).toEqual(ok(undefined));
    expect(await updateIssueState("issue-1", "Done", deps)).toEqual(ok(undefined));
    expect(events).toEqual([
      { type: "memory_tracker_comment", issueId: "issue-1", body: "comment" },
      { type: "memory_tracker_state_update", issueId: "issue-1", stateName: "Done" },
    ]);

    await expect(memoryAdapter.createComment("issue-1", "quiet", { memoryIssues: [] })).resolves.toEqual(ok(undefined));
    await expect(memoryAdapter.updateIssueState("issue-1", "Quiet", { memoryIssues: [] })).resolves.toEqual(ok(undefined));

    await writeWorkflowFile(workflowPath, { tracker: { kind: "linear" } });
    expect(await trackerAdapterName()).toBe("linear");
  });

  test("delegates to GitHub adapter for repository issues", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        endpoint: "https://github.example/api",
        project_slug: "openai/symphony-ts",
      },
    });

    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
    const request = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, init });
      if (init.method === "GET" && url.includes("/dependencies/blocked_by")) {
        return { status: 200, body: [] };
      }
      if (init.method === "GET" && url.endsWith("/issues/42")) {
        return {
          status: 200,
          body: {
            id: 123,
            node_id: "node-123",
            number: 42,
            title: "GitHub issue refreshed",
            body: "Issue body refreshed",
            state: "open",
            html_url: "https://github.example/openai/symphony-ts/issues/42",
            labels: [{ name: "symphony" }],
            assignee: { login: "dev" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-03T00:00:00Z",
          },
        };
      }
      if (init.method === "GET") {
        return {
          status: 200,
          body: [
            {
              id: 123,
              node_id: "node-123",
              number: 42,
              title: "GitHub issue",
              body: "Issue body",
              state: "open",
              html_url: "https://github.example/openai/symphony-ts/issues/42",
              labels: [{ name: "symphony" }, { name: "javascript" }],
              assignee: { login: "dev" },
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
            },
            {
              id: 999,
              number: 100,
              title: "Pull request should be ignored",
              state: "open",
              pull_request: {},
            },
          ],
        };
      }
      return { status: 201, body: {} };
    };

    expect(await trackerAdapterName()).toBe("github");
    expect(await fetchCandidateIssues({ githubRequest: request })).toEqual(ok([
      {
        id: "42",
        identifier: "#42",
        title: "GitHub issue",
        description: "Issue body",
        priority: null,
        state: "open",
        branchName: null,
        url: "https://github.example/openai/symphony-ts/issues/42",
        assigneeId: "dev",
        blockedBy: [],
        labels: ["symphony", "javascript"],
        assignedToWorker: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]));
    expect(calls[0]?.url).toContain("/repos/openai/symphony-ts/issues?");
    expect(calls[0]?.url).toContain("state=all");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer github-token");

    expect(await fetchIssueStatesByIds(["42"], { githubRequest: request })).toEqual(ok([
      {
        id: "42",
        identifier: "#42",
        title: "GitHub issue refreshed",
        description: "Issue body refreshed",
        priority: null,
        state: "open",
        branchName: null,
        url: "https://github.example/openai/symphony-ts/issues/42",
        assigneeId: "dev",
        blockedBy: [],
        labels: ["symphony"],
        assignedToWorker: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ]));
    expect(calls.at(-2)?.url).toBe("https://github.example/api/repos/openai/symphony-ts/issues/42");

    expect(await createComment("42", "hello", { githubRequest: request })).toEqual(ok(undefined));
    expect(calls.at(-1)).toMatchObject({
      url: "https://github.example/api/repos/openai/symphony-ts/issues/42/comments",
      init: { method: "POST" },
    });
    expect(JSON.parse(calls.at(-1)?.init.body ?? "{}")).toEqual({ body: "hello" });

    expect(await updateIssueState("42", "Done", { githubRequest: request })).toEqual(ok(undefined));
    expect(calls.at(-1)).toMatchObject({
      url: "https://github.example/api/repos/openai/symphony-ts/issues/42",
      init: { method: "PATCH" },
    });
    expect(JSON.parse(calls.at(-1)?.init.body ?? "{}")).toEqual({ state: "closed", state_reason: "completed" });

    expect(await updateIssueState("42", "Duplicate", { githubRequest: request })).toEqual(ok(undefined));
    expect(JSON.parse(calls.at(-1)?.init.body ?? "{}")).toEqual({ state: "closed", state_reason: "duplicate" });

    expect(await updateIssueState("42", "Cancelled", { githubRequest: request })).toEqual(ok(undefined));
    expect(JSON.parse(calls.at(-1)?.init.body ?? "{}")).toEqual({ state: "closed", state_reason: "not_planned" });

    expect(await updateIssueState("42", "open", { githubRequest: request })).toEqual(ok(undefined));
    expect(JSON.parse(calls.at(-1)?.init.body ?? "{}")).toEqual({ state: "open", state_reason: "reopened" });
  });

  test("GitHub adapter reports config, status, and mutation failures", async () => {
    await writeWorkflowFile(workflowPath, { tracker: { kind: "github", api_key: null, project_slug: null } });
    expect(await githubAdapter.fetchCandidateIssues()).toEqual(err("missing_github_token"));

    await writeWorkflowFile(workflowPath, { tracker: { kind: "github", api_key: "token", project_slug: null } });
    expect(await githubAdapter.fetchCandidateIssues()).toEqual(err("missing_github_repository"));

    await writeWorkflowFile(workflowPath, {
      tracker: { kind: "github", api_key: "token", project_slug: "openai/symphony-ts" },
    });

    const statusRequest = async () => ({ status: 500, body: { message: "bad" } });
    expect(await githubAdapter.fetchCandidateIssues({ githubRequest: statusRequest })).toEqual(
      err({ type: "github_api_status", status: 500, body: { message: "bad" } }),
    );

    const rateLimitedRequest = async () => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1770000000",
        "retry-after": "60",
      },
    });
    expect(await githubAdapter.fetchCandidateIssues({ githubRequest: rateLimitedRequest })).toEqual(
      err({
        type: "github_api_status",
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1770000000",
          "retry-after": "60",
        },
      }),
    );

    const missingComment = async () => ({ status: 404, body: {} });
    expect(await githubAdapter.createComment("42", "hello", { githubRequest: missingComment })).toEqual(
      err("github_comment_create_failed"),
    );

    const missingUpdate = async () => ({ status: 404, body: {} });
    expect(await githubAdapter.updateIssueState("42", "open", { githubRequest: missingUpdate })).toEqual(
      err("github_issue_update_failed"),
    );
  });

  test("GitHub adapter routes issues assigned through the assignees collection", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        endpoint: "https://github.example/api",
        project_slug: "openai/symphony-ts",
        assignee: "octocat",
      },
    });

    const request = async (url: string) => {
      if (url.includes("/dependencies/blocked_by")) return { status: 200, body: [] };
      return {
        status: 200,
        body: [
          {
            id: 123,
            number: 42,
            title: "GitHub issue",
            body: "Issue body",
            state: "open",
            html_url: "https://github.example/openai/symphony-ts/issues/42",
            labels: [],
            assignee: { login: "someone-else" },
            assignees: [{ login: "someone-else" }, { login: "octocat" }],
          },
        ],
      };
    };

    expect(await githubAdapter.fetchCandidateIssues({ githubRequest: request })).toEqual(ok([
      expect.objectContaining({
        id: "42",
        assigneeId: "octocat",
        assignedToWorker: true,
      }),
    ]));
  });

  test("GitHub adapter maps issue dependencies into blockers", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        endpoint: "https://github.example/api",
        project_slug: "openai/symphony-ts",
        active_states: ["open"],
      },
    });

    const calls: string[] = [];
    const request = async (url: string) => {
      calls.push(url);
      if (url.includes("/issues/42/dependencies/blocked_by")) {
        return {
          status: 200,
          body: [
            {
              id: 456,
              number: 77,
              title: "Blocking issue",
              body: "Blocker body",
              state: "open",
              html_url: "https://github.example/openai/symphony-ts/issues/77",
              labels: [],
            },
          ],
        };
      }
      return {
        status: 200,
        body: [
          {
            id: 123,
            number: 42,
            title: "Blocked issue",
            body: "Issue body",
            state: "open",
            html_url: "https://github.example/openai/symphony-ts/issues/42",
            labels: [],
          },
        ],
      };
    };

    expect(await githubAdapter.fetchCandidateIssues({ githubRequest: request })).toEqual(ok([
      expect.objectContaining({
        id: "42",
        identifier: "#42",
        blockedBy: [{ id: "77", identifier: "#77", state: "open" }],
      }),
    ]));
    expect(calls).toContain(
      "https://github.example/api/repos/openai/symphony-ts/issues/42/dependencies/blocked_by?per_page=100",
    );
  });

  test("GitHub adapter follows issue pagination links", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        endpoint: "https://github.example/api",
        project_slug: "openai/symphony-ts",
        active_states: ["open"],
      },
    });

    const calls: string[] = [];
    const request = async (url: string) => {
      calls.push(url);
      if (url.includes("/dependencies/blocked_by")) {
        return { status: 200, body: [] };
      }
      if (url.includes("page=2")) {
        return {
          status: 200,
          body: [
            {
              id: 2,
              number: 2,
              title: "Second page",
              body: "Page two body",
              state: "open",
              html_url: "https://github.example/openai/symphony-ts/issues/2",
              labels: [],
              created_at: "2026-01-02T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
            },
          ],
        };
      }

      return {
        status: 200,
        headers: {
          link: '<https://github.example/api/repos/openai/symphony-ts/issues?state=open&per_page=100&page=2>; rel="next", <https://github.example/api/repos/openai/symphony-ts/issues?state=open&per_page=100&page=2>; rel="last"',
        },
        body: [
          {
            id: 1,
            number: 1,
            title: "First page",
            body: "Page one body",
            state: "open",
            html_url: "https://github.example/openai/symphony-ts/issues/1",
            labels: [],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
    };

    expect(await githubAdapter.fetchCandidateIssues({ githubRequest: request })).toEqual(ok([
      expect.objectContaining({ id: "1", identifier: "#1", title: "First page" }),
      expect.objectContaining({ id: "2", identifier: "#2", title: "Second page" }),
    ]));
    expect(calls).toEqual([
      "https://github.example/api/repos/openai/symphony-ts/issues?state=open&per_page=100",
      "https://github.example/api/repos/openai/symphony-ts/issues/1/dependencies/blocked_by?per_page=100",
      "https://github.example/api/repos/openai/symphony-ts/issues?state=open&per_page=100&page=2",
      "https://github.example/api/repos/openai/symphony-ts/issues/2/dependencies/blocked_by?per_page=100",
    ]);
  });

  test("linear adapter delegates reads and validates comment mutation responses", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const client: GraphqlClient & {
      fetchCandidateIssues: () => Promise<any>;
      fetchIssuesByStates: (states: string[]) => Promise<any>;
      fetchIssueStatesByIds: (ids: string[]) => Promise<any>;
    } = Object.assign(
      async (query: string, variables: Record<string, unknown>) => {
        calls.push({ query, variables });
        return ok({ data: { commentCreate: { success: true } } });
      },
      {
        fetchCandidateIssues: async () => ok(["candidate"]),
        fetchIssuesByStates: async (states: string[]) => ok(states),
        fetchIssueStatesByIds: async (ids: string[]) => ok(ids),
      },
    );

    expect(await linearAdapter.fetchCandidateIssues({ linearClient: client })).toEqual(ok(["candidate"]));
    expect(await linearAdapter.fetchIssuesByStates(["Todo"], { linearClient: client })).toEqual(ok(["Todo"]));
    expect(await linearAdapter.fetchIssueStatesByIds(["issue-1"], { linearClient: client })).toEqual(ok(["issue-1"]));

    expect(await linearAdapter.createComment("issue-1", "hello", { linearClient: client })).toEqual(ok(undefined));
    expect(calls.pop()).toMatchObject({ variables: { body: "hello", issueId: "issue-1" } });

    const failedClient: GraphqlClient = async () => ok({ data: { commentCreate: { success: false } } });
    expect(await linearAdapter.createComment("issue-1", "broken", { linearClient: failedClient })).toEqual(
      err("comment_create_failed"),
    );

    const errorClient: GraphqlClient = async () => err("boom");
    expect(await linearAdapter.createComment("issue-1", "boom", { linearClient: errorClient })).toEqual(err("boom"));

    const weirdClient: GraphqlClient = async () => ok({ data: {} });
    expect(await linearAdapter.createComment("issue-1", "weird", { linearClient: weirdClient })).toEqual(
      err("comment_create_failed"),
    );
  });

  test("linear adapter resolves target state and validates issue update responses", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const makeClient = (responses: Array<any>): GraphqlClient => async (query, variables) => {
      calls.push({ query, variables });
      const next = responses.shift();
      return next;
    };

    let client = makeClient([
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: { issueUpdate: { success: true } } }),
    ]);
    expect(await linearAdapter.updateIssueState("issue-1", "Done", { linearClient: client })).toEqual(ok(undefined));
    expect(calls.at(-2)).toMatchObject({ variables: { issueId: "issue-1", stateName: "Done" } });
    expect(calls.at(-1)).toMatchObject({ variables: { issueId: "issue-1", stateId: "state-1" } });

    client = makeClient([
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: { issueUpdate: { success: false } } }),
    ]);
    expect(await linearAdapter.updateIssueState("issue-1", "Broken", { linearClient: client })).toEqual(
      err("issue_update_failed"),
    );

    client = makeClient([err("boom")]);
    expect(await linearAdapter.updateIssueState("issue-1", "Boom", { linearClient: client })).toEqual(err("boom"));

    client = makeClient([ok({ data: {} })]);
    expect(await linearAdapter.updateIssueState("issue-1", "Missing", { linearClient: client })).toEqual(
      err("state_not_found"),
    );

    client = makeClient([
      ok({ data: { issue: { team: { states: { nodes: [{ id: "state-1" }] } } } } }),
      ok({ data: {} }),
    ]);
    expect(await linearAdapter.updateIssueState("issue-1", "Weird", { linearClient: client })).toEqual(
      err("issue_update_failed"),
    );
  });

  test("linear adapter uses the built-in Linear client for reads by default", async () => {
    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: "linear-token", endpoint: "https://linear.example/graphql", project_slug: "project" },
    });
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];

    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      const payload = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const issueId = Array.isArray(payload.variables.ids) ? payload.variables.ids[0] : "issue-1";
      return Response.json({
        data: {
          issues: {
            nodes: [
              {
                id: issueId,
                identifier: "MT-1",
                title: "Linear issue",
                state: { name: "Todo" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }) as typeof fetch;

    try {
      expect(await linearAdapter.fetchCandidateIssues()).toEqual(ok([
        {
          id: "issue-1",
          identifier: "MT-1",
          title: "Linear issue",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: null,
          assigneeId: null,
          blockedBy: [],
          labels: [],
          assignedToWorker: true,
          createdAt: null,
          updatedAt: null,
        },
      ]));
      expect(await linearAdapter.fetchIssuesByStates(["Todo"])).toEqual(ok([
        {
          id: "issue-1",
          identifier: "MT-1",
          title: "Linear issue",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: null,
          assigneeId: null,
          blockedBy: [],
          labels: [],
          assignedToWorker: true,
          createdAt: null,
          updatedAt: null,
        },
      ]));
      expect(await linearAdapter.fetchIssueStatesByIds(["issue-9"])).toEqual(ok([
        {
          id: "issue-9",
          identifier: "MT-1",
          title: "Linear issue",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: null,
          assigneeId: null,
          blockedBy: [],
          labels: [],
          assignedToWorker: true,
          createdAt: null,
          updatedAt: null,
        },
      ]));
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
