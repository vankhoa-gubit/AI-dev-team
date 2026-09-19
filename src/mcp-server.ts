#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { loadConfig } from "./config.js";
import {
  DelegationRequestSchema,
  InteractiveDelegationService,
  type InteractiveDelegationApi,
} from "./interactive-delegation.js";
import {
  createSseServer,
  startSseServer,
  type SseServerInstance,
  type SseServerOptions,
} from "./sse-server.js";
export {
  createSseServer,
  startSseServer,
  type SseServerInstance,
  type SseServerOptions,
};

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WorkerIdSchema = z.string().regex(/^delegation-[A-Za-z0-9-]+$/);

export const SERVER_INSTRUCTIONS = [
  "Do not delegate implementation until the user has explicitly approved the plan in the current conversation.",
  "Codex in the current conversation is the only planner and reviewer; never create an autonomous Codex planner or reviewer.",
  "Delegate only bounded implementation work with explicit allowed paths, acceptance criteria, and validation checks.",
  "Call preview_delegation before delegate_to_antigravity, present blockers and manual-review criteria to the user, and pass preview_contract_hash when delegating the unchanged contract.",
  "Use wait_for_worker with after_revision instead of repeatedly polling full status; after it advances or reaches a terminal state, inspect get_worker_review_packet metadata first before requesting diff pages with include_diff or specific paths. UI consumers should stream logs directly from the localhost-only SSE endpoint.",
  "If a worker is INTERRUPTED by an MCP restart, use resume_worker; do not spend a revision round to recover it.",
  "The server never merges into or removes the user's target checkout or worktrees automatically.",
].join(" ");

function toolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error),
    }],
    isError: true,
  };
}

