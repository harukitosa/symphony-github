import { Liquid } from "liquidjs";
import { loadWorkflow } from "./workflow";
import { workflowPrompt } from "./config";
import type { Issue } from "./linear";

const liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export async function buildPrompt(issue: Issue, opts: { attempt?: number | null } = {}): Promise<string> {
  const loaded = await loadWorkflow();
  if (!loaded.ok) throw new Error(`workflow_unavailable: ${JSON.stringify(loaded.error)}`);

  const rawTemplate = loaded.value.promptTemplate.trim() === "" ? await workflowPrompt() : loaded.value.promptTemplate;
  let template;
  try {
    template = liquid.parse(rawTemplate);
  } catch (error) {
    throw new Error(`template_parse_error: ${(error as Error).message} template=${JSON.stringify(rawTemplate)}`);
  }

  return liquid.render(template, {
    attempt: opts.attempt ?? null,
    issue: issueToTemplateMap(issue),
  });
}

function issueToTemplateMap(issue: Issue): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    mapped[key] = toTemplateValue(value);
  }

  mapped.branch_name = toTemplateValue(issue.branchName);
  mapped.assignee_id = toTemplateValue(issue.assigneeId);
  mapped.blocked_by = toTemplateValue(issue.blockedBy ?? []);
  mapped.assigned_to_worker = issue.assignedToWorker ?? true;
  mapped.created_at = toTemplateValue(issue.createdAt);
  mapped.updated_at = toTemplateValue(issue.updatedAt);
  return mapped;
}

function toTemplateValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toTemplateValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toTemplateValue(nested)]));
  }
  return value;
}
