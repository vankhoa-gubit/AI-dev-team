# AI Dev Team Harness — Phases 1–4D

Sequential local-first orchestration with Codex as leader and independent reviewer, Antigravity CLI as the implementation worker, and 9Router as the Codex model gateway.

Phase 2 adds a local stdio MCP server so Codex can delegate to Antigravity interactively without a separate harness command.

Phase 3 adds bounded parallel execution with disjoint worker scopes, per-shard review, sequential integration, and a final integration review.

Phase 4A adds a secure local read-only HTTP observation API and `harness ui` CLI entrypoint.

Phase 4B adds a polished, responsive local operations console dashboard in `ui/` with zero external dependencies, safe DOM rendering, and real-time monitoring.

Phase 4C adds asynchronous parallel run execution from the UI, operation metadata persistence under `.harness/ui/operations`, safe tracked child process cancellation, and dashboard controls.

Phase 4D adds retry and replan terminal operations with durable parent/child lineage, and safely prepared copyable cherry-pick commands for approved runs without executing Git integration mutations.

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

## Phase 4A: local HTTP observation API

Start the local read-only observation server:

```powershell
node .\dist\cli.js ui [--host 127.0.0.1] [--port 4310] [--config harness.config.json]
```

By default, the server binds strictly to `127.0.0.1` on port `4310`. Configuration or arguments attempting to bind to non-loopback addresses are rejected.

### Observation endpoints

- `GET /api/health` (or `/health`): returns `{ "status": "ok" }`.
- `GET /api/parallel-runs`: returns a newest-first JSON list of parallel run summaries.
- `GET /api/parallel-runs/:id`: returns status and shard results for a specific run (raw stdout/stderr logs omitted).
- `GET /api/parallel-runs/:id/events`: returns chronological lifecycle transition events from `events.jsonl`.
- `GET /api/parallel-runs/:id/integration-review`: returns the structured Codex integration review verdict, findings, and criteria evidence.
- `GET /api/parallel-runs/:id/integration-checks`: returns integration validation commands and pass/fail results (with stdout/stderr omitted).
- `GET /api/parallel-runs/:id/integration-diff`: returns a bounded diff (`{ id, diff, truncated }` or plain text with `Accept: text/plain`).
- `GET /`: serves static assets from `ui/` (`index.html`, `styles.css`, `app.js`), or a safe HTML fallback dashboard when Phase 4B assets do not exist yet.

## Phase 4B: local operations console dashboard

The harness includes a standalone, local-first static dashboard located in `ui/`.

- **Visual design**: dense, dark-neutral developer console surfaces (`#090d13` / `#0e141d`), restrained cyan, green, and amber accents, and clean information hierarchy without gradients or decorative hero banners.
- **Zero external dependencies**: no external frameworks, no CDN scripts or styles, no remote fonts or icons, and no client-side build step.
- **Safe DOM rendering policy**: strictly builds DOM using `document.createElement`, `textContent`, and safe DOM node construction; never assigns untrusted API data to `innerHTML`.
- **Real-time polling & resilience**: polls `/api/parallel-runs` every 3–5 seconds without losing the selected run. Detail endpoints are fetched independently so missing in-progress artifacts never blank the page.
- **Accessibility & responsiveness**: full keyboard navigation, visible focus states (`:focus-visible`), semantic landmarks (`role="banner"`, `role="main"`, `role="status"`, `aria-live="polite"`), skip links, reduced-motion support (`@media (prefers-reduced-motion: reduce)`), and mobile responsive layout.

### Security guarantees

- **Loopback-only binding**: strictly enforces local loopback (`127.0.0.1`, `localhost`, `::1`). Non-loopback bindings are rejected.
- **Read-only**: only `GET` and `HEAD` requests are handled; mutating verbs return `405 Method Not Allowed`.
- **Path traversal and symlink protection**: all run IDs and file access are verified against traversal and symlink escapes.
- **Information leakage protection**: raw process stdout/stderr logs are omitted, and JSON error responses never leak stack traces or internal secrets.
- **XSS immunity**: safe DOM construction policy guarantees no untrusted API values are rendered via `innerHTML`.

## Phase 4C: asynchronous run execution, operations persistence, and dashboard controls

Phase 4C adds secure run initiation and process tracking from the local UI:

- **POST /api/runs**: accepts bounded JSON `{ repositoryPath, requirement }`, validates both (path must be absolute, exist, and be a Git repository; requirement bounded to 20,000 chars), launches only the current harness CLI parallel command asynchronously with `shell: false` and argv arrays, and immediately returns an operation ID.
- **GET /api/operations**: returns a newest-first sanitized list of operation statuses.
- **GET /api/operations/:id**: returns individual operation details, linking discovered parallel run IDs.
- **POST /api/operations/:id/cancel**: idempotent endpoint that terminates only live child processes owned and tracked by the operation manager, preserving all worktrees, branches, and run artifacts.
- **Persistence**: operation metadata is persisted durably under `.harness/ui/operations/<operation-id>.json`.
- **Sanitization & redaction**: raw stdout and stderr are omitted from operation APIs; sensitive credentials, API keys, and arbitrary filesystem paths outside the submitted repository path are redacted.
- **Dashboard controls**: an accessible New Run form, Active Operations console, and Cancel button shown strictly for cancellable operations.
- **Safety guarantee**: runs execute in isolated Git worktrees and never auto-merge the original checkout.

## Phase 4D: retry, replan, durable lineage, and safe cherry-pick preparation

Phase 4D adds lifecycle retry and replanning with lineage tracking and safe cherry-pick command preparation:

- **POST /api/operations/:id/retry**: validates the source operation, permits only `COMPLETED` or `FAILED` sources (rejecting non-terminal or cancelled runs with 409 Conflict), launches a new parallel operation with the stored repository path and original requirement, and immediately returns the new operation ID.
- **POST /api/operations/:id/replan**: requires `application/json` with bounded non-empty human feedback (<= 20,000 characters), permits only `COMPLETED` or `FAILED` source operations, clearly appends the human feedback to the requirement, and launches the replanned operation immediately.
- **Durable Lineage Persistence**: child records store `parentId`, `rootId`, `action` (`"retry"` or `"replan"`), and feedback; parent records expose `childOperationIds`. Atomic write queues per operation ID ensure concurrent operations never drop child IDs or lose terminal status.
- **GET/POST /api/parallel-runs/:id/prepare-cherry-pick**: accepts a validated parallel run ID, reads only the safe `status.json` artifact, verifies state is `DONE`, validates `repositoryPath` is an existing local Git repository, and returns `{ runId, sha, integrationCommitSha, repositoryPath, argv, command }` with self-contained `argv: ["git", "-C", repositoryPath, "cherry-pick", sha]` and safely formatted command.
- **Zero Git Mutation Guarantee**: cherry-pick preparation is strictly read-only and never executes `git cherry-pick`, `merge`, `checkout`, `reset`, or branch/worktree mutations. The target repository HEAD and working tree remain completely untouched.
- **Dashboard UI Controls**:
  - Exposes **Retry** and **Replan** action buttons only on eligible terminal operations (`COMPLETED` or `FAILED`).
  - Accessible inline replan form collects bounded feedback with full keyboard navigation and clear validation messages.
  - Operations display explicit parent/child lineage links and replan feedback history.
  - Exposes **Copy Cherry-pick Command** only for linked `DONE` runs that have an approved integration commit.

## Commands

```powershell
npm run typecheck
npm test
npm run build
npm run check
```
