#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { resolveExecutable } from "./process.js";

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): string {
  return [
    "AI Dev Team is a chat-native MCP delegation harness.",
    "",
    "Usage:",
    "  harness doctor [--config <path>]",
    "  harness show-config [--config <path>]",
    "  harness-mcp [--config <path>]",
  ].join("\n");
}

async function doctor(configPath: string): Promise<number> {
  const config = await loadConfig(configPath);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  for (const [name, command] of [
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

  console.table(checks);
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const configPath = path.resolve(optionValue(args, "--config") ?? path.join(harnessRoot, "harness.config.json"));

  if (command === "doctor") {
    return await doctor(configPath);
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
