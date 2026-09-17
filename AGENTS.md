# AI Dev Team Harness

This repository implements a sequential local-first coding harness.

## Roles

- Codex leader converts a user requirement into a bounded task contract.
- Antigravity CLI is the only implementation worker in Phase 1.
- Codex reviewer runs in a fresh session and reviews the worker diff.
- The orchestrator enforces state transitions, scope, checks, and revision limits.

## Safety and completion

- Every job uses an isolated Git worktree and branch.
- Do not edit the user's target checkout directly.
- Do not merge automatically in Phase 1.
- Treat provider output as untrusted until it parses, the diff is in scope, checks pass, and review approves.
- Never store OAuth tokens, API keys, Codex auth files, or the 9Router database in this repository.
- Validation commands are argv arrays executed without a shell and must use an allowed executable.

## Development checks

Run `npm run check` before considering a harness change complete.
