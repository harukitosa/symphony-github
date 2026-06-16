const RUNNING_ID_WIDTH = 8;
const RUNNING_STAGE_WIDTH = 14;
const RUNNING_PID_WIDTH = 8;
const RUNNING_AGE_WIDTH = 12;
const RUNNING_TOKENS_WIDTH = 10;
const RUNNING_SESSION_WIDTH = 14;
const RUNNING_ROW_CHROME_WIDTH = 10;
const RUNNING_EVENT_MIN_WIDTH = 12;
const THROUGHPUT_WINDOW_MS = 5_000;
const THROUGHPUT_GRAPH_WINDOW_MS = 10 * 60 * 1000;
const THROUGHPUT_GRAPH_COLUMNS = 24;
const SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export type RetrySummary = {
  issueId?: string;
  identifier?: string;
  attempt?: number;
  dueInMs?: number;
  error?: string | null;
};

export type RunningSummary = {
  identifier?: string;
  state?: string;
  sessionId?: string | null;
  codexAppServerPid?: string | null;
  codexTotalTokens?: number;
  runtimeSeconds?: number;
  turnCount?: number;
  lastCodexEvent?: string | null;
  lastCodexMessage?: unknown;
};

export type DashboardHeader = {
  trackerKind?: string | null;
  projectSlug?: string | null;
  dashboardUrl?: string | null;
};

export function rollingTps(samples: Array<[number, number]>, nowMs: number, currentTokens: number): number {
  const pruned = [[nowMs, currentTokens] as [number, number], ...samples].filter(
    ([timestamp]) => timestamp >= nowMs - THROUGHPUT_WINDOW_MS,
  );
  if (pruned.length <= 1) return 0;
  const [startMs, startTokens] = pruned[pruned.length - 1] ?? [nowMs, currentTokens];
  const elapsedMs = nowMs - startMs;
  const deltaTokens = Math.max(0, currentTokens - startTokens);
  return elapsedMs <= 0 ? 0 : deltaTokens / (elapsedMs / 1000);
}

export function formatTps(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

export function throttledTps(
  lastSecond: number | null,
  lastValue: number | null,
  nowMs: number,
  samples: Array<[number, number]>,
  currentTokens: number,
): [number, number] {
  const second = Math.trunc(nowMs / 1000);
  if (Number.isInteger(lastSecond) && lastSecond === second && typeof lastValue === "number") {
    return [second, lastValue];
  }
  return [second, rollingTps(samples, nowMs, currentTokens)];
}

export function formatTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");
}

export function tpsGraph(samples: Array<[number, number]>, nowMs: number, currentTokens: number): string {
  const bucketMs = Math.trunc(THROUGHPUT_GRAPH_WINDOW_MS / THROUGHPUT_GRAPH_COLUMNS);
  const activeBucketStart = Math.trunc(nowMs / bucketMs) * bucketMs;
  const graphWindowStart = activeBucketStart - (THROUGHPUT_GRAPH_COLUMNS - 1) * bucketMs;
  const rates = [[nowMs, currentTokens] as [number, number], ...samples]
    .filter(([timestamp]) => timestamp >= nowMs - Math.max(THROUGHPUT_WINDOW_MS, THROUGHPUT_GRAPH_WINDOW_MS))
    .sort(([left], [right]) => left - right)
    .flatMap((sample, index, sorted) => {
      const next = sorted[index + 1];
      if (next === undefined) return [];
      const [startMs, startTokens] = sample;
      const [endMs, endTokens] = next;
      const elapsedMs = endMs - startMs;
      const deltaTokens = Math.max(0, endTokens - startTokens);
      const tps = elapsedMs <= 0 ? 0 : deltaTokens / (elapsedMs / 1000);
      return [[endMs, tps] as [number, number]];
    });

  const bucketedTps = Array.from({ length: THROUGHPUT_GRAPH_COLUMNS }, (_, bucketIndex) => {
    const bucketStart = graphWindowStart + bucketIndex * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const lastBucket = bucketIndex === THROUGHPUT_GRAPH_COLUMNS - 1;
    const values = rates
      .filter(([timestamp]) =>
        lastBucket ? timestamp >= bucketStart && timestamp <= bucketEnd : timestamp >= bucketStart && timestamp < bucketEnd,
      )
      .map(([, value]) => value);
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  });

  const maxTps = Math.max(0, ...bucketedTps);
  return bucketedTps
    .map((value) => {
      const index = maxTps <= 0 ? 0 : Math.round((value / maxTps) * (SPARKLINE_BLOCKS.length - 1));
      return SPARKLINE_BLOCKS[index] ?? "▁";
    })
    .join("");
}

