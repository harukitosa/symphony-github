# Symphony GitHub

TypeScript/Bun implementation of an issue-driven Codex orchestration runner, adapted for GitHub Issues.

This repository was created as a GitHub-oriented TypeScript/Bun port based on the upstream
[openai/symphony](https://github.com/openai/symphony) project. The original implementation and
workflow model come from OpenAI Symphony; this version keeps the same core orchestration idea while
using GitHub Issues and GitHub REST APIs as the primary tracker surface.

> Prototype software. Review the workflow, sandbox, and repository permissions before using it on
> production repositories.

## What It Does

Symphony GitHub continuously turns tracker issues into isolated Codex work sessions:

1. Polls GitHub Issues for candidate work
2. Creates a dedicated workspace for each issue
3. Starts Codex in app-server mode inside that workspace
4. Sends a workflow prompt rendered from `WORKFLOW.md`
5. Keeps working across turns until the issue leaves an active state or becomes blocked

It also exposes a `github_rest` dynamic tool to Codex app-server sessions, so agents can inspect and
update repository data through the configured GitHub REST API.

## GitHub-Oriented Features

- `tracker.kind: github` support
- GitHub token fallback via `GITHUB_TOKEN`
- Optional assignee routing via `GITHUB_ASSIGNEE`
- GitHub issue polling with pagination
- GitHub issue state updates with `state_reason`
- GitHub issue comments
- GitHub dependency blocker mapping through `blocked_by`
- GitHub repository dashboard links
- GitHub-only dynamic tool exposure in app-server sessions

Linear support remains in the codebase for parity with the upstream architecture, but this
repository is configured and documented as the GitHub version.

## Quick Start

Install dependencies:

```bash
bun install
```

Set GitHub authentication:

```bash
export GITHUB_TOKEN=your_github_token
```

Configure `WORKFLOW.md`:

```yaml
tracker:
  kind: github
  project_slug: owner/repo
  active_states:
    - open
  terminal_states:
    - closed
workspace:
  root: ~/code/symphony-github-workspaces
hooks:
  after_create: |
    git clone --depth 1 git@github.com:owner/repo.git .
    bun install
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
```

Run checks:

```bash
bun run typecheck
bun test
```

## Workflow Configuration

`WORKFLOW.md` is a YAML front matter file followed by a Markdown prompt template. The front matter
controls tracker access, workspace creation, Codex launch options, and runtime limits. The Markdown
body becomes the issue-specific prompt sent to Codex.

Important fields:

| Field | Purpose |
| --- | --- |
| `tracker.kind` | Use `github` for GitHub Issues |
| `tracker.project_slug` | Repository slug in `owner/repo` format |
| `tracker.required_labels` | Labels required before dispatching an issue |
| `tracker.active_states` | GitHub issue states eligible for work, usually `open` |
| `tracker.terminal_states` | States treated as complete, usually `closed` |
| `workspace.root` | Parent directory for per-issue workspaces |
| `hooks.after_create` | Bootstrap command for a fresh workspace |
| `codex.command` | Command used to launch Codex app-server |
| `agent.max_turns` | Maximum back-to-back turns per agent invocation |

## Runtime Behavior

- Open GitHub issues can be dispatched when they match routing rules.
- Closed issues are treated as terminal.
- Issues assigned to another configured assignee are skipped.
- Issues blocked by non-terminal GitHub dependencies are not dispatched.
- If Codex reports required input, approval, or MCP elicitation, the issue is kept in the blocked
  runtime map.
- If a running issue is closed or loses required labels, Symphony stops the worker and reconciles
  local state.

## Dynamic Tools

When the tracker is GitHub, app-server sessions receive only:

```text
github_rest
```

The tool accepts a REST method, repository-relative path, and optional JSON body. Requests are sent
to the configured GitHub API endpoint with the configured repository and token.

For Linear workflows, the equivalent dynamic tool is `linear_graphql`.

## Project Layout

```text
src/
  app-server.ts          Codex app-server wrapper and event handling
  config.ts              WORKFLOW.md parsing and runtime settings
  dynamic-tool.ts        github_rest and linear_graphql dynamic tools
  github.ts              GitHub tracker adapter
  linear.ts              Linear-compatible issue model and adapter helpers
  orchestrator.ts        Dispatch, retry, blocker, and reconciliation logic
  workspace.ts           Per-issue workspace lifecycle
  status-dashboard.ts    Terminal dashboard formatting
test/
  *.test.ts              Bun test coverage for runtime behavior
WORKFLOW.md              GitHub-oriented workflow template
```

## Validation Status

Current local verification:

```bash
bun run typecheck
bun test
```

At the time this README was added, the suite passed with:

```text
158 pass
0 fail
```

## Relationship To Upstream

This repository is intentionally derived from the upstream
[openai/symphony](https://github.com/openai/symphony) project:

- The orchestration model follows the upstream Symphony design.
- The GitHub tracker adapter replaces the default Linear-first workflow for this repository.
- Tests were ported and expanded so the TypeScript/Bun version preserves the important runtime
  behavior of the original implementation.

For the canonical project history and specification, refer to the upstream repository.