export function createInteractiveMcpServer(service: InteractiveDelegationApi): McpServer {
  const server = new McpServer(
    { name: "ai-dev-team", version: "1.0.0" },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "list_workers",
    {
      title: "List Workers",
      description: "List persisted delegations, optionally filtered to one repository.",
      inputSchema: z.object({ repository_path: z.string().min(1).optional() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ repository_path }) => {
      try {
        return toolResult(await service.list(repository_path));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "preview_delegation",
    {
      title: "Preview Delegation Contract",
      description: "Read-only preflight for a proposed delegation. Normalize scope, verify repository state and validation executables, detect active-worker overlap, expose change budgets and criterion/check coverage, and return a contract hash that can bind the later delegation.",
      inputSchema: DelegationRequestSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return toolResult(await service.preview(input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "delegate_to_antigravity",
    {
      title: "Delegate to Antigravity",
      description: "After explicit user approval and preview_delegation, create an isolated worktree and start one bounded Antigravity implementation asynchronously. Pass preview_contract_hash to reject contract or HEAD drift; supply client_request_id to make retries idempotent.",
      inputSchema: DelegationRequestSchema,
    },
    async (input) => {
      try {
        return toolResult(await service.delegate(input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "diagnose_delegation",
    {
      title: "Diagnose delegation persistence",
      description: "Inspect one or all persisted delegations, including corrupt primary or backup JSON, recovery source, worktree and branch existence, and safe manual remediation.",
      inputSchema: z.object({ worker_id: WorkerIdSchema.optional() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.diagnose(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_worker_diff",
    {
      title: "Get Worker Diff",
      description: "Return a size-bounded Git diff, including untracked files, for Codex review.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.getDiff(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_worker_review_packet",
    {
      title: "Get Worker Review Packet",
      description: "Return a metadata-first review packet with task context, scope and validation gates, diff statistics, warnings, and residual risks. Diff text is omitted by default for quota efficiency; pass include_diff: true or path/cursor to fetch paginated diff pages.",
      inputSchema: z.object({
        worker_id: WorkerIdSchema,
        include_diff: z.boolean().default(false),
        path: z.string().min(1).optional(),
        cursor: z.number().int().min(0).optional(),
        max_bytes: z.number().int().min(1_024).max(262_144).default(49_152),
        max_lines: z.number().int().min(20).max(2_000).default(300),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id, include_diff, path: reviewPath, cursor, max_bytes, max_lines }) => {
      try {
        return toolResult(await service.getReviewPacket(worker_id, {
          ...(include_diff ? { includeDiff: true } : {}),
          ...(reviewPath ? { path: reviewPath } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          maxBytes: max_bytes,
          maxLines: max_lines,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_worker_status",
    {
      title: "Get worker status",
      description: "Read the current state of a delegated Antigravity worker.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.getStatus(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_worker_metrics",
    {
      title: "Get worker metrics",
      description: "Read persisted attempt history and measured worker, revision, resume, provider, and validation timing metrics without estimating token cost.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.getMetrics(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "wait_for_worker",
    {
      title: "Wait for worker",
      description: "Wait until a delegated worker reaches a non-active state, advances status_revision past after_revision, or times out. Pass after_revision to avoid repeated full snapshots; if unchanged on timeout, returns a compact response.",
      inputSchema: z.object({
        worker_id: WorkerIdSchema,
        timeout_seconds: z.number().int().min(1).max(840).default(840),
        after_revision: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id, timeout_seconds, after_revision }) => {
      try {
        return toolResult(await service.waitForWorker(worker_id, timeout_seconds * 1_000, after_revision));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "prepare_worker_cherry_pick",
    {
      title: "Prepare Worker Cherry-pick",
      description: "Re-run gates, commit the isolated worker branch, and return a cherry-pick command without changing the target checkout.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.prepareCherryPick(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "preview_worker_cleanup",
    {
      title: "Preview worker cleanup",
      description: "Inspect exact cleanup targets and blockers, then issue a short-lived confirmation token without changing the worktree, branch, or artifacts.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.previewCleanup(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "cleanup_worker",
    {
      title: "Cleanup worker worktree",
      description: "After an explicit preview and confirmation, remove only the clean registered worker worktree while retaining its branch and artifacts.",
      inputSchema: z.object({
        worker_id: WorkerIdSchema,
        confirmation_token: z.string().uuid(),
      }).strict(),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ worker_id, confirmation_token }) => {
      try {
        return toolResult(await service.cleanupWorker(worker_id, confirmation_token));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_worker_result",
    {
      title: "Get worker result",
      description: "Return the gated worker result, changed files, and validation evidence after the run stops.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.getResult(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "request_worker_revision",
    {
      title: "Request worker revision",
      description: "Resume the same Antigravity conversation with review feedback, within the configured revision limit.",
      inputSchema: z.object({
        worker_id: WorkerIdSchema,
        feedback: z.string().min(1),
      }).strict(),
    },
    async ({ worker_id, feedback }) => {
      try {
        return toolResult(await service.requestRevision(worker_id, feedback));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "resume_worker",
    {
      title: "Resume interrupted worker",
      description: "Resume an INTERRUPTED Antigravity worker in its preserved worktree without consuming a revision round.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.resumeWorker(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "cancel_worker",
    {
      title: "Cancel worker",
      description: "Terminate an active Antigravity worker while preserving its branch, worktree, and artifacts.",
      inputSchema: z.object({ worker_id: WorkerIdSchema }).strict(),
    },
    async ({ worker_id }) => {
      try {
        return toolResult(await service.cancel(worker_id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = path.resolve(optionValue(args, "--config") ?? path.join(harnessRoot, "harness.config.json"));
  const config = await loadConfig(configPath);
  const worker = new AntigravityAdapter(config.antigravity, harnessRoot);
  const service = new InteractiveDelegationService(config, harnessRoot, worker);
  await service.initialize();

  const ssePortArg = optionValue(args, "--sse-port");
  const enableSse = args.includes("--enable-sse") || Boolean(ssePortArg) || process.env.AI_DEV_TEAM_ENABLE_SSE === "true";
  if (enableSse) {
    const ssePort = ssePortArg ? parseInt(ssePortArg, 10) : 0;
    if (!Number.isInteger(ssePort) || ssePort < 0 || ssePort > 65_535) {
      throw new Error("--sse-port must be an integer between 0 and 65535");
    }
    const sseOrigin = optionValue(args, "--sse-origin") ?? process.env.AI_DEV_TEAM_SSE_ORIGIN;
    const sse = await startSseServer({
      delegationsRoot: service.getDelegationsRoot(),
      service,
      port: ssePort,
      host: "127.0.0.1",
      ...(sseOrigin ? { allowedOrigins: [sseOrigin] } : {}),
    });
    console.error(`AI Dev Team SSE log endpoint is listening on ${sse.url}`);
  }

  serveStdio(() => createInteractiveMcpServer(service));
  console.error("AI Dev Team Antigravity MCP server is listening on stdio");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
