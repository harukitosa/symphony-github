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
      <div>
        <h1>Symphony</h1>
        <p id="generated-at">Loading runtime state</p>
      </div>
      <form method="post" action="/api/v1/refresh">
        <button type="submit">Refresh</button>
      </form>
    </header>
    <section class="dashboard__summary" id="summary" aria-label="Runtime counts"></section>
    <section class="dashboard__grid">
      <article class="dashboard__panel">
        <h2>Running</h2>
        <div id="running" class="issue-list" role="status" aria-live="polite">Loading</div>
      </article>
      <article class="dashboard__panel">
        <h2>Retrying</h2>
        <div id="retrying" class="issue-list">Loading</div>
      </article>
      <article class="dashboard__panel">
        <h2>Blocked</h2>
        <div id="blocked" class="issue-list">Loading</div>
      </article>
    </section>
    <section class="dashboard__panel dashboard__panel--wide">
      <h2>Recent Work Log</h2>
      <div id="events" class="event-list">Loading</div>
    </section>
    <section class="dashboard__panel dashboard__panel--wide">
      <details>
        <summary>Raw state JSON</summary>
        <pre id="state">Loading /api/v1/state</pre>
      </details>
    </section>
  </main>
  <script>
    const stateUrl = document.querySelector('.dashboard').dataset.stateUrl;
    const text = (value, fallback = 'n/a') => value === null || value === undefined || value === '' ? fallback : String(value);
    const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    const fmt = new Intl.NumberFormat('en-US');
    const time = (value) => {
      if (!value) return 'n/a';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    };
    const escapeHtml = (value) => text(value, '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
    const messageText = (value) => {
      if (value === null || value === undefined || value === '') return 'No event yet';
      if (typeof value === 'string') return value;
      try {
        const method = value.method || value.event || value.type;
        const nested = value.message && (value.message.method || value.message.event || value.message.type);
        return nested || method || JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const issueLink = (entry) => {
      const label = escapeHtml(entry.issue_identifier || entry.issue_id || 'unknown');
      return entry.issue_url ? '<a href="' + escapeHtml(entry.issue_url) + '">' + label + '</a>' : label;
    };
    const empty = (label) => '<div class="empty-state">No ' + label + ' issues</div>';
    const tokenText = (tokens) => {
      const total = number(tokens && tokens.total_tokens);
      const input = number(tokens && tokens.input_tokens);
      const output = number(tokens && tokens.output_tokens);
      return fmt.format(total) + ' total, ' + fmt.format(input) + ' in, ' + fmt.format(output) + ' out';
    };
    const renderIssueRows = (entries, kind) => {
      if (!Array.isArray(entries) || entries.length === 0) return empty(kind);
      return entries.map((entry) => {
        const meta = kind === 'retrying'
          ? 'attempt ' + text(entry.attempt, '0') + ' / due ' + time(entry.due_at)
          : text(entry.state, kind);
        const detail = kind === 'running'
          ? tokenText(entry.tokens)
          : text(entry.error || entry.last_message, 'No error');
        return '<article class="issue-row issue-row--' + kind + '">' +
          '<div class="issue-row__main">' +
            '<strong>' + issueLink(entry) + '</strong>' +
            '<span>' + escapeHtml(meta) + '</span>' +
          '</div>' +
          '<p>' + escapeHtml(detail) + '</p>' +
        '</article>';
      }).join('');
    };
    const renderEvents = (state) => {
      const rows = []
        .concat((state.running || []).map((entry) => ({ kind: 'running', at: entry.last_event_at || entry.started_at, entry })))
        .concat((state.blocked || []).map((entry) => ({ kind: 'blocked', at: entry.last_event_at || entry.blocked_at, entry })))
        .concat((state.retrying || []).map((entry) => ({ kind: 'retrying', at: entry.due_at, entry })))
        .filter((row) => row.at || row.entry.last_message || row.entry.error)
        .sort((left, right) => new Date(right.at || 0).getTime() - new Date(left.at || 0).getTime())
        .slice(0, 12);
      if (rows.length === 0) return '<div class="empty-state">No work log events yet</div>';
      return rows.map((row) => {
        const entry = row.entry;
        const message = entry.error || messageText(entry.last_message || entry.last_event);
        return '<article class="event-row">' +
          '<time>' + escapeHtml(time(row.at)) + '</time>' +
          '<strong>' + issueLink(entry) + '</strong>' +
          '<span class="badge badge--' + row.kind + '">' + row.kind + '</span>' +
          '<p>' + escapeHtml(message) + '</p>' +
        '</article>';
      }).join('');
    };
    const render = (state) => {
      document.getElementById('state').textContent = JSON.stringify(state, null, 2);
      if (state.error) {
        document.getElementById('generated-at').textContent = text(state.error.message, 'Snapshot unavailable');
        document.getElementById('summary').innerHTML = '';
        document.getElementById('running').innerHTML = '<div class="empty-state empty-state--error">' + escapeHtml(state.error.message) + '</div>';
        document.getElementById('retrying').innerHTML = empty('retrying');
        document.getElementById('blocked').innerHTML = empty('blocked');
        document.getElementById('events').innerHTML = empty('work log');
        return;
      }
      const counts = state.counts || {};
      const totals = state.codex_totals || {};
      document.getElementById('generated-at').textContent = 'Updated ' + time(state.generated_at);
      document.getElementById('summary').innerHTML = [
        ['Running', counts.running, 'active workers'],
        ['Retrying', counts.retrying, 'waiting for retry'],
        ['Blocked', counts.blocked, 'needs attention'],
        ['Tokens', totals.total_tokens, 'total codex usage']
      ].map(([label, value, helper]) =>
        '<article class="summary-card"><span>' + label + '</span><strong>' + fmt.format(number(value)) + '</strong><small>' + helper + '</small></article>'
      ).join('');
      document.getElementById('running').innerHTML = renderIssueRows(state.running, 'running');
      document.getElementById('retrying').innerHTML = renderIssueRows(state.retrying, 'retrying');
      document.getElementById('blocked').innerHTML = renderIssueRows(state.blocked, 'blocked');
      document.getElementById('events').innerHTML = renderEvents(state);
    };
    fetch(stateUrl).then((response) => response.json()).then(render).catch((error) => {
      document.getElementById('generated-at').textContent = 'Failed to load runtime state';
      document.getElementById('state').textContent = String(error);
      document.getElementById('running').innerHTML = '<div class="empty-state empty-state--error">' + escapeHtml(error) + '</div>';
      document.getElementById('retrying').innerHTML = empty('retrying');
      document.getElementById('blocked').innerHTML = empty('blocked');
      document.getElementById('events').innerHTML = empty('work log');
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
  background: #101214;
  color: #eef2f3;
}

body {
  margin: 0;
}

a {
  color: inherit;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
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

.dashboard__header p {
  color: #9ea7ad;
  font-size: 13px;
  margin: 4px 0 0;
}

.dashboard__header button {
  background: #eef2f3;
  border: 0;
  border-radius: 6px;
  color: #101214;
  cursor: pointer;
  font: inherit;
  padding: 8px 12px;
}

.dashboard__summary {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 16px;
  max-width: 1280px;
}

.summary-card,
.dashboard__panel {
  background: #171a1f;
  border: 1px solid #30343a;
  border-radius: 8px;
}

.summary-card {
  padding: 14px;
}

.summary-card span,
.summary-card small {
  color: #9ea7ad;
  display: block;
  font-size: 12px;
}

.summary-card strong {
  display: block;
  font-size: 26px;
  margin: 6px 0 2px;
}

.dashboard__grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  max-width: 1280px;
}

.dashboard__panel {
  min-width: 0;
  padding: 16px;
}

.dashboard__panel--wide {
  margin-top: 16px;
  max-width: 1280px;
}

.dashboard__panel h2 {
  font-size: 16px;
  margin: 0 0 12px;
}

.issue-list,
.event-list {
  display: grid;
  gap: 10px;
}

.issue-row,
.event-row,
.empty-state {
  background: #111417;
  border: 1px solid #303642;
  border-radius: 6px;
  padding: 12px;
}

.issue-row {
  border-left: 3px solid #77808a;
}

.issue-row--running {
  border-left-color: #66c2a5;
}

.issue-row--retrying {
  border-left-color: #e6b450;
}

.issue-row--blocked {
  border-left-color: #ef6f6c;
}

.issue-row__main,
.event-row {
  align-items: center;
  display: grid;
  gap: 8px;
}

.issue-row__main {
  grid-template-columns: minmax(0, 1fr) auto;
}

.issue-row strong,
.event-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-row span,
.event-row time {
  color: #9ea7ad;
  font-size: 12px;
}

.issue-row p,
.event-row p {
  color: #cbd2d6;
  font-size: 13px;
  line-height: 1.45;
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}

.event-row {
  grid-template-columns: 180px minmax(88px, auto) auto minmax(0, 1fr);
}

.event-row p {
  margin: 0;
}

.badge {
  border-radius: 999px;
  border: 1px solid #424850;
  color: #cbd2d6;
  font-size: 12px;
  padding: 2px 8px;
}

.badge--running {
  border-color: #487c6e;
  color: #9bd8c3;
}

.badge--retrying {
  border-color: #8a6b24;
  color: #f1c66d;
}

.badge--blocked {
  border-color: #914544;
  color: #ffaaa8;
}

.empty-state {
  color: #9ea7ad;
}

.empty-state--error {
  color: #ffaaa8;
}

details summary {
  color: #cbd2d6;
  cursor: pointer;
  font-size: 13px;
}

details pre {
  background: #111417;
  border: 1px solid #303642;
  border-radius: 6px;
  overflow: auto;
  padding: 16px;
}

@media (max-width: 900px) {
  .dashboard {
    padding: 16px;
  }

  .dashboard__summary,
  .dashboard__grid {
    grid-template-columns: 1fr;
  }

  .event-row {
    align-items: start;
    grid-template-columns: 1fr auto;
  }

  .event-row p {
    grid-column: 1 / -1;
  }
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
