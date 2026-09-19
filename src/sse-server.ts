import http from "node:http";
import type { Socket } from "node:net";
import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { sanitizeLogRecord, workerLogEmitter } from "./adapters/antigravity.js";
import type { InteractiveDelegationApi } from "./interactive-delegation.js";
import type { WorkerLogRecord } from "./types.js";

const WORKER_ID_REGEX = /^delegation-[A-Za-z0-9-]+$/;
const EVENT_FILE_REGEX = /^worker-attempt-(\d+)(?:-[^.]+)?\.events\.jsonl$/;
const MAX_HISTORICAL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_LIVE_EVENTS = 1_000;
const SSE_EVENT_TYPE_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;

export interface SseServerOptions {
  delegationsRoot: string;
  service?: InteractiveDelegationApi;
  port?: number;
  host?: "127.0.0.1";
  keepAliveIntervalMs?: number;
  allowedOrigins?: string[];
}

export interface SseServerInstance {
  server: http.Server;
  port: number;
  host: "127.0.0.1";
  url: string;
  close: () => Promise<void>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* loadHistoricalEvents(workerDir: string): AsyncGenerator<WorkerLogRecord> {
  try {
    const files = await readdir(workerDir);
    const jsonlFiles = files
      .map((file) => ({ file, match: EVENT_FILE_REGEX.exec(file) }))
      .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => {
        const attemptDelta = Number(left.match[1]) - Number(right.match[1]);
        return attemptDelta !== 0 ? attemptDelta : left.file.localeCompare(right.file);
      });

    for (const { file } of jsonlFiles) {
      const input = createReadStream(path.join(workerDir, file), { encoding: "utf8" });
      let buffer = "";
      let bufferBytes = 0;
      const parseLine = (line: string): WorkerLogRecord | undefined => {
        const trimmed = line.trim();
        if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_HISTORICAL_LINE_BYTES) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(trimmed) as WorkerLogRecord;
          if (
            parsed
            && typeof parsed === "object"
            && Number.isSafeInteger(parsed.id)
            && (parsed.id ?? 0) >= 0
          ) {
            return parsed;
          }
        } catch {
          // Skip malformed historical lines
        }
        return undefined;
      };

      for await (const chunk of input) {
        const text = String(chunk);
        buffer += text;
        bufferBytes += Buffer.byteLength(text, "utf8");
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          bufferBytes -= Buffer.byteLength(rawLine, "utf8") + 1;
          const event = parseLine(rawLine);
          if (event) yield event;
        }
        if (bufferBytes > MAX_HISTORICAL_LINE_BYTES) {
          input.destroy();
          break;
        }
      }
      if (bufferBytes <= MAX_HISTORICAL_LINE_BYTES) {
        const event = parseLine(buffer);
        if (event) yield event;
      }
    }
  } catch {
    // If the directory is unreadable, end the historical replay.
  }
}

