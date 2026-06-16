import { describe, expect, test } from "bun:test";
import { createObservabilityHandler, startObservabilityServer } from "../src/observability-api";
import type { OrchestratorSnapshot } from "../src/orchestrator";

describe("observability API", () => {
  test("preserves state, issue, and refresh responses", async () => {
    const snapshot = staticSnapshot();
    const handler = createObservabilityHandler({
      snapshot: async () => snapshot,
      refresh: async () => ({
        queued: true,
        coalesced: false,
        requestedAt: new Date("2026-02-15T21:36:38.000Z"),
        operations: ["poll", "reconcile"],
      }),
      now: () => new Date("2026-02-15T21:36:39.000Z"),
      workspaceRoot: "/tmp/symphony_workspaces",
    });

    const state = await json(handler, "GET", "/api/v1/state", 200);
    expect(state).toEqual({
      generated_at: "2026-02-15T21:36:39.000Z",
      counts: { running: 1, retrying: 1, blocked: 1 },
      running: [
        {
          issue_id: "issue-http",
          issue_identifier: "MT-HTTP",
          issue_url: "https://example.org/issues/MT-HTTP",
          state: "In Progress",
          worker_host: null,
          workspace_path: null,
          session_id: "thread-http",
          turn_count: 7,
          last_event: "notification",
          last_message: "rendered",
          started_at: "2026-02-15T21:35:00.000Z",
          last_event_at: null,
          tokens: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
        },
      ],
      retrying: [
        {
          issue_id: "issue-retry",
          issue_identifier: "MT-RETRY",
          issue_url: "https://example.org/issues/MT-RETRY",
          attempt: 2,
          due_at: "2026-02-15T21:37:09.000Z",
          error: "boom",
          worker_host: null,
          workspace_path: null,
        },
      ],
      blocked: [
        {
          issue_id: "issue-blocked",
          issue_identifier: "MT-BLOCKED",
          issue_url: "https://example.org/issues/MT-BLOCKED",
          state: "In Progress",
          error: "codex turn requires operator input",
          worker_host: "dm-dev2",
          workspace_path: "/workspaces/MT-BLOCKED",
          session_id: "thread-blocked",
          blocked_at: "2026-02-15T21:35:30.000Z",
          last_event: "turn_input_required",
          last_message: "turn blocked: waiting for user input",
          last_event_at: "2026-02-15T21:35:45.000Z",
        },
      ],
      codex_totals: { input_tokens: 4, output_tokens: 8, total_tokens: 12, seconds_running: 42.5 },
      rate_limits: { primary: { remaining: 11 } },
    });

    expect(await json(handler, "GET", "/api/v1/MT-HTTP", 200)).toMatchObject({
      issue_identifier: "MT-HTTP",
      issue_id: "issue-http",
      status: "running",
      workspace: { path: "/tmp/symphony_workspaces/MT-HTTP", host: null },
      attempts: { restart_count: 0, current_retry_attempt: 0 },
      running: {
        session_id: "thread-http",
        turn_count: 7,
        state: "In Progress",
        tokens: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
      },
      retry: null,
      blocked: null,
      logs: { codex_session_logs: [] },
      recent_events: [],
      last_error: null,
      tracked: {},
    });

    expect(await json(handler, "GET", "/api/v1/MT-RETRY", 200)).toMatchObject({
      status: "retrying",
      retry: { attempt: 2, error: "boom" },
    });

    expect(await json(handler, "GET", "/api/v1/MT-BLOCKED", 200)).toMatchObject({
      status: "blocked",
      workspace: { path: "/workspaces/MT-BLOCKED", host: "dm-dev2" },
      last_error: "codex turn requires operator input",
      blocked: { session_id: "thread-blocked", state: "In Progress" },
      recent_events: [
        {
          at: "2026-02-15T21:35:45.000Z",
          event: "turn_input_required",
          message: "turn blocked: waiting for user input",
        },
      ],
    });

    expect(await json(handler, "GET", "/api/v1/MT-MISSING", 404)).toEqual({
      error: { code: "issue_not_found", message: "Issue not found" },
    });

    expect(await json(handler, "POST", "/api/v1/refresh", 202)).toEqual({
      queued: true,
      coalesced: false,
      requested_at: "2026-02-15T21:36:38.000Z",
      operations: ["poll", "reconcile"],
    });
  });

  test("preserves method, route, unavailable, and timeout behavior", async () => {
    const unavailable = createObservabilityHandler({
      snapshot: async () => null,
      now: () => new Date("2026-02-15T21:36:39.000Z"),
    });

    expect(await json(unavailable, "POST", "/api/v1/state", 405)).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
    expect(await json(unavailable, "GET", "/api/v1/refresh", 405)).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
    expect(await json(unavailable, "GET", "/unknown", 404)).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
    expect(await json(unavailable, "GET", "/api/v1/state", 200)).toEqual({
      generated_at: "2026-02-15T21:36:39.000Z",
      error: { code: "snapshot_unavailable", message: "Snapshot unavailable" },
    });
    expect(await json(unavailable, "POST", "/api/v1/refresh", 503)).toEqual({
      error: { code: "orchestrator_unavailable", message: "Orchestrator is unavailable" },
    });

    const timeout = createObservabilityHandler({
      snapshot: async () => "timeout",
      now: () => new Date("2026-02-15T21:36:39.000Z"),
    });
    expect(await json(timeout, "GET", "/api/v1/state", 200)).toEqual({
      generated_at: "2026-02-15T21:36:39.000Z",
      error: { code: "snapshot_timeout", message: "Snapshot timed out" },
    });
  });

  test("starts a Bun server, accepts form posts, and rejects invalid hosts", async () => {
    expect(
      await startObservabilityServer({
        host: "127.0.0.1",
        port: null,
        snapshot: async () => staticSnapshot(),
      }),
    ).toEqual({ ok: true, value: null });

    const started = await startObservabilityServer({
      host: "127.0.0.1",
      port: 0,
      snapshot: async () => staticSnapshot(),
      refresh: async () => ({ queued: true, coalesced: false, operations: ["poll"] }),
      now: () => new Date("2026-02-15T21:36:39.000Z"),
      workspaceRoot: "/tmp/symphony_workspaces",
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value === null) throw new Error("observability server did not start");

    try {
      const stateResponse = await fetch(new URL("/api/v1/state", started.value.url));
      expect(stateResponse.status).toBe(200);
      expect((await stateResponse.json()).counts).toEqual({ running: 1, retrying: 1, blocked: 1 });

      const refreshResponse = await fetch(new URL("/api/v1/refresh", started.value.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(refreshResponse.status).toBe(202);
      expect((await refreshResponse.json()).queued).toBe(true);
    } finally {
      started.value.stop(true);
    }

    expect(
      await startObservabilityServer({
        host: "bad host",
        port: 0,
        snapshot: async () => staticSnapshot(),
      }),
    ).toEqual({ ok: false, error: { type: "invalid_observability_host", host: "bad host" } });
  });

  test("serves the dashboard shell and embedded static assets", async () => {
    const handler = createObservabilityHandler({
      snapshot: async () => staticSnapshot(),
      now: () => new Date("2026-02-15T21:36:39.000Z"),
      workspaceRoot: "/tmp/symphony_workspaces",
    });

    const dashboard = await text(handler, "GET", "/", 200);
    expect(dashboard.contentType).toContain("text/html");
    expect(dashboard.body).toContain("<title>Symphony</title>");
    expect(dashboard.body).toContain("/dashboard.css");
    expect(dashboard.body).toContain("/api/v1/state");
    expect(dashboard.body).toContain("Recent Work Log");
    expect(dashboard.body).toContain('id="running"');
    expect(dashboard.body).toContain('id="events"');
    expect(dashboard.body).toContain("Raw state JSON");

    const css = await text(handler, "GET", "/dashboard.css", 200);
    expect(css.contentType).toContain("text/css");
    expect(css.cacheControl).toBe("public, max-age=31536000");
    expect(css.body).toContain(".dashboard");
    expect(css.body).toContain(".summary-card");
    expect(css.body).toContain(".event-row");

    const favicon = await handler(new Request("http://localhost/favicon.png", { method: "GET" }));
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toContain("image/png");
    expect(favicon.headers.get("cache-control")).toBe("public, max-age=31536000");
    expect(new Uint8Array(await favicon.arrayBuffer()).slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});

async function json(
  handler: (request: Request) => Response | Promise<Response>,
  method: string,
  path: string,
  expectedStatus: number,
): Promise<unknown> {
  const response = await handler(new Request(`http://localhost${path}`, { method }));
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json();
}

async function text(
  handler: (request: Request) => Response | Promise<Response>,
  method: string,
  path: string,
  expectedStatus: number,
): Promise<{ body: string; contentType: string; cacheControl: string | null }> {
  const response = await handler(new Request(`http://localhost${path}`, { method }));
  expect(response.status).toBe(expectedStatus);
  return {
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
    cacheControl: response.headers.get("cache-control"),
  };
}

function staticSnapshot(): OrchestratorSnapshot {
  return {
    running: [
      {
        issueId: "issue-http",
        identifier: "MT-HTTP",
        issueUrl: "https://example.org/issues/MT-HTTP",
        state: "In Progress",
        workerHost: null,
        workspacePath: null,
        sessionId: "thread-http",
        turnCount: 7,
        lastCodexEvent: "notification",
        lastCodexMessage: "rendered",
        startedAt: new Date("2026-02-15T21:35:00.000Z"),
        lastCodexTimestamp: null,
        codexInputTokens: 4,
        codexOutputTokens: 8,
        codexTotalTokens: 12,
      },
    ],
    retrying: [
      {
        issueId: "issue-retry",
        identifier: "MT-RETRY",
        issueUrl: "https://example.org/issues/MT-RETRY",
        attempt: 2,
        dueInMs: 30_000,
        error: "boom",
        workerHost: null,
        workspacePath: null,
      },
    ],
    blocked: [
      {
        issueId: "issue-blocked",
        metadata: {
          identifier: "MT-BLOCKED",
          issue: {
            url: "https://example.org/issues/MT-BLOCKED",
            state: "In Progress",
          },
          error: "codex turn requires operator input",
          workerHost: "dm-dev2",
          workspacePath: "/workspaces/MT-BLOCKED",
          sessionId: "thread-blocked",
          blockedAt: new Date("2026-02-15T21:35:30.000Z"),
          lastCodexEvent: "turn_input_required",
          lastCodexMessage: "turn blocked: waiting for user input",
          lastCodexTimestamp: new Date("2026-02-15T21:35:45.000Z"),
        },
      },
    ],
    codexTotals: { inputTokens: 4, outputTokens: 8, totalTokens: 12, secondsRunning: 42.5 },
    rateLimits: { primary: { remaining: 11 } },
    polling: { checking: false, nextPollInMs: 1000, pollIntervalMs: 30_000 },
  };
}
