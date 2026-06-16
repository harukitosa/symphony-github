import { lstat, mkdir, readlink, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { err, ok, type Result } from "./result";
import { settings } from "./config";
import { runSsh } from "./ssh";

export type WorkspaceError =
  | { type: "workspace_equals_root"; workspace: string; root: string }
  | { type: "workspace_outside_root"; workspace: string; root: string }
  | { type: "workspace_symlink_escape"; workspace: string; root: string }
  | { type: "workspace_path_unreadable"; path: string; reason: unknown }
  | { type: "workspace_hook_failed"; hook: string; status: number; output: string }
  | { type: "workspace_hook_timeout"; hook: string; timeoutMs: number }
  | { type: "workspace_prepare_failed"; workerHost: string; status: number | null; output: string }
  | { type: "workspace_remove_failed"; workerHost: string; status: number | null; output: string }
  | { type: "remote_workspace_parse_failed"; output: string };

const REMOTE_WORKSPACE_MARKER = "__SYMPHONY_WORKSPACE__";

export async function canonicalize(path: string): Promise<string> {
  const expanded = resolve(path);
  const root = parse(expanded).root;
  const rest = expanded.slice(root.length).split("/").filter(Boolean);
  return resolveSegments(root, [], rest);
}

export async function createWorkspaceForIssue(
  identifier: string | null | undefined,
  workerHost: string | null = null,
): Promise<Result<string, WorkspaceError>> {
  const config = await settings();
  const safeId = safeIdentifier(identifier);
  if (isWorkerHost(workerHost)) {
    const workspace = join(config.workspace.root, safeId);
    const prepared = await ensureRemoteWorkspace(workspace, workerHost);
    if (!prepared.ok) return prepared;
    if (prepared.value.created && config.hooks.after_create !== null) {
      const hook = await runRemoteHook(config.hooks.after_create, prepared.value.workspace, "after_create", workerHost);
      if (!hook.ok) return hook;
    }
    return ok(prepared.value.workspace);
  }

  const workspace = await canonicalize(join(config.workspace.root, safeId));
  const validation = await validateWorkspacePath(workspace, config.workspace.root);
  if (!validation.ok) return validation;

  const created = await ensureWorkspace(workspace);
  if (created && config.hooks.after_create !== null) {
    const hook = await runHook(config.hooks.after_create, workspace, "after_create", config.hooks.timeout_ms);
    if (!hook.ok) return hook;
  }

  return ok(workspace);
}

export async function removeWorkspace(
  workspace: string,
  workerHost: string | null = null,
): Promise<Result<string[], WorkspaceError> | { ok: false; error: WorkspaceError; output: string }> {
  const config = await settings();
  if (isWorkerHost(workerHost)) {
    if (config.hooks.before_remove !== null) {
      await runRemoteHook(config.hooks.before_remove, workspace, "before_remove", workerHost);
    }
    const removed = await runRemoteCommand(workerHost, `${remoteShellAssign("workspace", workspace)}\nrm -rf "$workspace"`);
    if (!removed.ok) return { ok: false, error: removed.error, output: "" };
    if (removed.value.exitCode !== 0) {
      return {
        ok: false,
        error: {
          type: "workspace_remove_failed",
          workerHost,
          status: removed.value.exitCode,
          output: removed.value.stdout + removed.value.stderr,
        },
        output: "",
      };
    }
    return ok([]);
  }

  if (!(await exists(workspace))) return ok([]);

  const validation = await validateWorkspacePath(workspace, config.workspace.root);
  if (!validation.ok) return { ...validation, output: "" };

  if (config.hooks.before_remove !== null) {
    await runHook(config.hooks.before_remove, workspace, "before_remove", config.hooks.timeout_ms);
  }

  await rm(workspace, { recursive: true, force: true });
  return ok([]);
}

export async function removeIssueWorkspaces(identifier: unknown, workerHost: string | null = null): Promise<void> {
  if (typeof identifier !== "string") return;
  const config = await settings();
  if (isWorkerHost(workerHost)) {
    await removeWorkspace(join(config.workspace.root, safeIdentifier(identifier)), workerHost);
    return;
  }
  if (config.worker.ssh_hosts.length > 0) {
    await Promise.all(config.worker.ssh_hosts.map((host) => removeIssueWorkspaces(identifier, host)));
    return;
  }
  const workspace = await canonicalize(join(config.workspace.root, safeIdentifier(identifier)));
  await removeWorkspace(workspace);
}

export async function runBeforeRunHook(
  workspace: string,
  _identifier: unknown,
  workerHost: string | null = null,
): Promise<Result<void, WorkspaceError>> {
  const config = await settings();
  if (config.hooks.before_run === null) return ok(undefined);
  return isWorkerHost(workerHost)
    ? runRemoteHook(config.hooks.before_run, workspace, "before_run", workerHost)
    : runHook(config.hooks.before_run, workspace, "before_run", config.hooks.timeout_ms);
}

export async function runAfterRunHook(
  workspace: string,
  _identifier: unknown,
  workerHost: string | null = null,
): Promise<Result<void, WorkspaceError>> {
  const config = await settings();
  if (config.hooks.after_run === null) return ok(undefined);
  const result = isWorkerHost(workerHost)
    ? await runRemoteHook(config.hooks.after_run, workspace, "after_run", workerHost)
    : await runHook(config.hooks.after_run, workspace, "after_run", config.hooks.timeout_ms);
  return result.ok ? result : ok(undefined);
}

async function validateWorkspacePath(workspace: string, root: string): Promise<Result<string, WorkspaceError>> {
  const expandedWorkspace = resolve(workspace);
  const expandedRoot = resolve(root);

  let canonicalWorkspace: string;
  let canonicalRoot: string;
  try {
    canonicalWorkspace = await canonicalize(expandedWorkspace);
    canonicalRoot = await canonicalize(expandedRoot);
  } catch (reason) {
    return err({ type: "workspace_path_unreadable", path: expandedWorkspace, reason });
  }

  if (canonicalWorkspace === canonicalRoot) {
    return err({ type: "workspace_equals_root", workspace: canonicalWorkspace, root: canonicalRoot });
  }
  if (isUnder(canonicalWorkspace, canonicalRoot)) return ok(canonicalWorkspace);
  if (isUnder(expandedWorkspace, expandedRoot)) {
    return err({ type: "workspace_symlink_escape", workspace: expandedWorkspace, root: canonicalRoot });
  }
  return err({ type: "workspace_outside_root", workspace: canonicalWorkspace, root: canonicalRoot });
}

async function ensureWorkspace(workspace: string): Promise<boolean> {
  try {
    const stat = await lstat(workspace);
    if (stat.isDirectory()) return false;
    await rm(workspace, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(workspace, { recursive: true });
  return true;
}

async function ensureRemoteWorkspace(
  workspace: string,
  workerHost: string,
): Promise<Result<{ workspace: string; created: boolean }, WorkspaceError>> {
  const script = [
    "set -eu",
    remoteShellAssign("workspace", workspace),
    'if [ -d "$workspace" ]; then',
    "  created=0",
    'elif [ -e "$workspace" ]; then',
    '  rm -rf "$workspace"',
    '  mkdir -p "$workspace"',
    "  created=1",
    "else",
    '  mkdir -p "$workspace"',
    "  created=1",
    "fi",
    'cd "$workspace"',
    `printf '%s\\t%s\\t%s\\n' '${REMOTE_WORKSPACE_MARKER}' "$created" "$(pwd -P)"`,
  ].join("\n");
  const result = await runRemoteCommand(workerHost, script);
  if (!result.ok) return result;
  const output = result.value.stdout + result.value.stderr;
  if (result.value.exitCode !== 0) {
    return err({ type: "workspace_prepare_failed", workerHost, status: result.value.exitCode, output });
  }
  return parseRemoteWorkspaceOutput(output);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runRemoteHook(
  command: string,
  workspace: string,
  hook: string,
  workerHost: string,
): Promise<Result<void, WorkspaceError>> {
  const result = await runRemoteCommand(workerHost, `cd ${shellEscape(workspace)} && ${command}`);
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err({
      type: "workspace_hook_failed",
      hook,
      status: result.value.exitCode ?? 1,
      output: result.value.stdout + result.value.stderr,
    });
  }
  return ok(undefined);
}

async function runRemoteCommand(
  workerHost: string,
  script: string,
): Promise<Result<{ stdout: string; stderr: string; exitCode: number | null }, WorkspaceError>> {
  const result = await runSsh(workerHost, script);
  if (!result.ok) {
    return err({ type: "workspace_hook_failed", hook: "remote_command", status: 1, output: String(result.error) });
  }
  return result;
}

async function runHook(
  command: string,
  cwd: string,
  hook: string,
  timeoutMs: number,
): Promise<Result<void, WorkspaceError>> {
  const child = spawn("sh", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const status = await new Promise<number | "timeout">((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise("timeout");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise(code ?? 1);
    });
  });

  if (status === "timeout") return err({ type: "workspace_hook_timeout", hook, timeoutMs });
  if (status !== 0) return err({ type: "workspace_hook_failed", hook, status, output });
  return ok(undefined);
}

async function resolveSegments(root: string, resolved: string[], remaining: string[]): Promise<string> {
  if (remaining.length === 0) return join(root, ...resolved);

  const [segment, ...rest] = remaining;
  if (segment === undefined) return join(root, ...resolved);
  const candidate = join(root, ...resolved, segment);

  try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      const target = await readlink(candidate);
      const targetPath = isAbsolute(target) ? target : resolve(dirname(candidate), target);
      const parsed = parse(targetPath);
      const targetSegments = targetPath.slice(parsed.root.length).split("/").filter(Boolean);
      return resolveSegments(parsed.root, [], [...targetSegments, ...rest]);
    }
    return resolveSegments(root, [...resolved, segment], rest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(root, ...resolved, segment, ...rest);
    throw error;
  }
}

function parseRemoteWorkspaceOutput(output: string): Result<{ workspace: string; created: boolean }, WorkspaceError> {
  for (const line of output.split(/\r?\n/)) {
    const [marker, created, workspace] = line.split("\t");
    if (marker === REMOTE_WORKSPACE_MARKER && (created === "0" || created === "1") && workspace !== undefined && workspace !== "") {
      return ok({ workspace, created: created === "1" });
    }
  }
  return err({ type: "remote_workspace_parse_failed", output });
}

function remoteShellAssign(variableName: string, rawPath: string): string {
  return `${variableName}=${shellEscape(rawPath)}\ncase "$${variableName}" in ~/*) ${variableName}="$HOME/\${${variableName}#~/}" ;; esac`;
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeIdentifier(identifier: string | null | undefined): string {
  return (identifier ?? "issue").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isWorkerHost(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
