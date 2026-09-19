# AI Dev Team Harness

AI Dev Team is a chat-native MCP delegation harness. Codex in the current conversation remains the leader: it discusses requirements, inspects the repository, creates bounded task contracts, and reviews diffs. Antigravity is the implementation worker.

The harness does not invoke Codex CLI, use a model gateway, plan autonomously, review autonomously, merge changes, or modify the user's target checkout.

## Workflow

1. You and Codex discuss the requirement and explicitly agree to implement it.
2. Codex calls `delegate_to_antigravity` with an objective, allowed paths, acceptance criteria, and validation commands.
3. The harness creates an isolated branch and Git worktree.
4. Antigravity implements the task.
5. Codex uses a bounded `wait_for_worker` call instead of repeatedly polling status.
6. The harness rejects denied actions, empty changes, out-of-scope files, and failed checks.
7. Codex reads the bounded diff and either requests a revision or prepares a cherry-pick handoff.
8. You explicitly decide whether to run the returned cherry-pick command.

Multiple workers may run concurrently only when their scopes are provably disjoint. The harness never auto-merges and never removes worktrees.

## Setup

```powershell
cd D:\AI-dev-team
npm install
npm run check
```

Diagnose the two local runtime prerequisites:

```powershell
node .\dist\cli.js doctor
```

The doctor checks only Antigravity CLI and Git. Codex authentication and model selection belong to the Codex app/session, not this harness.

## Register the MCP server

Build the project, then register this local stdio server in Codex:

```toml
[mcp_servers.ai_dev_team]
command = "node"
args = ["D:\\AI-dev-team\\dist\\mcp-server.js", "--config", "D:\\AI-dev-team\\harness.config.json"]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 900
default_tools_approval_mode = "writes"
```

Restart Codex after changing MCP configuration.

The server instructions require explicit user approval of the plan before
`delegate_to_antigravity` may be called. Read-only status and diff tools remain
available without weakening approval for worker, revision, cancellation, or
handoff mutations.

## MCP tools

- `delegate_to_antigravity`: create a bounded asynchronous worker in an isolated worktree.
- `list_workers`: list persisted delegations, optionally filtered by repository.
- `get_worker_status`: read current state and quota-oriented attempt metrics.
- `wait_for_worker`: wait for a terminal state or bounded timeout without repeated Codex polling.
- `get_worker_result`: read the terminal worker result and validation evidence.
- `get_worker_diff`: return a size-bounded Git diff, including untracked files.
- `request_worker_revision`: resume the same Antigravity conversation with review feedback.
- `prepare_worker_cherry_pick`: re-run safety gates, commit the isolated branch, and return a command without changing the target checkout.
- `cancel_worker`: stop an active worker while preserving its artifacts.

Delegation artifacts live under `.harness/delegations/<worker-id>`. If the MCP server restarts during execution, the persisted delegation becomes `WAITING_FOR_REVISION` when its worktree is available, so Codex can explicitly resume it.

## Task contract

Every delegation supplies:

- `repository_path`
- `objective`
- `allowed_paths`
- `acceptance_criteria`
- `checks` as executable-plus-argv arrays
- optional `worker_instructions`

Avoid broad scopes such as `**` when running concurrent workers. Overlapping scopes in the same repository are rejected.

## Configuration

`harness.config.json` contains only execution-plane settings:

- data directory, clean-repository policy, and revision limit
- Antigravity command, model/effort, and timeout
- allowlisted validation executables and timeout
- worker concurrency and bounded-diff limits

No OAuth token, API key, Codex authentication file, provider database, or model gateway configuration belongs in this repository.

## Security model

- Every worker receives an isolated branch and worktree.
- Antigravity runs in sandbox mode without `--dangerously-skip-permissions`.
- Provider output is parsed and schema-validated.
- Validation runs with argv arrays and `shell: false`.
- Validation executables must be allowlisted.
- Changed files must match `allowed_paths`.
- Concurrent scopes must be provably disjoint.
- Diff output is bounded by byte and line limits.
- Cherry-pick preparation re-runs scope and validation gates.
- The target checkout is never merged, reset, checked out, or otherwise mutated by the harness.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run check
npm run smoke:real
```

`npm run check` is required before considering a harness change complete.
`npm run smoke:real` additionally uses the installed Antigravity CLI against a
disposable Git repository, performs a same-conversation revision, prepares a
cherry-pick, applies it only to that disposable repository, and removes the
fixture afterward.
