import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RouterStatus {
  reachable: boolean;
  statusCode?: number;
  message: string;
}

export async function checkRouter(baseUrl: string): Promise<RouterStatus> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return {
      reachable: true,
      statusCode: response.status,
      message: response.status === 401
        ? "9Router is reachable and requires authentication"
        : `9Router responded with HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      reachable: false,
      message: `9Router is unreachable at ${url}: ${String(error)}`,
    };
  }
}

export async function codexProviderIsConfigured(provider: string): Promise<boolean> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  try {
    const config = await readFile(configPath, "utf8");
    const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\[model_providers\\.${escaped}\\]\\s*$`, "m").test(config);
  } catch {
    return false;
  }
}
