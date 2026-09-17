# AI Dev Team Harness — Phases 1–3

Sequential local-first orchestration with Codex as leader and independent reviewer, Antigravity CLI as the implementation worker, and 9Router as the Codex model gateway.

Phase 2 adds a local stdio MCP server so Codex can delegate to Antigravity interactively without a separate harness command.

Phase 3 adds bounded parallel execution with disjoint worker scopes, per-shard review, sequential integration, and a final integration review.

## Phase 1 flow

1. Codex inspects a clean Git repository and emits a structured task contract.
2. The harness creates an isolated branch and Git worktree.
3. Antigravity implements the task in that worktree.
4. The harness rejects empty output, denied actions, out-of-scope files, and failed checks.
5. A fresh Codex review session reviews the uncommitted diff.
6. Antigravity receives validation or review feedback in the same conversation, up to the configured revision limit.
7. An approved branch and worktree are left for human inspection. Phase 1 does not merge automatically.

## Setup

```powershell
cd D:\AI-dev-team
npm install
npm run check
```

Start 9Router bound to localhost:

```powershell
9router --host 127.0.0.1 --port 20128
```

The included `harness.config.json` defines the `nine_router` provider inline for each Codex process:

```toml
[model_providers.nine_router]
name = "9Router"
base_url = "http://127.0.0.1:20128/v1"
wire_api = "responses"
supports_websockets = false
```

The command-backed auth section reads the bearer token from `~/.codex/secrets/9router-api-key`. Do not put the token in this repository or directly in `harness.config.json`.

## Diagnose local prerequisites

```powershell
npm run build
node .\dist\cli.js doctor
```

The doctor checks Codex, Antigravity, Git, the 9Router listener, and the configured Codex provider without printing credentials.

## Run a job

```powershell
node .\dist\cli.js run `
  --repo 'D:\path\to\target-repository' `
  --requirement 'Add a /health endpoint returning { "status": "ok" } and add tests'
```

The target must be a Git repository and clean by default. Runtime artifacts are stored under `.harness/jobs/<job-id>` in this harness project. The approved implementation remains on `harness/<job-id>` and in its recorded worktree path.

## Security model

- Provider output is parsed and validated before use.
- Required checks are argv arrays executed with `shell: false`.
- Validation executables must be explicitly allowlisted in `harness.config.json`.
- Worker edits are checked against `allowed_paths` before review.
- Secrets, provider databases, and OAuth files stay outside this repository.
- `--dangerously-skip-permissions` is not used for Antigravity.
- Antigravity runs with `--sandbox`; headless command execution should use `toolPermission: proceed-in-sandbox` with terminal sandboxing enabled.
- MCP delegation preserves every branch and worktree for explicit Codex/human review; it never merges or deletes them.

## Phase 2: interactive MCP delegation

Build the server:

```powershell
cd D:\AI-dev-team
npm run check
```

Register the local stdio server in Codex using an absolute path:

```toml
[mcp_servers.antigravity_harness]
command = "node"
args = ["D:\\AI-dev-team\\dist\\mcp-server.js", "--config", "D:\\AI-dev-team\\harness.config.json"]
```

The server exposes:

- `delegate_to_antigravity`: creates an isolated worktree and starts the worker asynchronously.
- `get_worker_status`: polls `PREPARING`, `WORKER_RUNNING`, or `CHECKING` state.
- `get_worker_result`: returns changed files, validation evidence, and the worker result after the run stops.
- `request_worker_revision`: resumes the same Antigravity conversation with review feedback, up to the configured limit.
- `cancel_worker`: terminates an active worker while preserving its branch, worktree, and artifacts.

Delegation artifacts are stored under `.harness/delegations/<worker-id>`. A successful worker run ends in `COMPLETED`, meaning scope and validation gates passed and the diff is ready for Codex review. It does not mean the change was merged.

## Phase 3: parallel orchestration

```powershell
node .\dist\cli.js parallel `
  --repo 'D:\path\to\target-repository' `
  --requirement 'Implement two independent modules and integration tests'
```

The Codex leader must produce at least two tasks with non-overlapping `allowed_paths`. The harness runs up to `parallel.maxWorkers` Antigravity workers concurrently, each from the same base commit and in a separate worktree. Every shard must pass its scope gate, validation commands, and an independent Codex review before the orchestrator commits that shard.

Approved shard commits are applied in plan order with `git cherry-pick --no-commit` to a new integration worktree. The combined diff then passes all unique shard checks, integration checks, and a final Codex review. Only after final approval does the harness commit the integration branch. It never merges that branch into the user's checkout.

Conflicts, integrated validation failures, and final-review rejection end in `REPLAN_REQUIRED`. Artifacts remain under `.harness/parallel-runs/<run-id>` for Codex or a human to inspect and replan.

## Commands

```powershell
npm run typecheck
npm test
npm run build
npm run check
```
