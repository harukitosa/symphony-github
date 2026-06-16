import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import { runAppServer } from "../src/app-server";
import type { Issue } from "../src/linear";

let root: string;
let workflowPath: string;

const issue: Issue = {
  id: "issue-app-server",
  identifier: "MT-999",
  title: "Validate app server",
  description: "Ensure app-server behavior",
  state: "In Progress",
  url: "https://example.org/issues/MT-999",
  labels: ["backend"],
};

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-app-server");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("app server", () => {
  test("rejects the workspace root and paths outside workspace root", async () => {
    const workspaceRoot = join(root, "workspaces");
    const outsideWorkspace = join(root, "outside");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideWorkspace, { recursive: true });
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    expect(await runAppServer(workspaceRoot, "guard", issue)).toMatchObject({
      ok: false,
      error: { type: "invalid_workspace_cwd", reason: "workspace_root" },
    });

    expect(await runAppServer(outsideWorkspace, "guard", issue)).toMatchObject({
      ok: false,
      error: { type: "invalid_workspace_cwd", reason: "outside_workspace_root" },
    });
  });

  test("rejects symlink escape cwd paths under the workspace root", async () => {
    const workspaceRoot = join(root, "workspaces");
    const outsideWorkspace = join(root, "outside");
    const symlinkWorkspace = join(workspaceRoot, "MT-1000");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideWorkspace, { recursive: true });
    await symlink(outsideWorkspace, symlinkWorkspace);
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    expect(await runAppServer(symlinkWorkspace, "guard", issue)).toMatchObject({
      ok: false,
      error: { type: "invalid_workspace_cwd", reason: "symlink_escape", path: symlinkWorkspace },
    });
  });

  test("passes explicit turn sandbox policies through unchanged", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-1001");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-supported-turn-policies.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-1001"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-1001"}}}',
      '{"method":"turn/completed"}',
    ]);

    const policyCases = [
      { type: "dangerFullAccess" },
      { type: "externalSandbox", profile: "remote-ci" },
      { type: "workspaceWrite", writableRoots: ["relative/path"], networkAccess: true },
      { type: "futureSandbox", nested: { flag: true } },
    ];

    for (const configuredPolicy of policyCases) {
      await rm(traceFile, { force: true });
      await writeWorkflowFile(workflowPath, {
        workspace: { root: workspaceRoot },
        codex: { command: `${codexBinary} app-server`, turn_sandbox_policy: configuredPolicy },
      });

      const result = await runAppServer(workspace, "Validate supported turn policy", {
        ...issue,
        id: "issue-supported-turn-policies",
        identifier: "MT-1001",
        title: "Validate explicit turn sandbox policy passthrough",
      });
      expect(result.ok).toBe(true);

      const trace = await readJsonTrace(traceFile);
      expect(
        trace.some(
          (payload) =>
            payload.method === "turn/start" &&
            JSON.stringify(payload.params?.sandboxPolicy) === JSON.stringify(configuredPolicy),
        ),
      ).toBe(true);
    }
  });

  test("exposes only GitHub dynamic tools for GitHub workflows", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "GH-1002");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-github-dynamic-tools.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-gh-1002"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-gh-1002"}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        project_slug: "openai/symphony",
      },
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const result = await runAppServer(workspace, "Validate GitHub tool exposure", {
      ...issue,
      id: "issue-gh-1002",
      identifier: "#1002",
      title: "Expose GitHub dynamic tools",
      state: "open",
      url: "https://github.com/openai/symphony/issues/1002",
    });
    expect(result.ok).toBe(true);

    const trace = await readJsonTrace(traceFile);
    const threadStart = trace.find((payload) => payload.method === "thread/start");
    expect(threadStart?.params?.dynamicTools?.map((tool: { name: string }) => tool.name)).toEqual(["github_rest"]);
  });

  test("rejects unadvertised Linear tool calls for GitHub workflows without executing them", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "GH-1003");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-github-unadvertised-tool.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-gh-1003"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-gh-1003"}}}\n{"id":120,"method":"item/tool/call","params":{"name":"linear_graphql","callId":"call-gh-1003","arguments":{"query":"query Viewer { viewer { id } }"}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      tracker: {
        kind: "github",
        api_key: "github-token",
        project_slug: "openai/symphony",
      },
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: any[] = [];
    const toolCalls: unknown[] = [];
    const result = await runAppServer(
      workspace,
      "Reject unadvertised Linear tool",
      {
        ...issue,
        id: "issue-gh-1003",
        identifier: "#1003",
        title: "Reject unadvertised Linear tool",
        state: "open",
        url: "https://github.com/openai/symphony/issues/1003",
      },
      {
        onMessage: (message) => messages.push(message),
        toolExecutor: async (tool, args) => {
          toolCalls.push({ tool, args });
          return { success: true, output: "should not execute", contentItems: [{ type: "inputText", text: "should not execute" }] };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(toolCalls).toEqual([]);
    expect(messages).toContainEqual({
      event: "unsupported_tool_call",
      payload: expect.objectContaining({ params: expect.objectContaining({ name: "linear_graphql" }) }),
    });

    const trace = await readJsonTrace(traceFile);
    const toolResponse = trace.find((payload) => payload.id === 120);
    expect(toolResponse?.result?.success).toBe(false);
    expect(toolResponse?.result?.output).toContain("Unsupported dynamic tool");
    expect(JSON.parse(toolResponse?.result?.output ?? "{}").error.supportedTools).toEqual(["github_rest"]);
  });

  test("marks request-for-input and MCP elicitation events as hard failures", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-88");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-input.trace");
    await mkdir(workspace, { recursive: true });

    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-88"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-88"}}}',
      '{"method":"turn/input_required","id":"resp-1","params":{"requiresInput":true,"reason":"blocked"}}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    let result = await runAppServer(workspace, "Needs input", { ...issue, identifier: "MT-88", title: "Input needed" });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "turn_input_required", payload: { method: "turn/input_required" } },
    });

    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-188"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-188"}}}',
      '{"method":"mcpServer/elicitation/request","params":{"message":"Need operator input"}}',
    ]);
    result = await runAppServer(workspace, "Needs MCP input", { ...issue, identifier: "MT-188", title: "MCP elicitation" });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "turn_input_required", payload: { method: "mcpServer/elicitation/request" } },
    });

    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-288"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-288"}}}',
      '{"method":"turn/approval_required","params":{"requiresInput":true,"reason":"approval needed"}}',
    ]);
    result = await runAppServer(workspace, "Needs turn approval", { ...issue, identifier: "MT-288", title: "Turn approval" });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "turn_input_required", payload: { method: "turn/approval_required" } },
    });

    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-388"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-388"}}}',
      '{"method":"turn/needs_input","params":{"needsInput":true,"reason":"operator input"}}',
    ]);
    result = await runAppServer(workspace, "Needs operator input", { ...issue, identifier: "MT-388", title: "Needs input alias" });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "turn_input_required", payload: { method: "turn/needs_input" } },
    });
  });

  test("fails when command execution approval is required under safer defaults", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-89");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-approval-required.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-89"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-89"}}}\n{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const result = await runAppServer(workspace, "Handle approval request", {
      ...issue,
      identifier: "MT-89",
      title: "Approval required",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { type: "approval_required", payload: { method: "item/commandExecution/requestApproval" } },
    });
  });

  test("auto-approves command execution approval requests when approval policy is never", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-89");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-auto-approve.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-89"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-89"}}}\n{"id":99,"method":"item/commandExecution/requestApproval","params":{"command":"gh pr view","cwd":"/tmp","reason":"need approval"}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server`, approval_policy: "never" },
    });

    const result = await runAppServer(workspace, "Handle approval request", {
      ...issue,
      identifier: "MT-89",
      title: "Auto approve request",
    });
    expect(result.ok).toBe(true);

    const trace = await readJsonTrace(traceFile);
    expect(trace.some((payload) => payload.id === 99 && payload.result?.decision === "acceptForSession")).toBe(true);
  });

  test("auto-answers tool request user input prompts", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-719");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-tool-user-input-options.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-719"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-719"}}}\n{"id":112,"method":"item/tool/requestUserInput","params":{"itemId":"call-719","questions":[{"header":"Choose an action","id":"options-719","isOther":false,"isSecret":false,"options":[{"description":"Use the default behavior.","label":"Use default"},{"description":"Skip this step.","label":"Skip"}],"question":"How should I proceed?"}],"threadId":"thread-719","turnId":"turn-719"}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: any[] = [];
    const result = await runAppServer(
      workspace,
      "Handle option based tool input",
      { ...issue, identifier: "MT-719", title: "Option based tool input answer" },
      { onMessage: (message) => messages.push(message) },
    );
    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({
      event: "tool_input_auto_answered",
      answer: "This is a non-interactive session. Operator input is unavailable.",
    });

    const trace = await readJsonTrace(traceFile);
    expect(trace.some((payload) => payload.id === 112 && payload.result?.answers?.["options-719"]?.answers?.[0] === "This is a non-interactive session. Operator input is unavailable.")).toBe(true);
  });

  test("auto-approves MCP tool approval prompts when approval policy is never", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-717");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-tool-user-input-auto-approve.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-717"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-717"}}}\n{"id":110,"method":"item/tool/requestUserInput","params":{"itemId":"call-717","questions":[{"header":"Approve app tool call?","id":"mcp_tool_call_approval_call-717","isOther":false,"isSecret":false,"options":[{"description":"Run the tool and continue.","label":"Approve Once"},{"description":"Run the tool and remember this choice for this session.","label":"Approve this Session"},{"description":"Decline this tool call and continue.","label":"Deny"},{"description":"Cancel this tool call","label":"Cancel"}],"question":"The linear MCP server wants to run the tool \\"Save issue\\", which may modify or delete data. Allow this action?"}],"threadId":"thread-717","turnId":"turn-717"}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server`, approval_policy: "never" },
    });

    const messages: any[] = [];
    const result = await runAppServer(
      workspace,
      "Handle tool approval prompt",
      { ...issue, identifier: "MT-717", title: "Auto approve MCP tool request user input" },
      { onMessage: (message) => messages.push(message) },
    );

    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({ event: "approval_auto_approved", decision: "Approve this Session" });
    const trace = await readJsonTrace(traceFile);
    expect(
      trace.some(
        (payload) =>
          payload.id === 110 &&
          JSON.stringify(payload.result?.answers?.["mcp_tool_call_approval_call-717"]?.answers) ===
            JSON.stringify(["Approve this Session"]),
      ),
    ).toBe(true);
  });

  test("executes dynamic tool calls and returns normalized tool results", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-90A");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-supported-tool-call.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-90a"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-90a"}}}\n{"id":102,"method":"item/tool/call","params":{"name":"linear_graphql","callId":"call-90a","threadId":"thread-90a","turnId":"turn-90a","arguments":{"query":"query Viewer { viewer { id } }","variables":{"includeTeams":false}}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const toolCalls: unknown[] = [];
    const result = await runAppServer(
      workspace,
      "Handle supported tool calls",
      { ...issue, identifier: "MT-90A", title: "Supported tool call" },
      {
        toolExecutor: async (tool, args) => {
          toolCalls.push({ tool, args });
          return {
            success: true,
            contentItems: [{ type: "inputText", text: '{"data":{"viewer":{"id":"usr_123"}}}' }],
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(toolCalls).toEqual([
      {
        tool: "linear_graphql",
        args: { query: "query Viewer { viewer { id } }", variables: { includeTeams: false } },
      },
    ]);
    const trace = await readJsonTrace(traceFile);
    expect(trace.some((payload) => payload.id === 102 && payload.result?.success === true && payload.result?.output === '{"data":{"viewer":{"id":"usr_123"}}}')).toBe(true);
  });

  test("returns failure payloads for unsupported dynamic tool calls", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-90U");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-unsupported-tool-call.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-90u"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-90u"}}}\n{"id":101,"method":"item/tool/call","params":{"name":"not_a_real_tool","callId":"call-90u","arguments":{}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: any[] = [];
    const result = await runAppServer(
      workspace,
      "Handle unsupported tool calls",
      { ...issue, identifier: "MT-90U", title: "Unsupported tool call" },
      { onMessage: (message) => messages.push(message) },
    );

    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({
      event: "unsupported_tool_call",
      payload: expect.objectContaining({ params: expect.objectContaining({ name: "not_a_real_tool" }) }),
    });

    const trace = await readJsonTrace(traceFile);
    const toolResponse = trace.find((payload) => payload.id === 101);
    expect(toolResponse?.result?.success).toBe(false);
    expect(toolResponse?.result?.output).toContain("Unsupported dynamic tool");
  });

  test("emits tool_call_failed with payload for supported tool failures", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-90B");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-tool-call-failed.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      null,
      '{"id":2,"result":{"thread":{"id":"thread-90b"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-90b"}}}\n{"id":103,"method":"item/tool/call","params":{"tool":"linear_graphql","callId":"call-90b","arguments":{"query":"query Viewer { viewer { id } }"}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: any[] = [];
    const result = await runAppServer(
      workspace,
      "Handle failed tool calls",
      { ...issue, identifier: "MT-90B", title: "Tool call failed" },
      {
        onMessage: (message) => messages.push(message),
        toolExecutor: () => ({
          success: false,
          contentItems: [{ type: "inputText", text: '{"error":{"message":"boom"}}' }],
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({
      event: "tool_call_failed",
      payload: expect.objectContaining({ params: expect.objectContaining({ tool: "linear_graphql" }) }),
    });
  });

  test("buffers large JSON lines until newline terminator", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-91");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-partial-line.trace");
    const padding = "a".repeat(1_100_000);
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      JSON.stringify({ id: 1, result: {}, padding }),
      '{"id":2,"result":{"thread":{"id":"thread-91"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-91"}}}',
      '{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const result = await runAppServer(
      workspace,
      "Validate newline-delimited buffering",
      { ...issue, identifier: "MT-91", title: "Partial line decode" },
    );

    expect(result.ok).toBe(true);
  });

  test("emits malformed events for JSON-like protocol lines that fail to decode", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-93");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-malformed-protocol.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-93"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-93"}}}',
      '{"method":"turn/completed"\n{"method":"turn/completed"}',
    ]);
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: Array<Record<string, unknown>> = [];
    const result = await runAppServer(
      workspace,
      "Capture malformed protocol line",
      { ...issue, identifier: "MT-93", title: "Malformed protocol frame" },
      { onMessage: (message) => messages.push(message) },
    );

    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({ event: "malformed", payload: '{"method":"turn/completed"' });
    expect(messages).toContainEqual({
      event: "turn_completed",
      payload: { method: "turn/completed" },
    });
  });

  test("captures codex side output without treating it as malformed protocol", async () => {
    const workspaceRoot = join(root, "workspaces");
    const workspace = join(workspaceRoot, "MT-92");
    const codexBinary = join(root, "fake-codex");
    const traceFile = join(root, "codex-stderr.trace");
    await mkdir(workspace, { recursive: true });
    await writeFakeCodex(codexBinary, traceFile, [
      '{"id":1,"result":{}}',
      '{"id":2,"result":{"thread":{"id":"thread-92"}}}',
      '{"id":3,"result":{"turn":{"id":"turn-92"}}}',
      null,
    ], { stderrOn: 4, stderrLine: "warning: this is stderr noise", extraStdoutOn: 4, extraStdoutLine: '{"method":"turn/completed"}' });
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      codex: { command: `${codexBinary} app-server` },
    });

    const messages: Array<Record<string, unknown>> = [];
    const result = await runAppServer(
      workspace,
      "Capture stderr log",
      { ...issue, identifier: "MT-92", title: "Capture stderr" },
      { onMessage: (message) => messages.push(message) },
    );

    expect(result.ok).toBe(true);
    expect(messages).toContainEqual({ event: "stream_output", stream: "stderr", payload: "warning: this is stderr noise" });
    expect(messages).toContainEqual({ event: "turn_completed", payload: { method: "turn/completed" } });
    expect(messages.some((message) => message.event === "malformed")).toBe(false);
  });

  test("launches over ssh for remote workers", async () => {
    const previousPath = process.env.PATH;
    const traceFile = join(root, "ssh.trace");
    const fakeSsh = join(root, "ssh");
    const remoteWorkspace = "/remote/workspaces/MT-REMOTE";
    await writeFile(
      fakeSsh,
      `#!/bin/sh
trace_file="${traceFile}"
count=0
printf 'ARGV:%s\\n' "$*" >> "$trace_file"
while IFS= read -r line; do
  count=$((count + 1))
  printf 'JSON:%s\\n' "$line" >> "$trace_file"
  case "$count" in
    1) printf '%s\\n' '{"id":1,"result":{}}' ;;
    2) printf '%s\\n' '{"id":2,"result":{"thread":{"id":"thread-remote"}}}' ;;
    3) printf '%s\\n' '{"id":3,"result":{"turn":{"id":"turn-remote"}}}' ;;
    4) printf '%s\\n' '{"method":"turn/completed"}'; exit 0 ;;
    *) exit 0 ;;
  esac
done
`,
    );
    await chmod(fakeSsh, 0o755);
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    await writeWorkflowFile(workflowPath, {
      workspace: { root: "/remote/workspaces" },
      codex: { command: "fake-remote-codex app-server" },
    });

    try {
      const result = await runAppServer(
        remoteWorkspace,
        "Run remote worker",
        { ...issue, id: "issue-remote", identifier: "MT-REMOTE", title: "Run remote app server" },
        { workerHost: "worker-01:2200" },
      );

      expect(result.ok).toBe(true);
      const lines = (await readFile(traceFile, "utf8")).split("\n").filter(Boolean);
      const argvLine = lines.find((line) => line.startsWith("ARGV:"));
      expect(argvLine).toContain("-T -p 2200 worker-01 bash -lc");
      expect(argvLine).toContain(remoteWorkspace);
      expect(argvLine).toContain("fake-remote-codex app-server");

      const payloads = lines
        .filter((line) => line.startsWith("JSON:"))
        .map((line) => JSON.parse(line.slice("JSON:".length)));
      expect(payloads.some((payload) => payload.method === "thread/start" && payload.params?.cwd === remoteWorkspace)).toBe(true);
      expect(
        payloads.some(
          (payload) =>
            payload.method === "turn/start" &&
            payload.params?.cwd === remoteWorkspace &&
            JSON.stringify(payload.params?.sandboxPolicy) ===
              JSON.stringify({
                type: "workspaceWrite",
                writableRoots: [remoteWorkspace],
                readOnlyAccess: { type: "fullAccess" },
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              }),
        ),
      ).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("rejects invalid remote workspace paths before launching ssh", async () => {
    await writeWorkflowFile(workflowPath, {
      workspace: { root: "/remote/workspaces" },
      codex: { command: "fake-remote-codex app-server" },
    });

    expect(await runAppServer("   ", "guard", issue, { workerHost: "worker-01" })).toMatchObject({
      ok: false,
      error: { type: "invalid_workspace_cwd", reason: "empty_remote_workspace", workerHost: "worker-01" },
    });
    expect(await runAppServer("/remote/workspaces/bad\npath", "guard", issue, { workerHost: "worker-01" })).toMatchObject({
      ok: false,
      error: { type: "invalid_workspace_cwd", reason: "invalid_remote_workspace", workerHost: "worker-01" },
    });
  });
});

async function writeFakeCodex(
  path: string,
  traceFile: string,
  responses: Array<string | null>,
  opts: { stderrOn?: number; stderrLine?: string; extraStdoutOn?: number; extraStdoutLine?: string } = {},
): Promise<void> {
  const cases = responses
    .map((response, index) => {
      const commands: string[] = [];
      const caseIndex = index + 1;
      if (response !== null) commands.push(`printf '%s\\n' '${shellSingleQuote(response)}'`);
      if (opts.stderrOn === caseIndex && opts.stderrLine !== undefined) {
        commands.push(`printf '%s\\n' '${shellSingleQuote(opts.stderrLine)}' >&2`);
      }
      if (opts.extraStdoutOn === caseIndex && opts.extraStdoutLine !== undefined) {
        commands.push(`printf '%s\\n' '${shellSingleQuote(opts.extraStdoutLine)}'`);
      }
      return `${caseIndex}) ${commands.length === 0 ? "" : `${commands.join("\n      ")}\n      `};;`;
    })
    .join("\n");
  await writeFile(
    path,
    `#!/bin/sh
trace_file="${traceFile}"
count=0
while IFS= read -r line; do
  count=$((count + 1))
  printf 'JSON:%s\\n' "$line" >> "$trace_file"
  case "$count" in
    ${cases}
    *) exit 0 ;;
  esac
done
`,
  );
  await chmod(path, 0o755);
}

function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

async function readJsonTrace(path: string): Promise<Array<Record<string, any>>> {
  const trace = await readFile(path, "utf8");
  return trace
    .split("\n")
    .filter((line) => line.startsWith("JSON:"))
    .map((line) => JSON.parse(line.slice("JSON:".length)));
}
