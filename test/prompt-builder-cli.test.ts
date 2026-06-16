import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve, basename } from "node:path";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath, setWorkflowFilePath } from "../src/workflow";
import { buildPrompt } from "../src/prompt-builder";
import { settings } from "../src/config";
import { evaluateCli, ACK_FLAG, type CliDeps } from "../src/cli";
import type { Issue } from "../src/linear";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-prompt-cli");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("prompt builder", () => {
  test("renders issue and attempt values from workflow template", async () => {
    await writeWorkflowFile(workflowPath, {
      prompt: "Ticket {{ issue.identifier }} {{ issue.title }} labels={{ issue.labels }} attempt={{ attempt }}",
    });

    const prompt = await buildPrompt(
      {
        identifier: "S-1",
        title: "Refactor backend request path",
        description: "Replace transport layer",
        state: "Todo",
        url: "https://example.org/issues/S-1",
        labels: ["backend"],
      },
      { attempt: 3 },
    );

    expect(prompt).toContain("Ticket S-1 Refactor backend request path");
    expect(prompt).toContain("labels=backend");
    expect(prompt).toContain("attempt=3");
  });

  test("renders issue datetime fields without crashing", async () => {
    await writeWorkflowFile(workflowPath, {
      prompt: "Ticket {{ issue.identifier }} created={{ issue.created_at }} updated={{ issue.updated_at }}",
    });

    const prompt = await buildPrompt({
      identifier: "MT-697",
      title: "Live smoke",
      description: "Prompt should serialize datetimes",
      state: "Todo",
      url: "https://example.org/issues/MT-697",
      labels: [],
      createdAt: new Date("2026-02-26T18:06:48Z"),
      updatedAt: new Date("2026-02-26T18:07:03Z"),
    });

    expect(prompt).toContain("Ticket MT-697");
    expect(prompt).toContain("created=2026-02-26T18:06:48.000Z");
    expect(prompt).toContain("updated=2026-02-26T18:07:03.000Z");
  });

  test("normalizes nested date-like values and maps in issue fields", async () => {
    await writeWorkflowFile(workflowPath, {
      prompt: "Ticket {{ issue.identifier }} blocker={{ issue.blocked_by[0].createdAt }} meta={{ issue.metadata.startedAt }}",
    });

    const issue = {
      identifier: "MT-701",
      title: "Serialize nested values",
      description: "Prompt builder should normalize nested values",
      state: "Todo",
      url: "https://example.org/issues/MT-701",
      labels: ["prompt"],
      blockedBy: [{ id: "issue-1", identifier: "MT-700", state: "Done", createdAt: new Date("2026-02-27T12:34:56Z") } as any],
      metadata: { startedAt: new Date("2026-02-28T01:02:03Z") } as any,
    } as Issue;
    const prompt = await buildPrompt(issue);

    expect(prompt).toContain("Ticket MT-701");
    expect(prompt).toContain("blocker=2026-02-27T12:34:56.000Z");
    expect(prompt).toContain("meta=2026-02-28T01:02:03.000Z");
  });

  test("uses strict variable rendering and surfaces invalid templates", async () => {
    const issue: Issue = {
      identifier: "MT-123",
      title: "Investigate broken sync",
      description: "Reproduce and fix",
      state: "In Progress",
      url: "https://example.org/issues/MT-123",
      labels: ["bug"],
    };

    await writeWorkflowFile(workflowPath, {
      prompt: "Work on ticket {{ missing.ticket_id }} and follow these steps.",
    });
    await expect(buildPrompt(issue)).rejects.toThrow();

    await writeWorkflowFile(workflowPath, { prompt: "{% if issue.identifier %}" });
    await expect(buildPrompt(issue)).rejects.toThrow(/template_parse_error:.*template=/s);
  });

  test("reports workflow load failures separately from template parse errors", async () => {
    setWorkflowFilePath(join(root, "missing-WORKFLOW.md"));
    await expect(
      buildPrompt({
        identifier: "MT-780",
        title: "Workflow unavailable",
        description: "Missing workflow file",
        state: "Todo",
        url: "https://example.org/issues/MT-780",
        labels: [],
      }),
    ).rejects.toThrow(/workflow_unavailable:/);
    await writeWorkflowFile(workflowPath);
  });

  test("uses a sensible default template when workflow prompt is blank", async () => {
    await writeWorkflowFile(workflowPath, { prompt: "   \n" });

    const prompt = await buildPrompt({
      identifier: "MT-777",
      title: "Make fallback prompt useful",
      description: "Include enough issue context to start working.",
      state: "In Progress",
      url: "https://example.org/issues/MT-777",
      labels: ["prompt"],
    });

    expect(prompt).toContain("You are working on a Linear issue.");
    expect(prompt).toContain("Identifier: MT-777");
    expect(prompt).toContain("Title: Make fallback prompt useful");
    expect(prompt).toContain("Body:");
    expect(prompt).toContain("Include enough issue context to start working.");

    await writeWorkflowFile(workflowPath, { prompt: "" });
    const noBody = await buildPrompt({
      identifier: "MT-778",
      title: "Handle empty body",
      description: null,
      state: "Todo",
      url: "https://example.org/issues/MT-778",
      labels: [],
    });
    expect(noBody).toContain("No description provided.");
  });

  test("in-repo WORKFLOW.md renders correctly", async () => {
    const originalWorkflowPath = workflowPath;
    clearWorkflowFilePath();

    try {
      const prompt = await buildPrompt(
        {
          identifier: "MT-616",
          title: "Use rich templates for WORKFLOW.md",
          description: "Render with rich template variables",
          state: "In Progress",
          url: "https://example.org/issues/MT-616/use-rich-templates-for-workflowmd",
          labels: ["templating", "workflow"],
        },
        { attempt: 2 },
      );

      expect(prompt).toContain("You are working on a GitHub issue `MT-616`");
      expect(prompt).toContain("Issue context:");
      expect(prompt).toContain("Identifier: MT-616");
      expect(prompt).toContain("Title: Use rich templates for WORKFLOW.md");
      expect(prompt).toContain("Current status: In Progress");
      expect(prompt).toContain("https://example.org/issues/MT-616/use-rich-templates-for-workflowmd");
      expect(prompt).toContain("This is an unattended orchestration session.");
      expect(prompt).toContain("Only stop early for a true blocker");
      expect(prompt).toContain('Do not include "next steps for user"');
      expect(prompt).toContain("Continuation context:");
      expect(prompt).toContain("retry attempt #2");

      const config = await settings();
      expect(config.tracker.kind).toBe("github");
      expect(config.tracker.project_slug).toBe("openai/symphony");
      expect(config.tracker.active_states).toEqual(["open"]);
      expect(config.tracker.terminal_states).toEqual(["closed"]);
    } finally {
      await writeWorkflowFile(originalWorkflowPath);
    }
  });
});

