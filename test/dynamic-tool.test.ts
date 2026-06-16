import { afterEach, describe, expect, test } from "bun:test";
import { executeDynamicTool, toolSpecs, type GitHubRestClient, type LinearGraphqlClient } from "../src/dynamic-tool";
import { err, ok } from "../src/result";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { join } from "node:path";
import { clearWorkflowFilePath } from "../src/workflow";

describe("dynamic tool", () => {
  afterEach(() => {
    clearWorkflowFilePath();
  });

  test("toolSpecs advertises the Linear and GitHub input contracts", () => {
    const specs = toolSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(["linear_graphql", "github_rest"]);
    const linearSpec = specs.find((spec) => spec.name === "linear_graphql");
    expect(linearSpec?.description).toContain("Linear");
    expect(linearSpec?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      properties: {
        query: expect.any(Object),
        variables: expect.any(Object),
      },
    });
    const githubSpec = specs.find((spec) => spec.name === "github_rest");
    expect(githubSpec?.description).toContain("GitHub");
    expect(githubSpec?.inputSchema).toMatchObject({
      type: "object",
      required: ["method", "path"],
      properties: {
        method: expect.any(Object),
        path: expect.any(Object),
        body: expect.any(Object),
      },
    });
  });

  test("unsupported tools return a failure payload with the supported tool list", async () => {
    const response = await executeDynamicTool("not_a_real_tool", {});

    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "not_a_real_tool".',
        supportedTools: ["linear_graphql", "github_rest"],
      },
    });
    expect(response.contentItems).toEqual([{ type: "inputText", text: response.output }]);
  });

  test("github_rest executes requests against the configured repository", async () => {
    const calls: unknown[] = [];
    const githubClient: GitHubRestClient = async (method, path, body) => {
      calls.push({ method, path, body });
      return ok({ status: 200, body: { number: 42, title: "GitHub issue" } });
    };

    const response = await executeDynamicTool(
      "github_rest",
      { method: "GET", path: "/issues/42", body: { ignored: true } },
      { githubClient },
    );

    expect(calls).toEqual([{ method: "GET", path: "/issues/42", body: { ignored: true } }]);
    expect(response.success).toBe(true);
    expect(JSON.parse(response.output)).toEqual({ status: 200, body: { number: 42, title: "GitHub issue" } });

    const responseWithHeaders = await executeDynamicTool(
      "github_rest",
      { method: "GET", path: "/issues" },
      {
        githubClient: async () => ok({
          status: 200,
          body: [],
          headers: { link: '<https://github.example/issues?page=2>; rel="next"', "x-ratelimit-remaining": "4999" },
        }),
      },
    );
    expect(responseWithHeaders.success).toBe(true);
    expect(JSON.parse(responseWithHeaders.output)).toEqual({
      status: 200,
      body: [],
      headers: { link: '<https://github.example/issues?page=2>; rel="next"', "x-ratelimit-remaining": "4999" },
    });
  });

  test("github_rest default client uses configured GitHub REST transport", async () => {
    const root = await makeTempRoot("dynamic-tool-github");
    const workflowPath = join(root, "WORKFLOW.md");
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];

    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        endpoint: "https://github.example/api",
        project_slug: "openai/symphony-ts",
      },
    });
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      return Response.json(
        { id: 42, body: "hello" },
        { status: 201, headers: { link: '<https://github.example/api/repos/openai/symphony-ts/issues/42/comments?page=2>; rel="next"', "x-ratelimit-remaining": "4998" } },
      );
    }) as typeof fetch;

    try {
      const response = await executeDynamicTool("github_rest", {
        method: "POST",
        path: "/issues/42/comments",
        body: { body: "hello" },
      });

      expect(response.success).toBe(true);
      expect(JSON.parse(response.output)).toEqual({
        status: 201,
        body: { id: 42, body: "hello" },
        headers: expect.objectContaining({
          link: '<https://github.example/api/repos/openai/symphony-ts/issues/42/comments?page=2>; rel="next"',
          "x-ratelimit-remaining": "4998",
        }),
      });
      expect(requests).toEqual([
        {
          url: "https://github.example/api/repos/openai/symphony-ts/issues/42/comments",
          init: {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: "Bearer github-token",
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({ body: "hello" }),
          },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup(root);
    }
  });

  test("github_rest validates arguments and reports transport failures", async () => {
    const githubClient: GitHubRestClient = async () => {
      throw new Error("github client should not be called");
    };

    let response = await executeDynamicTool("github_rest", { method: "TRACE", path: "/issues" }, { githubClient });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`github_rest.method` must be one of GET, POST, PATCH, PUT, or DELETE." },
    });

    response = await executeDynamicTool("github_rest", { method: "GET", path: "issues" }, { githubClient });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`github_rest.path` must start with `/` and must not contain protocol or host data." },
    });

    response = await executeDynamicTool("github_rest", { method: "GET", path: "/issues" }, {
      githubClient: async () => err("missing_github_token"),
    });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "Symphony is missing GitHub auth. Set `tracker.api_key` in `WORKFLOW.md` or export `GITHUB_TOKEN`." },
    });

    response = await executeDynamicTool("github_rest", { method: "GET", path: "/issues" }, {
      githubClient: async () => ok({ status: 404, body: { message: "Not Found" } }),
    });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({ status: 404, body: { message: "Not Found" } });
  });

  test("linear_graphql returns successful GraphQL responses as tool text", async () => {
    const calls: unknown[] = [];
    const linearClient: LinearGraphqlClient = async (query, variables, opts) => {
      calls.push({ query, variables, opts });
      return ok({ data: { viewer: { id: "usr_123" } } });
    };

    const response = await executeDynamicTool(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", variables: { includeTeams: false } },
      { linearClient },
    );

    expect(calls).toEqual([{ query: "query Viewer { viewer { id } }", variables: { includeTeams: false }, opts: [] }]);
    expect(response.success).toBe(true);
    expect(JSON.parse(response.output)).toEqual({ data: { viewer: { id: "usr_123" } } });
    expect(response.contentItems).toEqual([{ type: "inputText", text: response.output }]);
  });

  test("linear_graphql default client uses configured Linear GraphQL transport", async () => {
    const root = await makeTempRoot("dynamic-tool");
    const workflowPath = join(root, "WORKFLOW.md");
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];

    await writeWorkflowFile(workflowPath, {
      tracker: { api_key: "linear-token", endpoint: "https://linear.example/graphql" },
    });
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, init });
      return Response.json({ data: { viewer: { id: "usr_789" } } });
    }) as typeof fetch;

    try {
      const response = await executeDynamicTool("linear_graphql", {
        query: "query Viewer { viewer { id } }",
        variables: { includeTeams: false },
      });

      expect(response.success).toBe(true);
      expect(JSON.parse(response.output)).toEqual({ data: { viewer: { id: "usr_789" } } });
      expect(requests).toEqual([
        {
          url: "https://linear.example/graphql",
          init: {
            method: "POST",
            headers: { Authorization: "linear-token", "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "query Viewer { viewer { id } }",
              variables: { includeTeams: false },
            }),
          },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup(root);
    }
  });

  test("linear_graphql accepts a raw GraphQL query string and ignores operationName", async () => {
    const calls: unknown[] = [];
    const linearClient: LinearGraphqlClient = async (query, variables, opts) => {
      calls.push({ query, variables, opts });
      return ok({ data: { viewer: { id: "usr_456" } } });
    };

    let response = await executeDynamicTool("linear_graphql", "  query Viewer { viewer { id } }  ", { linearClient });
    expect(response.success).toBe(true);
    expect(calls.pop()).toEqual({ query: "query Viewer { viewer { id } }", variables: {}, opts: [] });

    response = await executeDynamicTool(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", operationName: "Viewer" },
      { linearClient },
    );
    expect(response.success).toBe(true);
    expect(calls.pop()).toEqual({ query: "query Viewer { viewer { id } }", variables: {}, opts: [] });
  });

  test("linear_graphql passes multi-operation documents through unchanged", async () => {
    const query = "query Viewer { viewer { id } }\nquery Teams { teams { nodes { id } } }\n";
    let forwarded = "";
    const response = await executeDynamicTool(
      "linear_graphql",
      { query },
      {
        linearClient: async (nextQuery) => {
          forwarded = nextQuery;
          return ok({ errors: [{ message: "Must provide operation name if query contains multiple operations." }] });
        },
      },
    );

    expect(forwarded).toBe(query.trim());
    expect(response.success).toBe(false);
  });

  test("linear_graphql validates arguments before calling Linear", async () => {
    const linearClient: LinearGraphqlClient = async () => {
      throw new Error("linear client should not be called");
    };

    let response = await executeDynamicTool("linear_graphql", "   ", { linearClient });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`linear_graphql` requires a non-empty `query` string." },
    });

    response = await executeDynamicTool("linear_graphql", { variables: { commentId: "comment-1" } }, { linearClient });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`linear_graphql` requires a non-empty `query` string." },
    });

    response = await executeDynamicTool("linear_graphql", ["bad"], { linearClient });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
      },
    });

    response = await executeDynamicTool(
      "linear_graphql",
      { query: "query Viewer { viewer { id } }", variables: ["bad"] },
      { linearClient },
    );
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "`linear_graphql.variables` must be a JSON object when provided." },
    });
  });

  test("linear_graphql marks GraphQL error responses and transport failures as failures", async () => {
    let response = await executeDynamicTool("linear_graphql", { query: "mutation BadMutation { nope }" }, {
      linearClient: async () => ok({ errors: [{ message: "Unknown field `nope`" }], data: null }),
    });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({ errors: [{ message: "Unknown field `nope`" }], data: null });

    response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => err("missing_linear_api_token"),
    });
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      },
    });

    response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => err({ type: "linear_api_status", status: 503 }),
    });
    expect(JSON.parse(response.output)).toEqual({
      error: { message: "Linear GraphQL request failed with HTTP 503.", status: 503 },
    });

    response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => err({ type: "linear_api_request", reason: "timeout" }),
    });
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: "Linear GraphQL request failed before receiving a successful response.",
        reason: "timeout",
      },
    });
  });

  test("linear_graphql marks symbol-key GraphQL error responses as failures", async () => {
    const errors = Symbol("errors");
    const data = Symbol("data");
    const response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => ok({ [errors]: [{ message: "boom" }], [data]: null } as Record<string, unknown>),
    });

    expect(response.success).toBe(false);
  });

  test("linear_graphql formats unexpected failures and non-JSON payloads", async () => {
    let response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => err("boom"),
    });
    expect(response.success).toBe(false);
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: "Linear GraphQL tool execution failed.",
        reason: "boom",
      },
    });

    response = await executeDynamicTool("linear_graphql", { query: "query Viewer { viewer { id } }" }, {
      linearClient: async () => ok(Symbol.for("ok") as unknown as Record<string, unknown>),
    });
    expect(response.success).toBe(true);
    expect(response.output).toBe("Symbol(ok)");
  });
});
