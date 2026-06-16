import { err, ok, type Result } from "./result";
import { linearGraphql } from "./linear";
import { settings } from "./config";

export type DynamicToolResponse = {
  success: boolean;
  output: string;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LinearGraphqlClient = (
  query: string,
  variables: Record<string, unknown>,
  opts: unknown[],
) => Promise<Result<Record<string, unknown>, unknown>>;

export type GitHubRestClient = (
  method: GitHubRestMethod,
  path: string,
  body: unknown,
) => Promise<Result<{ status: number; body: unknown; headers?: Record<string, string> }, unknown>>;

type GitHubRestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const LINEAR_GRAPHQL_TOOL = "linear_graphql";
const LINEAR_GRAPHQL_DESCRIPTION = "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.";
const GITHUB_REST_TOOL = "github_rest";
const GITHUB_REST_DESCRIPTION = "Execute a GitHub REST API request against Symphony's configured repository and auth.";

export function toolSpecs(): ToolSpec[] {
  return [
    {
      name: LINEAR_GRAPHQL_TOOL,
      description: LINEAR_GRAPHQL_DESCRIPTION,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "GraphQL query or mutation document to execute against Linear.",
          },
          variables: {
            type: ["object", "null"],
            description: "Optional GraphQL variables object.",
            additionalProperties: true,
          },
        },
      },
    },
    {
      name: GITHUB_REST_TOOL,
      description: GITHUB_REST_DESCRIPTION,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["method", "path"],
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
            description: "GitHub REST method.",
          },
          path: {
            type: "string",
            description: "Repository-relative REST path, for example `/issues/123/comments`.",
          },
          body: {
            type: ["object", "array", "string", "number", "boolean", "null"],
            description: "Optional JSON request body.",
          },
        },
      },
    },
  ];
}

export async function executeDynamicTool(
  tool: string | null | undefined,
  argumentsValue: unknown,
  opts: { linearClient?: LinearGraphqlClient; githubClient?: GitHubRestClient } = {},
): Promise<DynamicToolResponse> {
  if (tool === LINEAR_GRAPHQL_TOOL) {
    return executeLinearGraphql(argumentsValue, opts.linearClient ?? defaultLinearClient);
  }

  if (tool === GITHUB_REST_TOOL) {
    return executeGitHubRest(argumentsValue, opts.githubClient ?? defaultGitHubClient);
  }

  return failureResponse({
    error: {
      message: `Unsupported dynamic tool: ${JSON.stringify(tool)}.`,
      supportedTools: toolSpecs().map((spec) => spec.name),
    },
  });
}

async function executeLinearGraphql(
  argumentsValue: unknown,
  linearClient: LinearGraphqlClient,
): Promise<DynamicToolResponse> {
  const normalized = normalizeLinearGraphqlArguments(argumentsValue);
  if (!normalized.ok) return failureResponse(toolErrorPayload(normalized.error));

  const response = await linearClient(normalized.value.query, normalized.value.variables, []);
  if (!response.ok) return failureResponse(toolErrorPayload(response.error));
  return graphqlResponse(response.value);
}

async function executeGitHubRest(
  argumentsValue: unknown,
  githubClient: GitHubRestClient,
): Promise<DynamicToolResponse> {
  const normalized = normalizeGitHubRestArguments(argumentsValue);
  if (!normalized.ok) return failureResponse(githubToolErrorPayload(normalized.error));

  const response = await githubClient(normalized.value.method, normalized.value.path, normalized.value.body);
  if (!response.ok) return failureResponse(githubToolErrorPayload(response.error));
  return dynamicToolResponse(response.value.status >= 200 && response.value.status < 300, encodePayload(response.value));
}

function normalizeLinearGraphqlArguments(
  argumentsValue: unknown,
): Result<{ query: string; variables: Record<string, unknown> }, string> {
  if (typeof argumentsValue === "string") {
    const query = argumentsValue.trim();
    return query === "" ? err("missing_query") : ok({ query, variables: {} });
  }

  if (!isRecord(argumentsValue)) return err("invalid_arguments");

  const queryValue = argumentsValue.query;
  if (typeof queryValue !== "string" || queryValue.trim() === "") return err("missing_query");

  const variablesValue = argumentsValue.variables ?? {};
  if (!isRecord(variablesValue)) return err("invalid_variables");

  return ok({ query: queryValue.trim(), variables: variablesValue });
}

function normalizeGitHubRestArguments(
  argumentsValue: unknown,
): Result<{ method: GitHubRestMethod; path: string; body: unknown }, string> {
  if (!isRecord(argumentsValue)) return err("github_invalid_arguments");
  const method = normalizeGitHubMethod(argumentsValue.method);
  if (method === null) return err("github_invalid_method");
  const path = typeof argumentsValue.path === "string" ? argumentsValue.path.trim() : "";
  if (!validGitHubPath(path)) return err("github_invalid_path");
  return ok({ method, path, body: argumentsValue.body ?? null });
}