export function dashboardUrl(host: string, configuredPort: number | null, boundPort: number | null): string | null {
  const port = boundPort ?? configuredPort;
  if (port === null || port <= 0) return null;
  return `http://${dashboardUrlHost(host)}:${port}/`;
}

export function formatDashboardHeader(header: DashboardHeader): string[] {
  const lines: string[] = [];
  if (typeof header.projectSlug === "string" && header.projectSlug.trim() !== "") {
    lines.push(`│ Project: ${projectIssueUrl(header.trackerKind, header.projectSlug)}`);
  }
  if (typeof header.dashboardUrl === "string" && header.dashboardUrl.trim() !== "") {
    lines.push(`│ Dashboard: ${header.dashboardUrl.trim()}`);
  }
  return lines;
}

function projectIssueUrl(trackerKind: string | null | undefined, projectSlug: string): string {
  const slug = projectSlug.trim();
  if (trackerKind === "github" && validGitHubRepositorySlug(slug)) {
    return `https://github.com/${slug}/issues`;
  }
  return `https://linear.app/project/${encodeURIComponent(slug)}/issues`;
}

export function formatRetrySummary(retry: RetrySummary): string {
  const issueId = retry.issueId ?? "unknown";
  const identifier = retry.identifier ?? issueId;
  const attempt = retry.attempt ?? 0;
  const dueInMs = retry.dueInMs ?? 0;
  return `│  ↻ ${identifier} attempt=${attempt} in ${nextInWords(dueInMs)}${formatRetryError(retry.error)}`;
}

export function formatRunningSummary(running: RunningSummary, terminalColumns: number | null = null): string {
  const eventWidth = runningEventWidth(terminalColumns);
  const issue = formatCell(running.identifier ?? "unknown", RUNNING_ID_WIDTH);
  const state = formatCell(running.state ?? "unknown", RUNNING_STAGE_WIDTH);
  const pid = formatCell(running.codexAppServerPid ?? "n/a", RUNNING_PID_WIDTH);
  const age = formatCell(formatRuntimeAndTurns(running.runtimeSeconds ?? 0, running.turnCount ?? 0), RUNNING_AGE_WIDTH);
  const tokens = formatCell(formatCount(running.codexTotalTokens ?? 0), RUNNING_TOKENS_WIDTH, "right");
  const session = formatCell(compactSessionId(running.sessionId), RUNNING_SESSION_WIDTH);
  const eventLabel = formatCell(humanizeCodexMessage(running.lastCodexMessage), eventWidth);
  return `│ ● ${issue} ${state} ${pid} ${age} ${tokens} ${session} ${eventLabel}`;
}

export function humanizeCodexMessage(message: unknown): string {
  if (typeof message === "string") return inlineText(message);
  if (!isRecord(message)) return "n/a";

  const event = typeof message.event === "string" ? message.event : null;
  const payload = unwrapCodexMessagePayload(message);
  const base = humanizeCodexPayload(payload);

  if (event === "tool_call_completed") return withDynamicToolName("dynamic tool call completed", payload);
  if (event === "tool_call_failed") return withDynamicToolName("dynamic tool call failed", payload);
  if (event === "unsupported_tool_call") return withDynamicToolName("unsupported dynamic tool call rejected", payload);
  if (event === "approval_auto_approved") return `${base} (auto-approved)`;
  if (event === "tool_input_auto_answered") return `${base} (auto-answered)`;
  return base;
}

function dashboardUrlHost(host: string): string {
  const trimmed = host.trim();
  if (["0.0.0.0", "::", "[::]", ""].includes(trimmed)) return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed.includes(":")) return `[${trimmed}]`;
  return trimmed;
}

