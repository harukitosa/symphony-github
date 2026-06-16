---
tracker:
  kind: github
  project_slug: openai/symphony
  required_labels: []
  active_states:
    - open
  terminal_states:
    - closed
polling:
  interval_ms: 5000
workspace:
  root: ~/code/symphony-github-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/openai/symphony .
    bun install
  before_remove: null
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
---

You are working on a GitHub issue `{{ issue.identifier }}`

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the issue is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless you are blocked by missing required permissions/secrets.
{% endif %}

Issue context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human to perform follow-up actions.
2. Only stop early for a true blocker (missing required auth/permissions/secrets). If blocked, record the blocker in the workpad and move the issue according to workflow.
3. Final message must report completed actions and blockers only. Do not include "next steps for user".

Work only in the provided repository copy. Do not touch any other path.

## Prerequisite: GitHub access or `github_rest` compatibility tool is available

The agent should be able to inspect and update the issue tracker used by this Symphony run. If no tracker access is present, stop only after exhausting documented local fallbacks.

## Default posture

- Start by determining the issue's current status, then follow the matching flow for that status.
- Start every task by opening the tracking workpad comment and bringing it up to date before doing new implementation work.
- Spend extra effort up front on planning and verification design before implementation.
- Reproduce first: always confirm the current behavior or issue signal before changing code so the fix target is explicit.
- Keep issue metadata current.
- Treat a single persistent workpad comment as the source of truth for progress.
- Run `bun test` and `bun run typecheck` before handoff.

## Status map

- `open` -> active work may be dispatched. Use issue comments, labels, linked PRs, and local workpad state to determine the current substage.
- `closed` -> terminal state; no further action required.
