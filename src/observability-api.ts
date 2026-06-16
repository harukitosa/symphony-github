import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OrchestratorSnapshot } from "./orchestrator";
import { err, ok, type Result } from "./result";

export type SnapshotProvider = () => Promise<OrchestratorSnapshot | "timeout" | null>;
export type RefreshProvider = () => Promise<{
  queued: boolean;
  coalesced: boolean;
  requestedAt?: Date | string | null;
  operations?: string[];
}>;

export type ObservabilityHandlerOptions = {
  snapshot: SnapshotProvider;
  refresh?: RefreshProvider;
  now?: () => Date;
  workspaceRoot?: string;
};

export type ObservabilityServerOptions = ObservabilityHandlerOptions & {
  host?: string | null;
  port?: number | null;
};

export type ObservabilityServerError = {
  type: "invalid_observability_host";
  host: string;
};

export function createObservabilityHandler(options: ObservabilityHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const workspaceRoot = options.workspaceRoot ?? join(tmpdir(), "symphony_workspaces");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (path === "/") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Method not allowed");
      return htmlResponse(dashboardHtml());
    }

    const asset = staticAsset(path);
    if (asset !== null) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Method not allowed");
      return assetResponse(asset);
    }

    if (path === "/api/v1/state") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Method not allowed");
      const snapshot = await options.snapshot();
      return jsonResponse(statePayload(snapshot, now()));
    }

    if (path === "/api/v1/refresh") {
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Method not allowed");
      if (options.refresh === undefined) {
        return errorResponse(503, "orchestrator_unavailable", "Orchestrator is unavailable");
      }
      const refresh = await options.refresh();
      return jsonResponse(
        {
          queued: refresh.queued,
          coalesced: refresh.coalesced,
          requested_at: isoString(refresh.requestedAt),
          operations: refresh.operations ?? [],
        },
        202,
      );
    }

    const match = /^\/api\/v1\/([^/]+)$/.exec(path);
    if (match !== null) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Method not allowed");
      const snapshot = await options.snapshot();
      if (snapshot === null || snapshot === "timeout") {
        return errorResponse(404, "issue_not_found", "Issue not found");
      }
      const issue = issuePayload(snapshot, decodeURIComponent(match[1] ?? ""), workspaceRoot, now());
      return issue === null ? errorResponse(404, "issue_not_found", "Issue not found") : jsonResponse(issue);
    }

    if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Method not allowed");
    return errorResponse(404, "not_found", "Route not found");
  };
}

export async function startObservabilityServer(
  options: ObservabilityServerOptions,
): Promise<Result<Bun.Server<unknown> | null, ObservabilityServerError>> {
  if (options.port === null) return ok(null);

  const host = normalizeListenHost(options.host);
  if (host === null) return err({ type: "invalid_observability_host", host: options.host ?? "" });

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    fetch: createObservabilityHandler(options),
  });
  return ok(server);
}

function statePayload(snapshot: OrchestratorSnapshot | "timeout" | null, generatedAt: Date): Record<string, unknown> {
  if (snapshot === "timeout") {
    return {
      generated_at: generatedAt.toISOString(),
      error: { code: "snapshot_timeout", message: "Snapshot timed out" },
    };
  }
  if (snapshot === null) {
    return {
      generated_at: generatedAt.toISOString(),
      error: { code: "snapshot_unavailable", message: "Snapshot unavailable" },
    };
  }

  const running = snapshot.running.map(runningPayload);
  const retrying = snapshot.retrying.map((entry) => retryPayload(entry, generatedAt));
  const blocked = snapshot.blocked.map(blockedPayload);
  return {
    generated_at: generatedAt.toISOString(),
    counts: { running: running.length, retrying: retrying.length, blocked: blocked.length },
    running,
    retrying,
    blocked,
    codex_totals: tokenTotalsPayload(snapshot.codexTotals),
    rate_limits: snapshot.rateLimits ?? null,
  };
}

