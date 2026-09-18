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

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WorkerIdSchema = z.string().regex(/^delegation-[A-Za-z0-9-]+$/);

export const SERVER_INSTRUCTIONS = [
  "Do not delegate implementation until the user has explicitly approved the plan in the current conversation.",
  "Codex in the current conversation is the only planner and reviewer; never create an autonomous Codex planner or reviewer.",
  "Delegate only bounded implementation work with explicit allowed paths, acceptance criteria, and validation checks.",
  "Poll get_worker_status until the worker is no longer active, then review get_worker_diff before requesting a revision or preparing a cherry-pick.",
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
    "delegate_to_antigravity",
    {
      title: "Delegate to Antigravity",
      description: "After explicit user approval, create an isolated worktree and start one bounded Antigravity implementation asynchronously.",
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
  serveStdio(() => createInteractiveMcpServer(service));
  console.error("AI Dev Team Antigravity MCP server is listening on stdio");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
