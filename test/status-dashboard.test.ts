import { describe, expect, test } from "bun:test";
import {
  dashboardUrl,
  formatDashboardHeader,
  formatRetrySummary,
  formatRunningSummary,
  formatTimestamp,
  formatTps,
  humanizeCodexMessage,
  rollingTps,
  throttledTps,
  tpsGraph,
} from "../src/status-dashboard";

describe("status dashboard formatting", () => {
  test("rollingTps calculates a windowed token throughput and is throttling-friendly", () => {
    const nowMs = 10_000;
    expect(rollingTps([], nowMs, 100)).toBe(0);
    expect(rollingTps([[9_000, 50]], nowMs, 100)).toBe(50);
    expect(rollingTps([[9_000, 150]], nowMs, 100)).toBe(0);
  });

  test("formatTps uses compact readable units", () => {
    expect(formatTps(0)).toBe("0");
    expect(formatTps(12.345)).toBe("12");
    expect(formatTps(1234.56)).toBe("1,234");
  });

  test("throttledTps keeps the same value within a second", () => {
    const [firstSecond, firstTps] = throttledTps(null, null, 10_000, [[9_000, 20]], 40);
    const [sameSecond, sameTps] = throttledTps(firstSecond, firstTps, 10_500, [[9_000, 20]], 200);
    const [nextSecond, nextTps] = throttledTps(sameSecond, sameTps, 11_000, [[10_500, 200]], 260);

    expect(sameSecond).toBe(firstSecond);
    expect(sameTps).toBe(firstTps);
    expect(nextSecond).toBe(11);
    expect(nextTps).not.toBe(sameTps);
  });

  test("formatTimestamp truncates dates to second precision", () => {
    expect(formatTimestamp(new Date("2026-02-15T21:36:38.987Z"))).toBe("2026-02-15 21:36:38Z");
  });

  test("tpsGraph renders 10-minute throughput snapshots", () => {
    const steadySamples: Array<[number, number]> = [];
    for (let timestamp = 575_000; timestamp >= 0; timestamp -= 25_000) {
      steadySamples.push([timestamp, Math.trunc(timestamp / 100)]);
    }
    expect(tpsGraph(steadySamples, 600_000, 6_000)).toBe("████████████████████████");

    const [currentTokens, samples] = graphSamplesFromRates(Array.from({ length: 24 }, (_, index) => (index + 1) * 2));
    expect(tpsGraph(samples, 600_000, currentTokens)).toBe("▁▂▂▂▃▃▃▃▄▄▄▅▅▅▆▆▆▆▇▇▇██▅");
  });

  test("tpsGraph keeps historical bars stable within the active bucket", () => {
    const nowMs = 600_000;
    const currentTokens = 74_400;
    const samples = graphSamplesForStabilityTest(nowMs);

    const graphAtNow = tpsGraph(samples, nowMs, currentTokens);
    const graphNextSecond = tpsGraph(samples, nowMs + 1_000, currentTokens + 120);

    const historicalChanges = [...graphAtNow]
      .slice(0, 23)
      .filter((char, index) => char !== [...graphNextSecond][index]).length;

    expect(historicalChanges).toBe(0);
  });

  test("dashboardUrl normalizes wildcard and IPv6 hosts", () => {
    expect(dashboardUrl("0.0.0.0", 4000, null)).toBe("http://127.0.0.1:4000/");
    expect(dashboardUrl("::", 4000, null)).toBe("http://127.0.0.1:4000/");
    expect(dashboardUrl("2001:db8::1", 4000, null)).toBe("http://[2001:db8::1]:4000/");
    expect(dashboardUrl("localhost", 4000, 4100)).toBe("http://localhost:4100/");
    expect(dashboardUrl("localhost", null, null)).toBeNull();
  });

  test("dashboard header renders Linear project and optional dashboard URL", () => {
    expect(formatDashboardHeader({ projectSlug: "project", dashboardUrl: null })).toEqual([
      "│ Project: https://linear.app/project/project/issues",
    ]);

    expect(formatDashboardHeader({ projectSlug: "project", dashboardUrl: "http://127.0.0.1:4000/" })).toEqual([
      "│ Project: https://linear.app/project/project/issues",
      "│ Dashboard: http://127.0.0.1:4000/",
    ]);
  });

  test("dashboard header renders GitHub repository issue URL", () => {
    expect(formatDashboardHeader({ trackerKind: "github", projectSlug: "openai/symphony-ts", dashboardUrl: null })).toEqual([
      "│ Project: https://github.com/openai/symphony-ts/issues",
    ]);

    expect(formatDashboardHeader({ trackerKind: "github", projectSlug: "openai/symphony-ts", dashboardUrl: "http://127.0.0.1:4000/" })).toEqual([
      "│ Project: https://github.com/openai/symphony-ts/issues",
      "│ Dashboard: http://127.0.0.1:4000/",
    ]);
  });

  test("backoff queue row sanitizes escaped and literal newlines", () => {
    const escaped = formatRetrySummary({
      issueId: "issue-1",
      identifier: "MT-980",
      attempt: 1,
      dueInMs: 1_500,
      error: "error with \\nnewline",
    });
    expect(escaped).toContain("MT-980");
    expect(escaped).toContain("error=error with newline");
    expect(escaped).not.toContain("\\n");

    const literal = formatRetrySummary({
      issueId: "issue-2",
      identifier: "MT-981",
      attempt: 2,
      dueInMs: 2_250,
      error: "worker crashed\nrestarting cleanly",
    });
    expect(literal).toContain("error=worker crashed restarting cleanly");
  });

  test("running summary compacts session id and summarizes common codex messages", () => {
    const line = formatRunningSummary(
      {
        identifier: "MT-102",
        state: "In Progress",
        sessionId: "thread-abcdef1234567890-turn-1234567890",
        codexAppServerPid: "5252",
        codexTotalTokens: 89_200,
        runtimeSeconds: 412,
        turnCount: 4,
        lastCodexEvent: "codex/event/exec_command_begin",
        lastCodexMessage: {
          event: "notification",
          message: {
            method: "codex/event/exec_command_begin",
            params: { msg: { command: "mix test --cover" } },
          },
        },
      },
      115,
    );

    expect(line).toContain("MT-102");
    expect(line).toContain("5252");
    expect(line).toContain("6m 52s / 4");
    expect(line).toContain("89,200");
    expect(line).toContain("thre...567890");
    expect(line).toContain("mix test --cover");
  });

  test("humanizes common codex app-server events", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["turn/started", { params: { turn: { id: "turn-1" } } }, "turn started"],
      ["turn/completed", { params: { turn: { status: "completed" } } }, "turn completed"],
      ["turn/diff/updated", { params: { diff: "line1\nline2" } }, "turn diff updated"],
      ["turn/plan/updated", { params: { plan: [{ step: "a" }, { step: "b" }] } }, "plan updated"],
      [
        "thread/tokenUsage/updated",
        { params: { usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } },
        "thread token usage updated",
      ],
      [
        "item/started",
        { params: { item: { id: "item-1234567890abcdef", type: "commandExecution", status: "running" } } },
        "item started: command execution",
      ],
      [
        "item/completed",
        { params: { item: { type: "fileChange", status: "completed" } } },
        "item completed: file change",
      ],
      ["item/agentMessage/delta", { params: { delta: "hello" } }, "agent message streaming"],
      ["item/plan/delta", { params: { delta: "step" } }, "plan streaming"],
      ["item/reasoning/summaryTextDelta", { params: { summaryText: "thinking" } }, "reasoning summary streaming"],
      ["item/reasoning/summaryPartAdded", { params: { summaryText: "section" } }, "reasoning summary section added"],
      ["item/reasoning/textDelta", { params: { textDelta: "reason" } }, "reasoning text streaming"],
      ["item/commandExecution/outputDelta", { params: { outputDelta: "ok" } }, "command output streaming"],
      ["item/fileChange/outputDelta", { params: { outputDelta: "changed" } }, "file change output streaming"],
      [
        "item/commandExecution/requestApproval",
        { params: { parsedCmd: "git status" } },
        "command approval requested (git status)",
      ],
      ["item/fileChange/requestApproval", { params: { fileChangeCount: 2 } }, "file change approval requested (2 files)"],
      ["item/tool/call", { params: { tool: "linear_graphql" } }, "dynamic tool call requested (linear_graphql)"],
      ["item/tool/requestUserInput", { params: { question: "Continue?" } }, "tool requires user input: Continue?"],
    ];

    for (const [method, payload, expected] of cases) {
      expect(humanizeCodexMessage({ event: "notification", message: { ...payload, method } })).toContain(expected);
    }
  });

  test("humanizes wrapped codex and dynamic tool events", () => {
    expect(
      humanizeCodexMessage({
        event: "notification",
        message: {
          payload: {
            method: "turn/completed",
            params: {
              turn: { status: "completed" },
              usage: { input_tokens: "10", output_tokens: 2, total_tokens: 12 },
            },
          },
          raw: "{\"method\":\"turn/completed\"}",
        },
      }),
    ).toContain("turn completed (completed) (in 10, out 2, total 12)");

    expect(
      humanizeCodexMessage({
        event: "tool_call_completed",
        message: { payload: { method: "item/tool/call", params: { name: "linear_graphql" } } },
      }),
    ).toContain("dynamic tool call completed (linear_graphql)");

    expect(
      humanizeCodexMessage({
        event: "approval_auto_approved",
        message: {
          payload: { method: "item/commandExecution/requestApproval", params: { parsedCmd: "mix test" } },
          decision: "acceptForSession",
        },
      }),
    ).toContain("auto-approved");
  });

  test("enriches wrapper reasoning and streaming events with payload context", () => {
    expect(
      humanizeCodexMessage({
        event: "notification",
        message: {
          method: "codex/event/agent_reasoning",
          params: { msg: { payload: { summaryText: "compare retry paths for Linear polling" } } },
        },
      }),
    ).toBe("reasoning update: compare retry paths for Linear polling");

    expect(
      humanizeCodexMessage({
        event: "notification",
        message: {
          method: "codex/event/agent_message_delta",
          params: { msg: { payload: { delta: "writing workpad reconciliation update" } } },
        },
      }),
    ).toBe("agent message streaming: writing workpad reconciliation update");

    expect(
      humanizeCodexMessage({
        event: "notification",
        message: { method: "codex/event/agent_reasoning", params: { msg: { payload: {} } } },
      }),
    ).toBe("reasoning update");
  });
});

function graphSamplesFromRates(ratesPerBucket: number[]): [number, Array<[number, number]>] {
  const bucketMs = 25_000;
  let timestamp = 0;
  let tokens = 0;
  const samples: Array<[number, number]> = [];

  for (const rate of ratesPerBucket) {
    const nextTimestamp = timestamp + bucketMs;
    const nextTokens = tokens + Math.trunc((rate * bucketMs) / 1000);
    samples.unshift([timestamp, tokens]);
    timestamp = nextTimestamp;
    tokens = nextTokens;
  }

  return [tokens, [[timestamp, tokens], ...samples]];
}

function graphSamplesForStabilityTest(nowMs: number): Array<[number, number]> {
  const ratesPerBucket = Array.from({ length: 24 }, (_, index) => (index + 1) * 5);
  const bucketMs = 25_000;
  let tokens = 0;
  const samples: Array<[number, number]> = [];

  for (let timestamp = 0; timestamp <= nowMs - 1_000; timestamp += 1_000) {
    const bucketIndex = Math.min(Math.trunc(Math.max(timestamp, 0) / bucketMs), 23);
    tokens += ratesPerBucket[bucketIndex] ?? 0;
    samples.unshift([timestamp, tokens]);
  }

  return samples;
}