function issuePayload(
  snapshot: OrchestratorSnapshot,
  identifier: string,
  workspaceRoot: string,
  generatedAt: Date,
): Record<string, unknown> | null {
  const running = snapshot.running.find((entry) => stringValue(entry.identifier) === identifier);
  if (running !== undefined) {
    const runningJson = runningPayload(running);
    return baseIssuePayload(identifier, stringValue(running.issueId), workspaceRoot, runningJson.worker_host, "running", {
      workspace_path: runningJson.workspace_path,
      running: runningJson,
      retry: null,
      blocked: null,
      recent_events: recentEventsPayload(runningJson),
      last_error: null,
    });
  }

  const retry = snapshot.retrying.find((entry) => stringValue(entry.identifier) === identifier);
  if (retry !== undefined) {
    const retryJson = retryPayload(retry, generatedAt);
    return baseIssuePayload(identifier, stringValue(retry.issueId), workspaceRoot, retryJson.worker_host, "retrying", {
      workspace_path: retryJson.workspace_path,
      running: null,
      retry: retryJson,
      blocked: null,
      attempts: { restart_count: numberValue(retry.attempt), current_retry_attempt: numberValue(retry.attempt) },
      last_error: retryJson.error,
    });
  }

  const blocked = snapshot.blocked.find((entry) => blockedIdentifier(entry) === identifier);
  if (blocked !== undefined) {
    const blockedJson = blockedPayload(blocked);
    return baseIssuePayload(identifier, stringValue(blocked.issueId), workspaceRoot, blockedJson.worker_host, "blocked", {
      workspace_path: blockedJson.workspace_path,
      running: null,
      retry: null,
      blocked: blockedJson,
      recent_events: recentEventsPayload(blockedJson),
      last_error: blockedJson.error,
    });
  }

  return null;
}

function baseIssuePayload(
  identifier: string,
  issueId: string | null,
  workspaceRoot: string,
  workerHost: unknown,
  status: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const workspacePath = stringValue(overrides.workspace_path) ?? join(workspaceRoot, identifier);
  const { workspace_path: _workspacePath, ...restOverrides } = overrides;
  return {
    issue_identifier: identifier,
    issue_id: issueId,
    status,
    workspace: { path: workspacePath, host: workerHost ?? null },
    attempts: { restart_count: 0, current_retry_attempt: 0 },
    running: null,
    retry: null,
    blocked: null,
    logs: { codex_session_logs: [] },
    recent_events: [],
    last_error: null,
    tracked: {},
    ...restOverrides,
  };
}

function runningPayload(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    issue_id: stringValue(entry.issueId),
    issue_identifier: stringValue(entry.identifier),
    issue_url: stringValue(entry.issueUrl),
    state: stringValue(entry.state),
    worker_host: stringValue(entry.workerHost),
    workspace_path: stringValue(entry.workspacePath),
    session_id: stringValue(entry.sessionId),
    turn_count: numberValue(entry.turnCount),
    last_event: stringValue(entry.lastCodexEvent),
    last_message: messageValue(entry.lastCodexMessage),
    started_at: isoString(entry.startedAt),
    last_event_at: isoString(entry.lastCodexTimestamp),
    tokens: {
      input_tokens: numberValue(entry.codexInputTokens),
      output_tokens: numberValue(entry.codexOutputTokens),
      total_tokens: numberValue(entry.codexTotalTokens),
    },
  };
}

function retryPayload(entry: Record<string, unknown>, generatedAt: Date): Record<string, unknown> {
  return {
    issue_id: stringValue(entry.issueId),
    issue_identifier: stringValue(entry.identifier),
    issue_url: stringValue(entry.issueUrl),
    attempt: numberValue(entry.attempt),
    due_at: new Date(generatedAt.getTime() + numberValue(entry.dueInMs)).toISOString(),
    error: stringValue(entry.error),
    worker_host: stringValue(entry.workerHost),
    workspace_path: stringValue(entry.workspacePath),
  };
}

