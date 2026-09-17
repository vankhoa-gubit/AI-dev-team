import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { assertSafeChildPath, SecurityError } from "./security.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function fallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Dev Team Harness</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 2rem; color: #1f2937; background: #f9fafb; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-top: 0; color: #111827; }
    p { line-height: 1.5; color: #4b5563; }
    code { background: #f3f4f6; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    .badge { display: inline-block; padding: 0.25rem 0.5rem; background: #ecfdf5; color: #065f46; border-radius: 9999px; font-weight: 500; font-size: 0.875rem; margin-bottom: 1rem; }
    ul { padding-left: 1.25rem; color: #374151; }
    li { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Phase 4A API Active</div>
    <h1>AI Dev Team Harness</h1>
    <p>The local harness read-only API is active.</p>
    <p>Web UI assets (Phase 4B) are not yet present in <code>ui/</code>.</p>
    <p>Available observation endpoints:</p>
    <ul>
      <li><code>GET /api/health</code></li>
      <li><code>GET /api/parallel-runs</code></li>
      <li><code>GET /api/parallel-runs/:id</code></li>
      <li><code>GET /api/parallel-runs/:id/events</code></li>
      <li><code>GET /api/parallel-runs/:id/integration-review</code></li>
      <li><code>GET /api/parallel-runs/:id/integration-checks</code></li>
      <li><code>GET /api/parallel-runs/:id/integration-diff</code></li>
    </ul>
  </div>
</body>
</html>
`;
}

export async function serveStatic(
  uiRoot: string,
  requestPath: string,
  res: ServerResponse,
): Promise<boolean> {
  const isRoot = requestPath === "/" || requestPath === "/index.html";
  const relative = isRoot ? "index.html" : requestPath.replace(/^\/+/, "");

  let targetPath: string;
  try {
    targetPath = await assertSafeChildPath(uiRoot, relative);
  } catch (err) {
    if (err instanceof SecurityError) {
      throw err;
    }
    return false;
  }

  try {
    const fileStat = await stat(targetPath);
    if (fileStat.isFile()) {
      const content = await readFile(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(content);
      return true;
    }
  } catch {
    // File not found on disk
  }

  // Fallback for root path when index.html does not exist in ui/
  if (isRoot) {
    const content = Buffer.from(fallbackHtml(), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(content);
    return true;
  }

  return false;
}