describe("cli evaluate", () => {
  test("returns the guardrails acknowledgement banner when the flag is missing", async () => {
    const calls: string[] = [];
    const deps = depsWithCalls(calls);

    const result = await evaluateCli(["WORKFLOW.md"], deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("This Symphony implementation is a low key engineering preview.");
      expect(result.error).toContain("Codex will run without any guardrails.");
      expect(result.error).toContain("SymphonyElixir is not a supported product and is presented as-is.");
      expect(result.error).toContain(ACK_FLAG);
    }
    expect(calls).toEqual([]);
  });

  test("defaults to WORKFLOW.md and accepts explicit workflow path overrides", async () => {
    let result = await evaluateCli([ACK_FLAG], {
      ...depsWithCalls([]),
      fileRegular: async (path) => basename(path) === "WORKFLOW.md",
    });
    expect(result).toEqual({ ok: true, value: undefined });

    const calls: string[] = [];
    const workflowPath = "tmp/custom/WORKFLOW.md";
    const expandedPath = resolve(workflowPath);
    result = await evaluateCli([ACK_FLAG, workflowPath], {
      ...depsWithCalls(calls),
      fileRegular: async (path) => path === expandedPath,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toContain(`workflow:${expandedPath}`);
  });

  test("accepts --logs-root and returns not found or startup errors", async () => {
    const calls: string[] = [];
    let result = await evaluateCli([ACK_FLAG, "--logs-root", "tmp/custom-logs", "WORKFLOW.md"], depsWithCalls(calls));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toContain(`logs:${resolve("tmp/custom-logs")}`);

    result = await evaluateCli([ACK_FLAG, "WORKFLOW.md"], { ...depsWithCalls([]), fileRegular: async () => false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Workflow file not found:");

    result = await evaluateCli([ACK_FLAG, "WORKFLOW.md"], {
      ...depsWithCalls([]),
      ensureAllStarted: async () => ({ ok: false, error: "boom" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to start Symphony with workflow");
      expect(result.error).toContain("boom");
    }
  });

  test("accepts --port and rejects invalid port values", async () => {
    const calls: string[] = [];
    let result = await evaluateCli([ACK_FLAG, "--port", "4157", "WORKFLOW.md"], depsWithCalls(calls));
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toContain("port:4157");

    result = await evaluateCli([ACK_FLAG, "--port", "not-a-port", "WORKFLOW.md"], depsWithCalls([]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Usage: symphony");
  });
});

function depsWithCalls(calls: string[]): CliDeps {
  return {
    fileRegular: async () => true,
    setWorkflowFilePath: async (path) => {
      calls.push(`workflow:${path}`);
    },
    setLogsRoot: async (path) => {
      calls.push(`logs:${path}`);
    },
    setServerPortOverride: async (port) => {
      calls.push(`port:${port}`);
    },
    ensureAllStarted: async () => {
      calls.push("started");
      return { ok: true, value: ["symphony"] };
    },
  };
}
