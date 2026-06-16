import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, basename } from "node:path";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { $ } from "bun";
import { cleanup, makeTempRoot, writeWorkflowFile } from "./support";
import { clearWorkflowFilePath } from "../src/workflow";
import {
  canonicalize,
  createWorkspaceForIssue,
  removeIssueWorkspaces,
  removeWorkspace,
  runAfterRunHook,
  runBeforeRunHook,
} from "../src/workspace";

let root: string;
let workflowPath: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-workspace");
  workflowPath = join(root, "WORKFLOW.md");
  await writeWorkflowFile(workflowPath);
});

afterEach(async () => {
  clearWorkflowFilePath();
  await cleanup(root);
});

describe("workspace", () => {
  test("workspace bootstrap can be implemented in after_create hook", async () => {
    const templateRepo = join(root, "source");
    const workspaceRoot = join(root, "workspaces");
    await mkdir(join(templateRepo, "keep"), { recursive: true });
    await writeFile(join(templateRepo, "README.md"), "hook clone\n");
    await writeFile(join(templateRepo, "keep", "file.txt"), "keep me");
    await $`git -C ${templateRepo} init -b main`.quiet();
    await $`git -C ${templateRepo} config user.name "Test User"`.quiet();
    await $`git -C ${templateRepo} config user.email "test@example.com"`.quiet();
    await $`git -C ${templateRepo} add README.md keep/file.txt`.quiet();
    await $`git -C ${templateRepo} commit -m initial`.quiet();

    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { after_create: `git clone --depth 1 ${templateRepo} .` },
    });

    const workspace = await createWorkspaceForIssue("S-1");
    expect(workspace.ok).toBe(true);
    if (workspace.ok) {
      expect(existsSync(join(workspace.value, ".git"))).toBe(true);
      expect(await readFile(join(workspace.value, "README.md"), "utf8")).toBe("hook clone\n");
      expect(await readFile(join(workspace.value, "keep", "file.txt"), "utf8")).toBe("keep me");
    }
  });

  test("workspace path is deterministic per issue identifier", async () => {
    const workspaceRoot = join(root, "deterministic");
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    const first = await createWorkspaceForIssue("MT/Det");
    const second = await createWorkspaceForIssue("MT/Det");

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value).toBe(second.value);
      expect(basename(first.value)).toBe("MT_Det");
    }
  });

  test("workspace reuses existing issue directory without deleting local changes", async () => {
    const workspaceRoot = join(root, "reuse");
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { after_create: "echo first > README.md" },
    });

    const first = await createWorkspaceForIssue("MT-REUSE");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("workspace creation failed");

    await writeFile(join(first.value, "README.md"), "changed\n");
    await writeFile(join(first.value, "local-progress.txt"), "in progress\n");
    await mkdir(join(first.value, "deps"), { recursive: true });
    await writeFile(join(first.value, "deps", "cache.txt"), "cached deps\n");

    const second = await createWorkspaceForIssue("MT-REUSE");
    expect(second).toEqual(first);
    expect(await readFile(join(first.value, "README.md"), "utf8")).toBe("changed\n");
    expect(await readFile(join(first.value, "local-progress.txt"), "utf8")).toBe("in progress\n");
    expect(await readFile(join(first.value, "deps", "cache.txt"), "utf8")).toBe("cached deps\n");
  });

  test("workspace replaces stale non-directory paths", async () => {
    const workspaceRoot = join(root, "stale");
    const staleWorkspace = join(workspaceRoot, "MT-STALE");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(staleWorkspace, "old state\n");
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    const expected = await canonicalize(staleWorkspace);
    const workspace = await createWorkspaceForIssue("MT-STALE");
    expect(workspace).toEqual({ ok: true, value: expected });
    expect(existsSync(staleWorkspace)).toBe(true);
  });

  test("workspace rejects symlink escapes under the configured root", async () => {
    const workspaceRoot = join(root, "workspaces");
    const outsideRoot = join(root, "outside");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, join(workspaceRoot, "MT-SYM"));
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    const workspace = await createWorkspaceForIssue("MT-SYM");
    expect(workspace.ok).toBe(false);
    if (!workspace.ok) {
      expect(workspace.error).toEqual({
        type: "workspace_outside_root",
        workspace: await canonicalize(outsideRoot),
        root: await canonicalize(workspaceRoot),
      });
    }
  });

  test("workspace canonicalizes symlinked roots before creating issue directories", async () => {
    const actualRoot = join(root, "actual-workspaces");
    const linkedRoot = join(root, "linked-workspaces");
    await mkdir(actualRoot, { recursive: true });
    await symlink(actualRoot, linkedRoot);
    await writeWorkflowFile(workflowPath, { workspace: { root: linkedRoot } });

    const expected = await canonicalize(join(actualRoot, "MT-LINK"));
    const workspace = await createWorkspaceForIssue("MT-LINK");
    expect(workspace).toEqual({ ok: true, value: expected });
  });

  test("workspace remove rejects the workspace root itself with a distinct error", async () => {
    const workspaceRoot = join(root, "root-remove");
    await mkdir(workspaceRoot, { recursive: true });
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });
    const canonicalRoot = await canonicalize(workspaceRoot);

    expect(await removeWorkspace(workspaceRoot)).toEqual({
      ok: false,
      error: { type: "workspace_equals_root", workspace: canonicalRoot, root: canonicalRoot },
      output: "",
    });
  });

  test("workspace surfaces after_create hook failures and timeouts", async () => {
    const workspaceRoot = join(root, "hook-failure");
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { after_create: "echo nope && exit 17" },
    });

    let result = await createWorkspaceForIssue("MT-FAIL");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ type: "workspace_hook_failed", hook: "after_create", status: 17 });
    }

    await rm(workspaceRoot, { recursive: true, force: true });
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { timeout_ms: 10, after_create: "sleep 1" },
    });
    result = await createWorkspaceForIssue("MT-TIMEOUT");
    expect(result).toEqual({
      ok: false,
      error: { type: "workspace_hook_timeout", hook: "after_create", timeoutMs: 10 },
    });
  });

  test("workspace creates empty directories and removes issue workspaces", async () => {
    const workspaceRoot = join(root, "cleanup");
    await writeWorkflowFile(workflowPath, { workspace: { root: workspaceRoot } });

    const workspace = await createWorkspaceForIssue("MT-608");
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) throw new Error("workspace creation failed");
    expect(existsSync(workspace.value)).toBe(true);

    await writeFile(join(workspace.value, "marker.txt"), "stale");
    const untouched = join(workspaceRoot, "OTHER");
    await mkdir(untouched, { recursive: true });
    await writeFile(join(untouched, "marker.txt"), "keep");

    await removeIssueWorkspaces("MT-608");
    expect(existsSync(workspace.value)).toBe(false);
    expect(existsSync(untouched)).toBe(true);
    await expect(removeIssueWorkspaces(null)).resolves.toBeUndefined();
  });

  test("workspace remove returns ok for missing directory", async () => {
    const randomPath = join(root, "missing-workspace");
    expect(await removeWorkspace(randomPath)).toEqual({ ok: true, value: [] });
  });

  test("workspace hooks support multiline YAML scripts and run at lifecycle boundaries", async () => {
    const workspaceRoot = join(root, "hook-lifecycle-workspaces");
    const beforeRemoveMarker = join(root, "before_remove.log");
    const afterCreateCounter = join(root, "after_create.count");
    await mkdir(workspaceRoot, { recursive: true });

    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: {
        after_create: `echo after_create > after_create.log\necho call >> "${afterCreateCounter}"`,
        before_remove: `echo before_remove > "${beforeRemoveMarker}"`,
      },
    });

    const created = await createWorkspaceForIssue("MT-HOOKS");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("workspace creation failed");
    expect(await readFile(join(created.value, "after_create.log"), "utf8")).toBe("after_create\n");

    const reused = await createWorkspaceForIssue("MT-HOOKS");
    expect(reused).toEqual(created);
    expect((await readFile(afterCreateCounter, "utf8")).trim().split("\n")).toHaveLength(1);

    await removeIssueWorkspaces("MT-HOOKS");
    expect(await readFile(beforeRemoveMarker, "utf8")).toBe("before_remove\n");
    expect(existsSync(created.value)).toBe(false);
  });

  test("workspace remove continues when before_remove hook fails or times out", async () => {
    const workspaceRoot = join(root, "hook-fail-workspaces");
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { before_remove: "echo failure && exit 17" },
    });

    let created = await createWorkspaceForIssue("MT-HOOKS-FAIL");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("workspace creation failed");
    await removeIssueWorkspaces("MT-HOOKS-FAIL");
    expect(existsSync(created.value)).toBe(false);

    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      hooks: { timeout_ms: 10, before_remove: "sleep 1" },
    });
    created = await createWorkspaceForIssue("MT-HOOKS-TIMEOUT");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("workspace creation failed");
    await removeIssueWorkspaces("MT-HOOKS-TIMEOUT");
    expect(existsSync(created.value)).toBe(false);
  });

  test("remote workspace lifecycle uses ssh host aliases from worker config", async () => {
    const previousPath = process.env.PATH;
    const traceFile = join(root, "ssh.trace");
    const fakeSsh = join(root, "ssh");
    const workspaceRoot = "~/.symphony-remote-workspaces";
    const workspacePath = "/remote/home/.symphony-remote-workspaces/MT-SSH-WS";
    await writeFile(
      fakeSsh,
      `#!/bin/sh
trace_file="${traceFile}"
printf 'ARGV:%s\\n' "$*" >> "$trace_file"
case "$*" in
  *"__SYMPHONY_WORKSPACE__"*)
    printf '%s\\t%s\\t%s\\n' '__SYMPHONY_WORKSPACE__' '1' '${workspacePath}'
    ;;
esac
exit 0
`,
    );
    await chmod(fakeSsh, 0o755);
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    await writeWorkflowFile(workflowPath, {
      workspace: { root: workspaceRoot },
      worker: { ssh_hosts: ["worker-01:2200"] },
      hooks: {
        before_run: "echo before-run",
        after_run: "echo after-run",
        before_remove: "echo before-remove",
      },
    });

    try {
      expect(await createWorkspaceForIssue("MT-SSH-WS", "worker-01:2200")).toEqual({ ok: true, value: workspacePath });
      expect(await runBeforeRunHook(workspacePath, "MT-SSH-WS", "worker-01:2200")).toEqual({ ok: true, value: undefined });
      expect(await runAfterRunHook(workspacePath, "MT-SSH-WS", "worker-01:2200")).toEqual({ ok: true, value: undefined });
      await removeIssueWorkspaces("MT-SSH-WS", "worker-01:2200");

      const trace = await readFile(traceFile, "utf8");
      expect(trace).toContain("-p 2200 worker-01 bash -lc");
      expect(trace).toContain("__SYMPHONY_WORKSPACE__");
      expect(trace).toContain("~/.symphony-remote-workspaces/MT-SSH-WS");
      expect(trace).toContain("${workspace#~/}");
      expect(trace).toContain("echo before-run");
      expect(trace).toContain("echo after-run");
      expect(trace).toContain("echo before-remove");
      expect(trace).toContain("rm -rf");
      expect(trace).toContain(workspacePath);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