export function createSseServer(options: SseServerOptions): http.Server {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("SSE server can only bind to 127.0.0.1");
  }

  const delegationsRoot = path.resolve(options.delegationsRoot);
  const keepAliveIntervalMs = options.keepAliveIntervalMs ?? 15_000;
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Invalid SSE allowed origin: ${origin}`);
    }
    return origin;
  }));

  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? "/", `http://127.0.0.1`);
    const origin = req.headers.origin;
    const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : undefined;

    if (origin && !allowedOrigin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin is not allowed" }));
      return;
    }
    const corsHeaders = allowedOrigin
      ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
      : {};

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control",
      });
      res.end();
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (parsedUrl.pathname === "/health" || parsedUrl.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, status: "healthy" }));
      return;
    }

    let workerId: string | undefined;
    const match = parsedUrl.pathname.match(/^\/(?:api\/)?(?:workers|delegations)\/([^/]+)\/(?:events|logs)\/?$/);
    if (match) {
      workerId = match[1];
    } else if (
      parsedUrl.pathname === "/events" ||
      parsedUrl.pathname === "/api/events" ||
      parsedUrl.pathname === "/logs" ||
      parsedUrl.pathname === "/api/logs"
    ) {
      workerId = parsedUrl.searchParams.get("worker_id") ?? parsedUrl.searchParams.get("worker") ?? undefined;
    }

    if (!workerId || !WORKER_ID_REGEX.test(workerId)) {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "Invalid or missing worker_id" }));
      return;
    }

    let fromCursor = 0;
    const cursorParam = parsedUrl.searchParams.get("cursor") ?? req.headers["last-event-id"];
    if (cursorParam !== null && cursorParam !== undefined && cursorParam !== "") {
      const parsed = Number(cursorParam);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: "Invalid cursor: cursor must be a non-negative integer" }));
        return;
      }
      fromCursor = parsed;
    }

    const workerDir = path.join(delegationsRoot, workerId);
    if (!await pathExists(workerDir)) {
      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: `Worker ${workerId} not found` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      ...corsHeaders,
      "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let lastSentId = fromCursor;
    let replaying = true;
    const pendingLiveEvents: WorkerLogRecord[] = [];
    let sendQueue = Promise.resolve();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAliveTimer);
      workerLogEmitter.removeListener(`worker:${workerId}`, onLiveEvent);
      try {
        res.end();
      } catch {
        // Ignore errors during response end
      }
    };

    const keepAliveTimer = setInterval(() => {
      if (!closed) {
        try {
          res.write(": keepalive\n\n");
        } catch {
          cleanup();
        }
      }
    }, keepAliveIntervalMs);

    req.on("close", cleanup);
    res.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);

    const sendEvent = async (event: WorkerLogRecord): Promise<boolean> => {
      if (closed) return false;
      const sanitized = sanitizeLogRecord(event) as Record<string, unknown>;
      const eventId = event.id ?? ++lastSentId;
      const eventType = typeof event.type === "string" && SSE_EVENT_TYPE_REGEX.test(event.type)
        ? event.type
        : "message";
      const payload = `id: ${eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(sanitized)}\n\n`;

      const canContinue = res.write(payload);
      lastSentId = Math.max(lastSentId, eventId);

      if (!canContinue && !closed) {
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            res.removeListener("drain", onDrain);
            res.removeListener("close", onDrain);
            resolve();
          };
          res.on("drain", onDrain);
          res.on("close", onDrain);
        });
      }
      return !closed;
    };

    const onLiveEvent = (event: WorkerLogRecord) => {
      if (closed) return;
      if (replaying) {
        if (pendingLiveEvents.length >= MAX_PENDING_LIVE_EVENTS) {
          cleanup();
          return;
        }
        pendingLiveEvents.push(event);
      } else if ((event.id ?? 0) > lastSentId) {
        sendQueue = sendQueue.then(async () => {
          await sendEvent(event);
        }).catch(() => cleanup());
      }
    };

    workerLogEmitter.on(`worker:${workerId}`, onLiveEvent);

    // Send historical events that occurred after fromCursor
    for await (const event of loadHistoricalEvents(workerDir)) {
      if (closed) break;
      if ((event.id ?? 0) > fromCursor && (event.id ?? 0) > lastSentId) {
        await sendEvent(event);
      }
    }
    replaying = false;
    pendingLiveEvents.sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
    for (const event of pendingLiveEvents) {
      if ((event.id ?? 0) > lastSentId) {
        await sendEvent(event);
      }
    }
    pendingLiveEvents.length = 0;
  });
}

export async function startSseServer(options: SseServerOptions): Promise<SseServerInstance> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("SSE server can only bind to 127.0.0.1");
  }

  const server = createSseServer(options);
  const sockets = new Set<Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  const close = async (): Promise<void> => {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore
      }
    }
    sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return {
    server,
    port: actualPort,
    host: "127.0.0.1",
    url: `http://127.0.0.1:${actualPort}`,
    close,
  };
}
