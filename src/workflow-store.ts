import { readFile, stat } from "node:fs/promises";
import { loadWorkflow, workflowFilePath, type WorkflowDefinition } from "./workflow";
import { err, ok, type Result } from "./result";

type WorkflowStamp = {
  mtimeMs: number;
  size: number;
  hash: number;
};

type WorkflowStoreState = {
  path: string;
  stamp: WorkflowStamp;
  workflow: WorkflowDefinition;
};

export class WorkflowStore {
  #state: WorkflowStoreState;

  private constructor(state: WorkflowStoreState) {
    this.#state = state;
  }

  static async start(path = workflowFilePath()): Promise<Result<WorkflowStore, unknown>> {
    const state = await loadState(path);
    return state.ok ? ok(new WorkflowStore(state.value)) : state;
  }

  current(): Result<WorkflowDefinition, unknown> {
    return ok(this.#state.workflow);
  }

  async forceReload(): Promise<Result<void, unknown>> {
    const reloaded = await this.#reload();
    return reloaded.ok ? ok(undefined) : err(reloaded.error);
  }

  async poll(): Promise<Result<void, unknown>> {
    const reloaded = await this.#reload();
    return reloaded.ok ? ok(undefined) : err(reloaded.error);
  }

  async #reload(): Promise<Result<WorkflowStoreState, unknown>> {
    const path = workflowFilePath();
    if (path !== this.#state.path) return this.#reloadPath(path);

    const stamp = await currentStamp(path);
    if (!stamp.ok) return err(stamp.error);
    if (sameStamp(stamp.value, this.#state.stamp)) return ok(this.#state);
    return this.#reloadPath(path);
  }

  async #reloadPath(path: string): Promise<Result<WorkflowStoreState, unknown>> {
    const state = await loadState(path);
    if (state.ok) this.#state = state.value;
    return state;
  }
}

async function loadState(path: string): Promise<Result<WorkflowStoreState, unknown>> {
  const workflow = await loadWorkflow(path);
  if (!workflow.ok) return workflow;
  const stamp = await currentStamp(path);
  if (!stamp.ok) return stamp;
  return ok({ path, stamp: stamp.value, workflow: workflow.value });
}

async function currentStamp(path: string): Promise<Result<WorkflowStamp, unknown>> {
  try {
    const [stats, content] = await Promise.all([stat(path), readFile(path)]);
    return ok({ mtimeMs: stats.mtimeMs, size: stats.size, hash: hashBuffer(content) });
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? error;
    return err({ type: "missing_workflow_file", path, reason });
  }
}

function sameStamp(left: WorkflowStamp, right: WorkflowStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size && left.hash === right.hash;
}

function hashBuffer(buffer: Buffer): number {
  let hash = 0;
  for (const byte of buffer) {
    hash = ((hash << 5) - hash + byte) | 0;
  }
  return hash;
}
