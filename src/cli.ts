#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { CodexAdapter } from "./adapters/codex.js";
import { loadConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ParallelOrchestrator } from "./parallel-orchestrator.js";
import { resolveExecutable } from "./process.js";
import { checkRouter, codexProviderIsConfigured } from "./router.js";
import { HarnessUiServer } from "./ui/index.js";

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return [
    "Usage:",
    "  harness doctor [--config <path>]",
    "  harness run --repo <git-repo> --requirement <text> [--config <path>] [--allow-dirty]",
    "  harness parallel --repo <git-repo> --requirement <text> [--config <path>] [--allow-dirty]",
    "  harness ui [--host <host>] [--port <port>] [--config <path>]",
    "",
    "PowerShell tip: single-quote requirements that contain JSON.",
  ].join("\n");
}

async function parallelCommand(args: string[], configPath: string): Promise<number> {
  const repo = optionValue(args, "--repo");
  const requirement = optionValue(args, "--requirement");
  if (!repo || !requirement) {
    console.error(usage());
    return 2;
  }
  const loaded = await loadConfig(configPath);
  const config = args.includes("--allow-dirty")
    ? { ...loaded, requireCleanRepository: false }
    : loaded;
  const codex = new CodexAdapter(config.codex, harnessRoot);
  const antigravity = new AntigravityAdapter(config.antigravity, harnessRoot);
  const orchestrator = new ParallelOrchestrator(config, harnessRoot, {
    planner: codex,
    worker: antigravity,
    reviewer: codex,
  });
  const summary = await orchestrator.run(requirement, repo);
  console.log(JSON.stringify(summary, null, 2));
  return summary.state === "DONE" ? 0 : 1;
}

async function doctor(configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  for (const [name, command] of [
    ["Codex CLI", config.codex.command],
    ["Antigravity CLI", config.antigravity.command],
    ["Git", "git"],
  ] as const) {
    try {
      const resolved = await resolveExecutable(command);
      checks.push({ name, ok: true, detail: resolved });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
  }

  const router = await checkRouter(config.router.baseUrl);
  checks.push({ name: "9Router", ok: router.reachable, detail: router.message });

  if (config.codex.provider) {
    const configured = config.codex.providerBaseUrl
      ? true
      : await codexProviderIsConfigured(config.codex.provider);
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    checks.push({
      name: `Codex provider ${config.codex.provider}`,
      ok: configured,
      detail: configured
        ? config.codex.providerBaseUrl
          ? `Configured inline for ${config.codex.providerBaseUrl}`
          : `Configured in ${path.join(codexHome, "config.toml")}`
        : `Missing from ${path.join(codexHome, "config.toml")}`,
    });
  }

  console.table(checks);
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function runCommand(args: string[], configPath: string): Promise<number> {
  const repo = optionValue(args, "--repo");
  const requirement = optionValue(args, "--requirement");
  if (!repo || !requirement) {
    console.error(usage());
    return 2;
  }

  const loaded = await loadConfig(configPath);
  const config = args.includes("--allow-dirty")
    ? { ...loaded, requireCleanRepository: false }
    : loaded;
  const codex = new CodexAdapter(config.codex, harnessRoot);
  const antigravity = new AntigravityAdapter(config.antigravity, harnessRoot);
  const orchestrator = new Orchestrator(config, harnessRoot, {
    planner: codex,
    worker: antigravity,
    reviewer: codex,
  });
  const summary = await orchestrator.run(requirement, repo);
  console.log(JSON.stringify(summary, null, 2));
  return summary.state === "APPROVED" ? 0 : 1;
}

export function parsePort(portString?: string): number | null {
  if (portString === undefined) {
    return 4310;
  }
  if (!/^\d+$/.test(portString)) {
    return null;
  }
  const port = Number(portString);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return null;
  }
  return port;
}

async function uiCommand(args: string[], configPath: string): Promise<number> {
  const host = optionValue(args, "--host") ?? "127.0.0.1";
  const portIndex = args.indexOf("--port");
  let port = 4310;
  if (portIndex >= 0) {
    const portString = args[portIndex + 1];
    if (portString === undefined) {
      console.error("Invalid port: must be an integer between 0 and 65535");
      return 2;
    }
    const parsed = parsePort(portString);
    if (parsed === null) {
      console.error("Invalid port: must be an integer between 0 and 65535");
      return 2;
    }
    port = parsed;
  }
  const config = await loadConfig(configPath);
  const server = new HarnessUiServer(config, harnessRoot, { host, port });
  await server.start();
  console.log(`Harness UI server listening on ${server.url}`);

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await server.stop();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const configPath = path.resolve(optionValue(args, "--config") ?? path.join(harnessRoot, "harness.config.json"));

  if (command === "doctor") {
    return await doctor(configPath);
  }
  if (command === "run") {
    return await runCommand(args.slice(1), configPath);
  }
  if (command === "parallel") {
    return await parallelCommand(args.slice(1), configPath);
  }
  if (command === "ui") {
    return await uiCommand(args.slice(1), configPath);
  }

  if (command === "show-config") {
    const raw = await readFile(configPath, "utf8");
    console.log(raw);
    return 0;
  }

  console.log(usage());
  return command ? 2 : 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
