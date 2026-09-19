# AI Dev Team Harness

AI Dev Team is a chat-native MCP delegation harness. Codex in the current conversation remains the leader: it discusses requirements, inspects the repository, creates bounded task contracts, and reviews diffs. Antigravity is the implementation worker.

The harness does not invoke Codex CLI, use a model gateway, plan autonomously, review autonomously, merge changes, or modify the user's target checkout.

## Workflow

1. You and Codex discuss the requirement and explicitly agree to implement it.
2. Codex calls `preview_delegation` with the proposed objective, allowed paths,
   acceptance criteria, checks, change budgets, and criterion/check mapping.
3. After approval, Codex passes the returned `contract_hash` as
   `preview_contract_hash`; the harness rejects contract or repository HEAD drift,
   then creates an isolated branch and Git worktree.
4. Antigravity implements the task using `--output-format stream-json`. Logs are parsed across arbitrary chunk boundaries, sanitized, and appended in order to bounded per-attempt JSONL artifacts.
5. Codex uses delta long-polling with `wait_for_worker` (passing `after_revision`) instead of repeatedly polling full status snapshots. If unchanged upon timeout, it returns a compact response. UI consumers can stream sanitized log events directly via the opt-in localhost-only SSE endpoint.
6. The harness rejects denied actions, empty changes, out-of-scope files, and failed checks.
7. Codex inspects the metadata-first review packet (gates, diff statistics, validation evidence) and only requests diff pages (using `include_diff: true` or specific paths) when needed, then either requests a revision or prepares a cherry-pick handoff.
8. You explicitly decide whether to run the returned cherry-pick command.
9. After handoff, Codex can preview and explicitly confirm removal of only the clean worker worktree.

Multiple workers may run concurrently only when their scopes are provably disjoint. The harness never auto-merges and never removes worktrees automatically.

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

Run the opt-in end-to-end Deep Doctor before the first real delegation or after
changing Antigravity authentication, model, permissions, or CLI version:

```powershell
node .\dist\cli.js doctor --deep
```

Deep Doctor consumes one real Antigravity invocation. It creates a disposable
Git repository, exercises isolated worktree creation, file read/write,
allowlisted validation, structured output, conversation capture, handoff, and
worktree cleanup. The disposable repository is removed afterward. A report and
raw provider stdout/stderr are retained under `.harness/doctor/<run-id>` so an
empty response or soft-denied action can be diagnosed without blindly retrying.

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

### Opt-in Localhost-Only SSE Log Endpoint

For external UI consumers that wish to stream live execution logs directly without consuming Codex context quota, the MCP server provides an opt-in native Node HTTP SSE endpoint. It is disabled by default and strictly binds only to `127.0.0.1`:

```powershell
node dist/mcp-server.js --enable-sse --sse-port 20129
```

If the UI is served from a different local origin, allow that exact origin explicitly:

```powershell
node dist/mcp-server.js --enable-sse --sse-port 20129 --sse-origin http://127.0.0.1:3000
```

Cross-origin browser access is denied by default; the endpoint never sends a wildcard CORS header.

- Endpoint: `GET http://127.0.0.1:20129/workers/:worker_id/events?cursor=:cursor`
- Supports `Last-Event-ID` or `?cursor=` for historical replay and resuming disconnects.
- Emits sanitized, bounded JSON log events with monotonic cursor IDs and keepalives.
- Supports disconnect cancellation and write backpressure.

## MCP tools

- `delegate_to_antigravity`: create a bounded asynchronous worker in an isolated worktree.
- `preview_delegation`: perform a read-only contract preflight, normalize scope,
  validate repository/check readiness, detect active-worker overlap, show manual
  review gaps, and return a contract hash for the later delegation.
- `list_workers`: list persisted delegations, optionally filtered by repository.
- `diagnose_delegation`: inspect one or all delegation directories, including corrupt JSON, backup recovery, and Git resource health.
- `get_worker_status`: read current state and quota-oriented attempt metrics.
- `get_worker_metrics`: read measured attempt history, timings, reuse, and failure categories.
- `wait_for_worker`: wait until a delegated worker reaches a non-active state, advances `status_revision` past `after_revision`, or times out. Pass `after_revision` for compact unchanged responses without full snapshots.
- `get_worker_result`: read the terminal worker result and validation evidence.
- `get_worker_diff`: return a size-bounded Git diff, including untracked files.
- `get_worker_review_packet`: return metadata-first review packet with task context,
  scope and validation gates, diff statistics, warnings, and residual risks. Diff text
  is omitted by default for quota efficiency; pass `include_diff: true` or `path`/`cursor`
  to fetch bounded paginated diff pages.
- `resume_worker`: resume an interrupted worker without consuming a revision round.
- `request_worker_revision`: resume the same Antigravity conversation with review feedback.
- `prepare_worker_cherry_pick`: re-run safety gates, commit the isolated branch, and return a command without changing the target checkout.
- `preview_worker_cleanup`: inspect the exact worktree target and blockers, then issue a short-lived confirmation token.
- `cleanup_worker`: explicitly remove only the clean registered worker worktree while retaining its branch and artifacts.
- `cancel_worker`: stop an active worker while preserving its artifacts.

Delegation artifacts live under `.harness/delegations/<worker-id>`. If the MCP server restarts during execution, the persisted delegation becomes `INTERRUPTED` when its worktree is available. Codex can call `resume_worker` without consuming the review revision budget.

`task.json` and `status.json` are written through a flushed same-directory temporary file and atomic rename. Before replacing a valid status, the harness keeps it as `status.json.bak`. Reads fall back to that backup when the primary is missing or corrupt. A later mutation preserves a corrupt primary as `status.json.corrupt.<timestamp>.<id>` before replacing it; the harness never silently deletes corrupt evidence. Use `diagnose_delegation` before manual recovery.

## Task contract

Every delegation supplies:

- `repository_path`
- `objective`
- `allowed_paths`
- `acceptance_criteria`
- `checks` as executable-plus-argv arrays
- `budgets` with maximum changed files, diff lines, and diff bytes
- `criterion_check_mapping`, using zero-based criterion and check indexes, to
  distinguish automated evidence from criteria that require manual Codex review
- optional `worker_instructions`
- optional `client_request_id` for idempotent retries within one repository
- optional `preview_contract_hash` copied from `preview_delegation`

When `client_request_id` is present, retrying the same task contract returns the
persisted worker with `delegation_outcome: "reused"` instead of creating another
worktree or Antigravity invocation. Reusing the ID with a different contract is
rejected. A newly created worker returns `delegation_outcome: "created"`.

New delegations default to 50 changed files, 2,000 diff lines, and 256 KiB of
diff when budgets are omitted. Budget gates run after every worker attempt and
again immediately before cherry-pick preparation. Exceeding a budget moves the
worker to `WAITING_FOR_REVISION`; it never silently truncates an oversized
change into an approvable result.

Each provider invocation appends a persisted attempt record with its trigger
(`initial`, `revision`, or `resume`), measured duration, provider and validation
timings, conversation reuse, outcome, and any known failure category. The
harness does not estimate tokens or monetary cost when the provider does not
report them.

Cleanup is an explicit two-step operation. `preview_worker_cleanup` is read-only
and binds a five-minute token to the worker, state, worktree path, commit, and
snapshot version. `cleanup_worker` rejects active, interrupted, revision-ready,
dirty, moved, or stale targets; it never uses force, never removes the target
checkout, and retains the worker branch plus delegation artifacts.

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
- Worktree cleanup requires an exact preview token and uses registered Git worktree removal without force.

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
