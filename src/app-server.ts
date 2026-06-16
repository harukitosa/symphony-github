import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { err, ok, type Result } from "./result";
import { settings, codexTurnSandboxPolicy } from "./config";
import { executeDynamicTool, toolSpecs, type DynamicToolResponse } from "./dynamic-tool";
import { canonicalize } from "./workspace";
import { buildSshArgs } from "./ssh";
import type { Issue } from "./linear";

export type AppServerError =
  | { type: "invalid_workspace_cwd"; reason: "workspace_root"; path: string }
  | { type: "invalid_workspace_cwd"; reason: "outside_workspace_root"; path: string; root: string }
  | { type: "invalid_workspace_cwd"; reason: "symlink_escape"; path: string; root: string }
  | { type: "invalid_workspace_cwd"; reason: "path_unreadable"; path: string; detail: unknown }
  | { type: "invalid_workspace_cwd"; reason: "empty_remote_workspace"; workerHost: string }
  | { type: "invalid_workspace_cwd"; reason: "invalid_remote_workspace"; workerHost: string; path: string }
  | { type: "invalid_thread_payload"; payload: unknown }
  | { type: "turn_input_required"; payload: Record<string, unknown> }
  | { type: "approval_required"; payload: Record<string, unknown> }
  | { type: "turn_failed"; payload: unknown }
  | { type: "turn_cancelled"; payload: unknown }
  | { type: "port_exit"; status: number | null }
  | { type: "protocol_error"; message: string; payload?: unknown };

export type AppServerResult = {
  result: unknown;
  sessionId: string;
  threadId: string;
  turnId: string;
};

export type AppServerOptions = {
  onMessage?: (message: Record<string, unknown>) => void;
  toolExecutor?: (tool: string | null, args: unknown) => Promise<Partial<DynamicToolResponse>> | Partial<DynamicToolResponse>;
  workerHost?: string | null;
};

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

export async function runAppServer(
  workspace: string,
  prompt: string,
  issue: Issue,
  opts: AppServerOptions = {},
): Promise<Result<AppServerResult, AppServerError>> {
  const workerHost = normalizeWorkerHost(opts.workerHost);
  const cwdResult = await validateWorkspaceCwd(workspace, workerHost);
  if (!cwdResult.ok) return cwdResult;

  const config = await settings();
  const child = startAppServerProcess(cwdResult.value, config.codex.command, workerHost);

  const transport = new JsonLineTransport(child, (stream, payload) => {
    opts.onMessage?.({ event: "stream_output", stream, payload });
  });
  try {
    const initialized = await sendInitialize(transport);
    if (!initialized.ok) return initialized;

    const dynamicTools = appServerToolSpecs(config.tracker.kind);
    const thread = await startThread(
      transport,
      cwdResult.value,
      config.codex.approval_policy,
      config.codex.thread_sandbox,
      dynamicTools,
      opts.onMessage,
    );
    if (!thread.ok) return thread;

    const sandboxPolicy = await codexTurnSandboxPolicy(cwdResult.value);
    const turn = await startTurn(
      transport,
      thread.value,
      prompt,
      issue,
      cwdResult.value,
      config.codex.approval_policy,
      sandboxPolicy,
      opts.onMessage,
    );
    if (!turn.ok) return turn;

    const turnOptions: TurnCompletionOptions = {
      autoApproveRequests: config.codex.approval_policy === "never",
      supportedToolNames: dynamicTools.map((tool) => tool.name),
    };
    if (opts.onMessage !== undefined) turnOptions.onMessage = opts.onMessage;
    if (opts.toolExecutor !== undefined) turnOptions.toolExecutor = opts.toolExecutor;
    const completion = await awaitTurnCompletion(transport, turnOptions);
    if (!completion.ok) return completion;

    return ok({
      result: completion.value,
      sessionId: `${thread.value}-${turn.value}`,
      threadId: thread.value,
      turnId: turn.value,
    });
  } finally {
    child.kill();
  }
}

