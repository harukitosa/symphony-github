import { cwd } from "node:process";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { err, ok, type Result } from "./result";

export type WorkflowDefinition = {
  config: Record<string, unknown>;
  prompt: string;
  promptTemplate: string;
};

let workflowPathOverride: string | undefined;

export function workflowFilePath(): string {
  return workflowPathOverride ?? join(cwd(), "WORKFLOW.md");
}

export function setWorkflowFilePath(path: string): void {
  workflowPathOverride = path;
}

export function clearWorkflowFilePath(): void {
  workflowPathOverride = undefined;
}

export async function loadWorkflow(path = workflowFilePath()): Promise<Result<WorkflowDefinition, unknown>> {
  try {
    return parseWorkflow(await readFile(path, "utf8"));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? error;
    return err({ type: "missing_workflow_file", path, reason });
  }
}

export function parseWorkflow(content: string): Result<WorkflowDefinition, unknown> {
  const { frontMatter, promptLines } = splitFrontMatter(content);
  const yaml = frontMatter.join("\n").trim();

  let config: unknown = {};
  if (yaml !== "") {
    try {
      config = YAML.parse(yaml);
    } catch (error) {
      return err({ type: "workflow_parse_error", reason: error });
    }
  }

  if (config === null) config = {};
  if (!isPlainRecord(config)) return err("workflow_front_matter_not_a_map");

  const prompt = promptLines.join("\n").trim();
  return ok({ config, prompt, promptTemplate: prompt });
}

function splitFrontMatter(content: string): { frontMatter: string[]; promptLines: string[] } {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines[0] !== "---") return { frontMatter: [], promptLines: lines };

  const frontMatter: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      return { frontMatter, promptLines: lines.slice(index + 1) };
    }
    frontMatter.push(lines[index] ?? "");
  }

  return { frontMatter, promptLines: [] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