function blockedPayload(entry: Record<string, unknown>): Record<string, unknown> {
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const issue = isRecord(metadata.issue) ? metadata.issue : {};
  return {
    issue_id: stringValue(entry.issueId),
    issue_identifier: stringValue(metadata.identifier),
    issue_url: stringValue(issue.url),
    state: stringValue(issue.state),
    error: stringValue(metadata.error),
    worker_host: stringValue(metadata.workerHost),
    workspace_path: stringValue(metadata.workspacePath),
    session_id: stringValue(metadata.sessionId),
    blocked_at: isoString(metadata.blockedAt),
    last_event: stringValue(metadata.lastCodexEvent),
    last_message: messageValue(metadata.lastCodexMessage),
    last_event_at: isoString(metadata.lastCodexTimestamp),
  };
}

function blockedIdentifier(entry: Record<string, unknown>): string | null {
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  return stringValue(metadata.identifier);
}

function tokenTotalsPayload(value: unknown): Record<string, number> {
  const totals = isRecord(value) ? value : {};
  return {
    input_tokens: numberValue(totals.inputTokens),
    output_tokens: numberValue(totals.outputTokens),
    total_tokens: numberValue(totals.totalTokens),
    seconds_running: numberValue(totals.secondsRunning),
  };
}

function recentEventsPayload(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  const at = stringValue(entry.last_event_at);
  if (at === null) return [];
  return [{ at, event: stringValue(entry.last_event), message: entry.last_message ?? null }];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function assetResponse(asset: { contentType: string; body: string | Uint8Array }): Response {
  const body = typeof asset.body === "string" ? asset.body : arrayBufferCopy(asset.body);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000",
    },
  });
}

function arrayBufferCopy(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony</title>
  <link rel="icon" href="/favicon.png">
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <main class="dashboard" data-state-url="/api/v1/state">
    <header class="dashboard__header">
      <h1>Symphony</h1>
      <form method="post" action="/api/v1/refresh">
        <button type="submit">Refresh</button>
      </form>
    </header>
    <section class="dashboard__panel">
      <h2>Runtime State</h2>
      <pre id="state">Loading /api/v1/state</pre>
    </section>
  </main>
  <script>
    fetch("/api/v1/state").then((response) => response.json()).then((state) => {
      document.getElementById("state").textContent = JSON.stringify(state, null, 2);
    }).catch((error) => {
      document.getElementById("state").textContent = String(error);
    });
  </script>
</body>
</html>`;
}

function staticAsset(path: string): { contentType: string; body: string | Uint8Array } | null {
  if (path === "/dashboard.css") return { contentType: "text/css; charset=utf-8", body: DASHBOARD_CSS };
  if (path === "/favicon.png") return { contentType: "image/png", body: FAVICON_PNG };
  return null;
}

const DASHBOARD_CSS = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #111318;
  color: #f4f7fb;
}

body {
  margin: 0;
}

.dashboard {
  min-height: 100vh;
  padding: 24px;
}

.dashboard__header {
  align-items: center;
  border-bottom: 1px solid #303642;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  margin-bottom: 24px;
  padding-bottom: 16px;
}

.dashboard__header h1 {
  font-size: 24px;
  margin: 0;
}

.dashboard__header button {
  background: #f4f7fb;
  border: 0;
  border-radius: 6px;
  color: #111318;
  cursor: pointer;
  font: inherit;
  padding: 8px 12px;
}

.dashboard__panel {
  max-width: 1120px;
}

.dashboard__panel h2 {
  font-size: 16px;
  margin: 0 0 12px;
}

.dashboard__panel pre {
  background: #191d25;
  border: 1px solid #303642;
  border-radius: 8px;
  overflow: auto;
  padding: 16px;
}`;

const FAVICON_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
  0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function normalizeListenHost(host: string | null | undefined): string | null {
  const value = host == null || host.trim() === "" ? "127.0.0.1" : host.trim();
  if (/\s/.test(value)) return null;
  if (value === "localhost") return value;

  try {
    new URL(`http://${value.includes(":") && !value.startsWith("[") ? `[${value}]` : value}/`);
    return value;
  } catch {
    return null;
  }
}

function isoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
