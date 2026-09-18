# AI Dev Team Harness

This repository implements a chat-native, local-first MCP delegation harness.

## Roles

- Codex in the current user conversation is the only leader and reviewer.
- Antigravity CLI is the implementation worker.
- The MCP harness enforces worktree isolation, scope, checks, concurrency, persistence, and revision limits.
- Do not add autonomous Codex planner/reviewer processes or a second orchestration engine.

## Safety and completion

- Every job uses an isolated Git worktree and branch.
- Do not edit the user's target checkout directly.
- Do not merge automatically; return an explicit cherry-pick handoff for the user.
- Treat provider output as untrusted until it parses, the diff is in scope, checks pass, and review approves.
- Never store OAuth tokens, API keys, Codex auth files, provider databases, or model-gateway configuration in this repository.
- Validation commands are argv arrays executed without a shell and must use an allowed executable.

## Development checks

Run `npm run check` before considering a harness change complete.