function graphqlResponse(response: Record<string, unknown>): DynamicToolResponse {
  const errors = graphqlErrors(response);
  return dynamicToolResponse(!(Array.isArray(errors) && errors.length > 0), encodePayload(response));
}

function failureResponse(payload: Record<string, unknown>): DynamicToolResponse {
  return dynamicToolResponse(false, encodePayload(payload));
}

function dynamicToolResponse(success: boolean, output: string): DynamicToolResponse {
  return {
    success,
    output,
    contentItems: [{ type: "inputText", text: output }],
  };
}

function encodePayload(payload: unknown): string {
  const encoded = JSON.stringify(payload, null, 2);
  return encoded === undefined ? String(payload) : encoded;
}

function toolErrorPayload(reason: unknown): Record<string, unknown> {
  if (reason === "missing_query") {
    return { error: { message: "`linear_graphql` requires a non-empty `query` string." } };
  }
  if (reason === "invalid_arguments") {
    return {
      error: {
        message: "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
      },
    };
  }
  if (reason === "invalid_variables") {
    return { error: { message: "`linear_graphql.variables` must be a JSON object when provided." } };
  }
  if (reason === "missing_linear_api_token") {
    return {
      error: {
        message: "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      },
    };
  }
  if (isRecord(reason) && reason.type === "linear_api_status" && typeof reason.status === "number") {
    return {
      error: {
        message: `Linear GraphQL request failed with HTTP ${reason.status}.`,
        status: reason.status,
      },
    };
  }
  if (isRecord(reason) && reason.type === "linear_api_request") {
    return {
      error: {
        message: "Linear GraphQL request failed before receiving a successful response.",
        reason: String(reason.reason),
      },
    };
  }
  return {
    error: {
      message: "Linear GraphQL tool execution failed.",
      reason: String(reason),
    },
  };
}

function githubToolErrorPayload(reason: unknown): Record<string, unknown> {
  if (reason === "github_invalid_arguments") {
    return { error: { message: "`github_rest` expects an object with `method`, `path`, and optional `body`." } };
  }
  if (reason === "github_invalid_method") {
    return { error: { message: "`github_rest.method` must be one of GET, POST, PATCH, PUT, or DELETE." } };
  }
  if (reason === "github_invalid_path") {
    return { error: { message: "`github_rest.path` must start with `/` and must not contain protocol or host data." } };
  }
  if (reason === "missing_github_token") {
    return {
      error: {
        message: "Symphony is missing GitHub auth. Set `tracker.api_key` in `WORKFLOW.md` or export `GITHUB_TOKEN`.",
      },
    };
  }
  if (reason === "missing_github_repository") {
    return {
      error: {
        message: "Symphony is missing GitHub repository. Set `tracker.project_slug` to `owner/repo` in `WORKFLOW.md`.",
      },
    };
  }
  if (isRecord(reason) && reason.type === "github_api_request") {
    return {
      error: {
        message: "GitHub REST request failed before receiving a successful response.",
        reason: String(reason.reason),
      },
    };
  }
  return {
    error: {
      message: "GitHub REST tool execution failed.",
      reason: String(reason),
    },
  };
}

async function defaultLinearClient(
  query: string,
  variables: Record<string, unknown>,
): Promise<Result<Record<string, unknown>, unknown>> {
  return linearGraphql(query, variables);
}

async function defaultGitHubClient(
  method: GitHubRestMethod,
  path: string,
  body: unknown,
): Promise<Result<{ status: number; body: unknown; headers?: Record<string, string> }, unknown>> {
  const config = await settings();
  if (config.tracker.api_key === null) return err("missing_github_token");
  if (config.tracker.project_slug === null) return err("missing_github_repository");
  const [owner, repo, ...rest] = config.tracker.project_slug.split("/");
  if (!owner || !repo || rest.length > 0) return err("missing_github_repository");

  try {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${config.tracker.api_key}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    };
    if (method !== "GET" && body !== null) init.body = JSON.stringify(body);

    const response = await fetch(
      `${config.tracker.endpoint.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`,
      init,
    );
    const responseBody = await response.json().catch(() => ({}));
    return ok({ status: response.status, body: responseBody, headers: Object.fromEntries(response.headers.entries()) });
  } catch (error) {
    return err({ type: "github_api_request", reason: error instanceof Error ? error.message : String(error) });
  }
}

function normalizeGitHubMethod(value: unknown): GitHubRestMethod | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return isGitHubRestMethod(normalized) ? normalized : null;
}

function isGitHubRestMethod(value: string): value is GitHubRestMethod {
  return ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(value);
}

function validGitHubPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphqlErrors(response: Record<string, unknown>): unknown {
  if (Array.isArray(response.errors)) return response.errors;
  for (const symbol of Object.getOwnPropertySymbols(response)) {
    if (symbol.description === "errors") return response[symbol as unknown as keyof typeof response];
  }
  return undefined;
}
