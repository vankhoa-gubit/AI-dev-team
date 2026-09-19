# MCP production-readiness evidence

Date: 2026-09-18; incremental validation updated 2026-09-19 (Asia/Bangkok)

## Runtime

- Codex CLI: `0.154.0`
- Antigravity CLI: `1.2.5`
- MCP transport: local STDIO
- MCP server name: `ai_dev_team`
- Approval mode: `writes`
- Startup timeout: 20 seconds
- Tool timeout: 900 seconds

## Automated validation

`npm run check` passed:

- strict TypeScript typecheck
- 14 MCP-focused tests
- production build

The STDIO handshake returned all fourteen expected tools:

- `cancel_worker`
- `cleanup_worker`
- `delegate_to_antigravity`
- `diagnose_delegation`
- `get_worker_diff`
- `get_worker_metrics`
- `get_worker_result`
- `get_worker_status`
- `list_workers`
- `prepare_worker_cherry_pick`
- `preview_worker_cleanup`
- `request_worker_revision`
- `resume_worker`
- `wait_for_worker`

The 2026-09-19 incremental validation added completion and bounded-timeout
coverage for `wait_for_worker`, plus restart recovery coverage proving that
`resume_worker` preserves the worktree, reuses a persisted conversation ID, and
does not consume a revision round. Persistence recovery coverage verifies atomic
writes, valid-backup fallback, corrupt-evidence preservation, unrecoverable task/status
diagnostics, and restart behavior around an unrenamed temporary file. A fresh STDIO
`listTools` handshake against the production build returned all fourteen tools. The real-provider smoke test below
was not repeated for these orchestration-only changes, avoiding an unnecessary
Antigravity invocation.

Idempotent delegation coverage verifies that concurrent and post-restart calls
with the same `client_request_id` reuse one persisted worker, while a changed
task contract is rejected before another Antigravity invocation. Metrics
coverage verifies initial/revision/resume history, persisted timings,
conversation reuse, interruption, scope violations, denied actions, and
provider timeouts without estimating tokens or cost.

Cleanup coverage verifies read-only preview, terminal-state gating, dirty-tree
rejection, invalid and expired tokens, path-traversal rejection, exact Git
worktree removal without force, preservation of the target checkout, branch and
artifacts, and idempotent repeated cleanup.

## Real Antigravity smoke test

`npm run smoke:real` passed with the installed Antigravity CLI.

The smoke test created a disposable Git repository and verified:

1. initial implementation in an isolated worktree;
2. scope and validation gates;
3. explicit Codex-style revision feedback;
4. reuse of the Antigravity conversation ID;
5. bounded diff retrieval including the new file;
6. no target-checkout mutation before handoff;
7. isolated-branch commit creation;
8. successful cherry-pick into the disposable repository;
9. final file contents after revision; and
10. cleanup of the disposable fixture created by the passing run.

Passing run evidence:

```text
[smoke] WORKER_RUNNING: Antigravity worker is running
[smoke] COMPLETED: Worker result passed scope and validation gates; ready for Codex review
[smoke] WORKER_RUNNING: Antigravity worker is applying revision feedback
[smoke] COMPLETED: Worker result passed scope and validation gates; ready for Codex review
[smoke] PASS worker=delegation-20260918154602-9f823ad6 commit=fd9cb2f1b32a37748f552a251b1343e58facde4f
```

## Local legacy tombstones

Legacy source/UI paths are no longer tracked by Git and are excluded from the
runtime, build, and tests. Inert ignored copies may remain on this Windows host
when the desktop process holds delete handles; they are not part of a commit or
new checkout.