function validGitHubRepositorySlug(slug: string): boolean {
  const parts = slug.split("/");
  return parts.length === 2 && parts.every((part) => part.trim() !== "");
}

function nextInWords(dueInMs: number): string {
  const secs = Math.floor(dueInMs / 1000);
  const millis = dueInMs % 1000;
  return `${secs}.${String(millis).padStart(3, "0")}s`;
}

function formatRetryError(error: string | null | undefined): string {
  if (typeof error !== "string") return "";
  const sanitized = error
    .replaceAll("\\r\\n", " ")
    .replaceAll("\\r", " ")
    .replaceAll("\\n", " ")
    .replaceAll("\r\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized === "" ? "" : ` error=${truncate(sanitized, 96)}`;
}

function runningEventWidth(terminalColumns: number | null): number {
  const columns = terminalColumns ?? 115;
  return Math.max(RUNNING_EVENT_MIN_WIDTH, columns - fixedRunningWidth() - RUNNING_ROW_CHROME_WIDTH);
}

function fixedRunningWidth(): number {
  return (
    RUNNING_ID_WIDTH +
    RUNNING_STAGE_WIDTH +
    RUNNING_PID_WIDTH +
    RUNNING_AGE_WIDTH +
    RUNNING_TOKENS_WIDTH +
    RUNNING_SESSION_WIDTH
  );
}

function formatCell(value: unknown, width: number, align: "left" | "right" = "left"): string {
  const normalized = truncate(String(value).replace(/\n/g, " ").replace(/\s+/g, " ").trim(), width);
  return align === "right" ? normalized.padStart(width) : normalized.padEnd(width);
}

function formatRuntimeAndTurns(seconds: number, turnCount: number): string {
  return turnCount > 0 ? `${formatRuntimeSeconds(seconds)} / ${turnCount}` : formatRuntimeSeconds(seconds);
}

function formatRuntimeSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function compactSessionId(sessionId: string | null | undefined): string {
  if (typeof sessionId !== "string" || sessionId === "") return "n/a";
  if (sessionId.length <= 10) return sessionId;
  return `${sessionId.slice(0, 4)}...${sessionId.slice(-6)}`;
}

function mapAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function unwrapCodexMessagePayload(message: Record<string, unknown>): unknown {
  const inner = message.message;
  if (!isRecord(inner)) return inner ?? message;
  const nestedPayload = inner.payload;
  return isRecord(nestedPayload) ? nestedPayload : inner;
}

function humanizeCodexPayload(payload: unknown): string {
  if (typeof payload === "string") return inlineText(payload);
  if (!isRecord(payload)) return payload === undefined ? "n/a" : inlineText(String(payload));

  const method = payload.method;
  if (typeof method === "string") return humanizeCodexMethod(method, payload);

  const sessionId = payload.session_id;
  if (typeof sessionId === "string") return `session started (${sessionId})`;
  if ("error" in payload) return `error: ${formatErrorValue(payload.error)}`;

  return inlineText(JSON.stringify(payload));
}

function humanizeCodexMethod(method: string, payload: Record<string, unknown>): string {
  switch (method) {
    case "thread/started":
      return withOptionalId("thread started", mapAtPath(payload, ["params", "thread", "id"]));
    case "turn/started":
      return withOptionalId("turn started", mapAtPath(payload, ["params", "turn", "id"]));
    case "turn/completed":
      return humanizeTurnCompleted(payload);
    case "turn/failed": {
      const message = mapAtPath(payload, ["params", "error", "message"]);
      return typeof message === "string" ? `turn failed: ${inlineText(message)}` : "turn failed";
    }
    case "turn/cancelled":
      return "turn cancelled";
    case "turn/diff/updated": {
      const diff = mapAtPath(payload, ["params", "diff"]);
      if (typeof diff !== "string" || diff.trim() === "") return "turn diff updated";
      return `turn diff updated (${diff.split("\n").filter((line) => line.trim() !== "").length} lines)`;
    }
    case "turn/plan/updated": {
      const plan = mapAtPath(payload, ["params", "plan"]) ?? mapAtPath(payload, ["params", "steps"]) ?? mapAtPath(payload, ["params", "items"]);
      return Array.isArray(plan) ? `plan updated (${plan.length} steps)` : "plan updated";
    }
    case "thread/tokenUsage/updated": {
      const usage = mapAtPath(payload, ["params", "tokenUsage", "total"]) ?? mapAtPath(payload, ["params", "usage"]) ?? payload.usage;
      const suffix = formatUsageCounts(usage);
      return suffix === null ? "thread token usage updated" : `thread token usage updated (${suffix})`;
    }
    case "item/started":
      return humanizeItemLifecycle("started", payload);
    case "item/completed":
      return humanizeItemLifecycle("completed", payload);
    case "item/agentMessage/delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "item/plan/delta":
      return humanizeStreamingEvent("plan streaming", payload);
    case "item/reasoning/summaryTextDelta":
      return humanizeStreamingEvent("reasoning summary streaming", payload);
    case "item/reasoning/summaryPartAdded":
      return humanizeStreamingEvent("reasoning summary section added", payload);
    case "item/reasoning/textDelta":
      return humanizeStreamingEvent("reasoning text streaming", payload);
    case "item/commandExecution/outputDelta":
      return humanizeStreamingEvent("command output streaming", payload);
    case "item/fileChange/outputDelta":
      return humanizeStreamingEvent("file change output streaming", payload);
    case "item/commandExecution/requestApproval": {
      const command = extractCommand(payload);
      return command === null ? "command approval requested" : `command approval requested (${command})`;
    }
    case "item/fileChange/requestApproval": {
      const count = parseInteger(mapAtPath(payload, ["params", "fileChangeCount"]) ?? mapAtPath(payload, ["params", "changeCount"]));
      return count !== null && count > 0 ? `file change approval requested (${count} files)` : "file change approval requested";
    }
    case "item/tool/requestUserInput":
    case "tool/requestUserInput": {
      const question = mapAtPath(payload, ["params", "question"]) ?? mapAtPath(payload, ["params", "prompt"]);
      return typeof question === "string" && question.trim() !== ""
        ? `tool requires user input: ${inlineText(question)}`
        : "tool requires user input";
    }
    case "item/tool/call":
      return withDynamicToolName("dynamic tool call requested", payload);
    default:
      if (method.startsWith("codex/event/")) return humanizeCodexWrapperEvent(method.slice("codex/event/".length), payload);
      return typeof mapAtPath(payload, ["params", "msg", "type"]) === "string"
        ? `${method} (${mapAtPath(payload, ["params", "msg", "type"])})`
        : method;
  }
}

function humanizeTurnCompleted(payload: Record<string, unknown>): string {
  const status = mapAtPath(payload, ["params", "turn", "status"]) ?? "completed";
  const usage =
    mapAtPath(payload, ["params", "usage"]) ??
    mapAtPath(payload, ["params", "tokenUsage"]) ??
    payload.usage;
  const suffix = formatUsageCounts(usage);
  return `turn completed (${String(status)})${suffix === null ? "" : ` (${suffix})`}`;
}

function humanizeCodexWrapperEvent(event: string, payload: Record<string, unknown>): string {
  switch (event) {
    case "agent_message_delta":
      return humanizeStreamingEvent("agent message streaming", payload);
    case "agent_message_content_delta":
      return humanizeStreamingEvent("agent message content streaming", payload);
    case "agent_reasoning_delta":
      return humanizeStreamingEvent("reasoning streaming", payload);
    case "reasoning_content_delta":
      return humanizeStreamingEvent("reasoning content streaming", payload);
    case "agent_reasoning":
      return humanizeReasoningUpdate(payload);
    case "exec_command_begin": {
      const command = extractCommand(payload);
      return command ?? "command started";
    }
    case "exec_command_end": {
      const exitCode = parseInteger(mapAtPath(payload, ["params", "msg", "exit_code"]) ?? mapAtPath(payload, ["params", "msg", "exitCode"]));
      return exitCode === null ? "command completed" : `command completed (exit ${exitCode})`;
    }
    case "exec_command_output_delta":
      return "command output streaming";
    case "token_count": {
      const usage = extractFirstPath(payload, tokenUsagePaths());
      const suffix = formatUsageCounts(usage);
      return suffix === null ? "token count update" : `token count update (${suffix})`;
    }
    default: {
      const type = mapAtPath(payload, ["params", "msg", "type"]);
      return typeof type === "string" ? `${event} (${type})` : event;
    }
  }
}

function humanizeItemLifecycle(state: string, payload: Record<string, unknown>): string {
  const item = mapAtPath(payload, ["params", "item"]);
  const type = humanizeItemType(isRecord(item) ? item.type : undefined);
  const status = isRecord(item) && typeof item.status === "string" ? humanizeStatus(item.status) : null;
  return `item ${state}: ${type}${status === null ? "" : ` (${status})`}`;
}

function humanizeStreamingEvent(label: string, payload: Record<string, unknown>): string {
  const preview = extractDeltaPreview(payload);
  return preview === null ? label : `${label}: ${preview}`;
}

function humanizeReasoningUpdate(payload: Record<string, unknown>): string {
  const focus = extractFirstPath(payload, reasoningFocusPaths());
  return typeof focus === "string" && focus.trim() !== "" ? `reasoning update: ${inlineText(focus)}` : "reasoning update";
}

function extractDeltaPreview(payload: Record<string, unknown>): string | null {
  const delta = extractFirstPath(payload, deltaPaths());
  return typeof delta === "string" && delta.trim() !== "" ? inlineText(delta) : null;
}

function extractCommand(payload: Record<string, unknown>): string | null {
  const command =
    mapAtPath(payload, ["params", "msg", "command"]) ??
    mapAtPath(payload, ["params", "msg", "parsed_cmd"]) ??
    mapAtPath(payload, ["params", "command"]) ??
    mapAtPath(payload, ["params", "parsedCmd"]);
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" && command.trim() !== "" ? inlineText(command) : null;
}

function withOptionalId(label: string, value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? `${label} (${value})` : label;
}

function withDynamicToolName(base: string, payload: unknown): string {
  const tool = isRecord(payload)
    ? mapAtPath(payload, ["params", "tool"]) ?? mapAtPath(payload, ["params", "name"])
    : undefined;
  return typeof tool === "string" && tool.trim() !== "" ? `${base} (${tool.trim()})` : base;
}

function formatUsageCounts(usage: unknown): string | null {
  if (!isRecord(usage)) return null;
  const input = parseInteger(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens);
  const output = parseInteger(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens);
  const total = parseInteger(usage.total_tokens ?? usage.total ?? usage.totalTokens);
  const parts: string[] = [];
  if (input !== null) parts.push(`in ${formatCount(input)}`);
  if (output !== null) parts.push(`out ${formatCount(output)}`);
  if (total !== null) parts.push(`total ${formatCount(total)}`);
  return parts.length === 0 ? null : parts.join(", ");
}

function extractFirstPath(payload: Record<string, unknown>, paths: string[][]): unknown {
  for (const path of paths) {
    const value = mapAtPath(payload, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function tokenUsagePaths(): string[][] {
  return [
    ["params", "msg", "info", "total_token_usage"],
    ["params", "msg", "payload", "usage"],
    ["params", "msg", "payload", "tokenUsage"],
  ];
}

function deltaPaths(): string[][] {
  return [
    ["params", "delta"],
    ["params", "textDelta"],
    ["params", "outputDelta"],
    ["params", "summaryText"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "textDelta"],
    ["params", "msg", "payload", "outputDelta"],
  ];
}

function reasoningFocusPaths(): string[][] {
  return [
    ["params", "msg", "payload", "summaryText"],
    ["params", "msg", "payload", "text"],
    ["params", "summaryText"],
    ["params", "text"],
  ];
}

function humanizeItemType(value: unknown): string {
  if (typeof value !== "string" || value === "") return "item";
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function humanizeStatus(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.replace(/[_-]+/g, " ");
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function formatErrorValue(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return inlineText(value.message);
  return inlineText(String(value));
}

function inlineText(value: string): string {
  return value
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B./g, "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
