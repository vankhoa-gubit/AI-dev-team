# MCP production-readiness evidence

Date: 2026-09-18 (Asia/Bangkok)

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
- 7 MCP-focused tests
- production build

The STDIO handshake returned all eight expected tools:

- `cancel_worker`
- `delegate_to_antigravity`
- `get_worker_diff`
- `get_worker_result`
- `get_worker_status`
- `list_workers`
- `prepare_worker_cherry_pick`
- `request_worker_revision`

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

## Remaining local cleanup

Legacy source/UI files have inert tombstone contents and are excluded from the
runtime, build, and tests. The running Codex desktop process still holds Windows
delete handles for those original paths. Restart Codex, then remove the
tombstone files physically before creating the MCP-first baseline commit.