function startAppServerProcess(workspace: string, command: string, workerHost: string | null): ChildProcessWithoutNullStreams {
  if (workerHost !== null) {
    return spawn("ssh", buildSshArgs(workerHost, remoteLaunchCommand(workspace, command)), {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  return spawn("bash", ["-lc", command], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function validateWorkspaceCwd(
  workspace: string,
  workerHost: string | null = null,
): Promise<Result<string, AppServerError>> {
  if (workerHost !== null) {
    if (workspace.trim() === "") {
      return err({ type: "invalid_workspace_cwd", reason: "empty_remote_workspace", workerHost });
    }
    if (workspace.includes("\n") || workspace.includes("\r") || workspace.includes("\0")) {
      return err({ type: "invalid_workspace_cwd", reason: "invalid_remote_workspace", workerHost, path: workspace });
    }
    return ok(workspace);
  }

  const config = await settings();
  const expandedWorkspace = resolve(workspace);
  const expandedRoot = resolve(config.workspace.root);

  try {
    const canonicalWorkspace = await canonicalize(expandedWorkspace);
    const canonicalRoot = await canonicalize(expandedRoot);

    if (canonicalWorkspace === canonicalRoot) {
      return err({ type: "invalid_workspace_cwd", reason: "workspace_root", path: canonicalWorkspace });
    }
    if (isUnder(canonicalWorkspace, canonicalRoot)) return ok(canonicalWorkspace);
    if (isUnder(expandedWorkspace, expandedRoot)) {
      return err({ type: "invalid_workspace_cwd", reason: "symlink_escape", path: expandedWorkspace, root: canonicalRoot });
    }
    return err({
      type: "invalid_workspace_cwd",
      reason: "outside_workspace_root",
      path: canonicalWorkspace,
      root: canonicalRoot,
    });
  } catch (detail) {
    return err({ type: "invalid_workspace_cwd", reason: "path_unreadable", path: expandedWorkspace, detail });
  }
}

function remoteLaunchCommand(workspace: string, command: string): string {
  return `cd ${shellEscape(workspace)} && exec ${command}`;
}

function normalizeWorkerHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

async function sendInitialize(transport: JsonLineTransport): Promise<Result<void, AppServerError>> {
  transport.send({
    method: "initialize",
    id: INITIALIZE_ID,
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "symphony-orchestrator", title: "Symphony Orchestrator", version: "0.1.0" },
    },
  });

  const response = await transport.nextResponse(INITIALIZE_ID);
  if (!response.ok) return response;

  transport.send({ method: "initialized", params: {} });
  return ok(undefined);
}

async function startThread(
  transport: JsonLineTransport,
  cwd: string,
  approvalPolicy: string | Record<string, unknown>,
  threadSandbox: string,
  dynamicTools: ReturnType<typeof toolSpecs>,
  onMessage?: (message: Record<string, unknown>) => void,
): Promise<Result<string, AppServerError>> {
  transport.send({
    method: "thread/start",
    id: THREAD_START_ID,
    params: {
      approvalPolicy,
      sandbox: threadSandbox,
      cwd,
      dynamicTools,
    },
  });
  const response = await transport.nextResponse(THREAD_START_ID, onMessage);
  if (!response.ok) return response;
  const thread = response.value.result?.thread;
  if (isRecord(thread) && typeof thread.id === "string") return ok(thread.id);
  return err({ type: "invalid_thread_payload", payload: response.value.result });
}

function appServerToolSpecs(trackerKind: string | null): ReturnType<typeof toolSpecs> {
  const specs = toolSpecs();
  if (trackerKind === "github") return specs.filter((spec) => spec.name === "github_rest");
  return specs.filter((spec) => spec.name === "linear_graphql");
}

async function startTurn(
  transport: JsonLineTransport,
  threadId: string,
  prompt: string,
  issue: Issue,
  cwd: string,
  approvalPolicy: string | Record<string, unknown>,
  sandboxPolicy: Record<string, unknown>,
  onMessage?: (message: Record<string, unknown>) => void,
): Promise<Result<string, AppServerError>> {
  transport.send({
    method: "turn/start",
    id: TURN_START_ID,
    params: {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      title: `${issue.identifier}: ${issue.title}`,
      approvalPolicy,
      sandboxPolicy,
    },
  });
  const response = await transport.nextResponse(TURN_START_ID, onMessage);
  if (!response.ok) return response;
  const turn = response.value.result?.turn;
  if (isRecord(turn) && typeof turn.id === "string") return ok(turn.id);
  return err({ type: "protocol_error", message: "invalid turn payload", payload: response.value.result });
}

async function awaitTurnCompletion(
  transport: JsonLineTransport,
  opts: TurnCompletionOptions,
): Promise<Result<unknown, AppServerError>> {
  while (true) {
    const next = await transport.nextJson(opts.onMessage);
    if (!next.ok) return next;
    const payload = next.value;
    if (payload.method === "turn/completed") {
      opts.onMessage?.({ event: "turn_completed", payload });
      return ok("turn_completed");
    }
    if (payload.method === "turn/failed") return err({ type: "turn_failed", payload: payload.params });
    if (payload.method === "turn/cancelled") return err({ type: "turn_cancelled", payload: payload.params });
    const approval = await maybeHandleApprovalOrToolRequest(transport, payload, opts);
    if (approval === "approval_required") return err({ type: "approval_required", payload });
    if (approval === "handled") continue;
    if (needsInput(payload)) return err({ type: "turn_input_required", payload });
  }
}

async function maybeHandleApprovalOrToolRequest(
  transport: JsonLineTransport,
  payload: Record<string, any>,
  opts: TurnCompletionOptions,
): Promise<"handled" | "approval_required" | "unhandled"> {
  if (
    ["item/commandExecution/requestApproval", "execCommandApproval", "applyPatchApproval", "item/fileChange/requestApproval"].includes(
      payload.method,
    )
  ) {
    if (!opts.autoApproveRequests) return "approval_required";
    const decision = payload.method === "execCommandApproval" || payload.method === "applyPatchApproval"
      ? "approved_for_session"
      : "acceptForSession";
    transport.send({ id: payload.id, result: { decision } });
    opts.onMessage?.({ event: "approval_auto_approved", decision });
    return "handled";
  }

  if (payload.method === "item/tool/requestUserInput") {
    const answers = opts.autoApproveRequests
      ? approvalAnswers(payload.params)
      : undefined;
    const finalAnswers = answers ?? unavailableAnswers(payload.params);
    if (finalAnswers === undefined) return "unhandled";
    transport.send({ id: payload.id, result: { answers: finalAnswers } });
    if (answers !== undefined) {
      opts.onMessage?.({ event: "approval_auto_approved", decision: "Approve this Session" });
    } else {
      opts.onMessage?.({ event: "tool_input_auto_answered", answer: NON_INTERACTIVE_TOOL_INPUT_ANSWER });
    }
    return "handled";
  }

  if (payload.method === "item/tool/call") {
    const tool = toolCallName(payload.params);
    const args = toolCallArguments(payload.params);
    if (!isAllowedToolName(tool, opts.supportedToolNames)) {
      const result = unsupportedToolResult(tool, opts.supportedToolNames);
      transport.send({ id: payload.id, result });
      opts.onMessage?.({ event: "unsupported_tool_call", payload });
      return "handled";
    }
    const rawResult = opts.toolExecutor
      ? await opts.toolExecutor(tool, args)
      : await executeDynamicTool(tool, args);
    const result = normalizeDynamicToolResult(rawResult);
    transport.send({ id: payload.id, result });
    const event = result.success
      ? "tool_call_completed"
      : isSupportedToolName(tool)
        ? "tool_call_failed"
        : "unsupported_tool_call";
    opts.onMessage?.({ event, payload });
    return "handled";
  }

  return "unhandled";
}

type TurnCompletionOptions = {
  autoApproveRequests: boolean;
  supportedToolNames: string[];
  onMessage?: (message: Record<string, unknown>) => void;
  toolExecutor?: (tool: string | null, args: unknown) => Promise<Partial<DynamicToolResponse>> | Partial<DynamicToolResponse>;
};

const NON_INTERACTIVE_TOOL_INPUT_ANSWER = "This is a non-interactive session. Operator input is unavailable.";

function approvalAnswers(params: unknown): Record<string, { answers: string[] }> | undefined {
  if (!isRecord(params) || !Array.isArray(params.questions)) return undefined;
  const result: Record<string, { answers: string[] }> = {};
  for (const question of params.questions) {
    if (!isRecord(question) || typeof question.id !== "string" || !Array.isArray(question.options)) return undefined;
    const labels = question.options
      .map((option) => (isRecord(option) && typeof option.label === "string" ? option.label : null))
      .filter((label): label is string => label !== null);
    const answer =
      labels.find((label) => label === "Approve this Session") ??
      labels.find((label) => label === "Approve Once") ??
      labels.find((label) => {
        const normalized = label.trim().toLowerCase();
        return normalized.startsWith("approve") || normalized.startsWith("allow");
      });
    if (answer === undefined) return undefined;
    result[question.id] = { answers: [answer] };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function unavailableAnswers(params: unknown): Record<string, { answers: string[] }> | undefined {
  if (!isRecord(params) || !Array.isArray(params.questions)) return undefined;
  const result: Record<string, { answers: string[] }> = {};
  for (const question of params.questions) {
    if (!isRecord(question) || typeof question.id !== "string") return undefined;
    result[question.id] = { answers: [NON_INTERACTIVE_TOOL_INPUT_ANSWER] };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toolCallName(params: unknown): string | null {
  if (!isRecord(params)) return null;
  if (typeof params.name === "string") return params.name;
  if (typeof params.tool === "string") return params.tool;
  return null;
}

function isSupportedToolName(tool: string | null): boolean {
  return typeof tool === "string" && toolSpecs().some((spec) => spec.name === tool);
}

function isAllowedToolName(tool: string | null, supportedToolNames: string[]): tool is string {
  return typeof tool === "string" && supportedToolNames.includes(tool);
}

function unsupportedToolResult(tool: string | null, supportedToolNames: string[]): DynamicToolResponse {
  const output = JSON.stringify({
    error: {
      message: `Unsupported dynamic tool: ${JSON.stringify(tool)}.`,
      supportedTools: supportedToolNames,
    },
  }, null, 2);
  return { success: false, output, contentItems: [{ type: "inputText", text: output }] };
}

function toolCallArguments(params: unknown): unknown {
  return isRecord(params) ? params.arguments ?? {} : {};
}

function normalizeDynamicToolResult(result: Partial<DynamicToolResponse>): DynamicToolResponse {
  if (typeof result.success !== "boolean") {
    const output = JSON.stringify(result);
    return { success: false, output, contentItems: [{ type: "inputText", text: output }] };
  }
  const output =
    typeof result.output === "string"
      ? result.output
      : result.contentItems?.[0]?.text ?? JSON.stringify(result, null, 2);
  const contentItems = Array.isArray(result.contentItems) ? result.contentItems : [{ type: "inputText" as const, text: output }];
  return { success: result.success, output, contentItems };
}

class JsonLineTransport {
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private buffer = "";
  private exited = false;
  private exitStatus: number | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onSideOutput?: (stream: "stdout" | "stderr", payload: string) => void,
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.pushChunk(chunk));
    child.stderr.on("data", (chunk: string) => this.pushSideOutput("stderr", chunk));
    child.on("close", (status) => {
      this.exited = true;
      this.exitStatus = status;
      this.flushWaiters(null);
    });
  }

  send(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async nextJson(
    onMessage?: (message: Record<string, unknown>) => void,
  ): Promise<Result<Record<string, any>, AppServerError>> {
    while (true) {
      const line = await this.nextLine();
      if (line === null) return err({ type: "port_exit", status: this.exitStatus });
      try {
        const payload = JSON.parse(line);
        if (isRecord(payload)) return ok(payload);
      } catch {
        if (isJsonLikeLine(line)) onMessage?.({ event: "malformed", payload: line });
      }
    }
  }

  async nextResponse(
    id: number,
    onMessage?: (message: Record<string, unknown>) => void,
  ): Promise<Result<Record<string, any>, AppServerError>> {
    while (true) {
      const response = await this.nextJson(onMessage);
      if (!response.ok) return response;
      if (response.value.id === id) return response;
      onMessage?.(response.value);
    }
  }

  private nextLine(): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.exited) return Promise.resolve(null);
    return new Promise((resolvePromise) => this.waiters.push(resolvePromise));
  }

  private pushChunk(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    }
  }

  private flushWaiters(line: string | null): void {
    for (const waiter of this.waiters.splice(0)) waiter(line);
  }

  private pushSideOutput(stream: "stdout" | "stderr", chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line !== "") this.onSideOutput?.(stream, line);
    }
  }
}

function needsInput(payload: Record<string, unknown>): boolean {
  if (payload.method === "mcpServer/elicitation/request") return true;
  if (typeof payload.method !== "string" || !payload.method.startsWith("turn/")) return false;
  return (
    [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required",
    ].includes(payload.method) ||
    needsInputField(payload) ||
    (isRecord(payload.params) && needsInputField(payload.params))
  );
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function needsInputField(payload: Record<string, unknown>): boolean {
  return (
    payload.requiresInput === true ||
    payload.needsInput === true ||
    payload.inputRequired === true ||
    payload.approvalRequired === true
  );
}

function isJsonLikeLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
