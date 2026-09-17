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
    { name: "ai-dev-team-antigravity", version: "0.3.0" },
    {
      instructions: [
        "Delegate bounded implementation work to Antigravity in an isolated Git worktree.",
        "Poll get_worker_status until the worker is no longer active.",
        "Review the preserved worktree diff before requesting a revision or accepting the result.",
        "This server never merges or removes worktrees automatically.",
      ].join(" "),
    },
  );

  server.registerTool(
    "delegate_to_antigravity",
    {
      title: "Delegate to Antigravity",
      description: "Create an isolated worktree and start one bounded Antigravity implementation asynchronously.",
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
  serveStdio(() => createInteractiveMcpServer(service));
  console.error("AI Dev Team Antigravity MCP server is listening on stdio");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
