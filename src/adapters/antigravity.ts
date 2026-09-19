import { EventEmitter, once } from "node:events";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import { assertProcessSucceeded, runProcess } from "../process.js";
import {
  WorkerResultSchema,
  type ProcessResult,
  type TaskSpec,
  type WorkerLogRecord,
  type WorkerResult,
  type WorkerRunResult,
} from "../types.js";

export interface Worker {
  run(
    task: TaskSpec,
    jobDirectory: string,
    revisionFeedback?: string,
    conversationId?: string,
    signal?: AbortSignal,
    attemptNumber?: number,
  ): Promise<WorkerRunResult>;
}

export const workerLogEmitter = new EventEmitter();
const EVENTS_PER_ATTEMPT = 1_000_000;

export function sanitizeLogRecord(record: unknown, maxStringLength: number = 32 * 1024): unknown {
  if (typeof record === "string") {
    let sanitized = record
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
      .replace(/AIza[A-Za-z0-9_-]{31,35}/g, "[REDACTED_API_KEY]")
      .replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, "[REDACTED_GH_TOKEN]")
      .replace(/(["']?(?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}(["']?)/gi, "$1[REDACTED]$2")
      .replace(/(["']?Authorization["']?\s*:\s*["']?)[^"',\s]+(["']?)/gi, "$1[REDACTED]$2");

    if (sanitized.length > maxStringLength) {
      sanitized = sanitized.slice(0, maxStringLength) + "... [truncated]";
    }
    return sanitized;
  }

  if (Array.isArray(record)) {
    return record.map((item) => sanitizeLogRecord(item, maxStringLength));
  }

  if (record && typeof record === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      const sanitizedString = typeof value === "string"
        ? sanitizeLogRecord(value, maxStringLength)
        : value;
      if (typeof value === "string" && sanitizedString !== value) {
        result[key] = sanitizedString;
      } else if (
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("credential") ||
        lowerKey.includes("privatekey") ||
        lowerKey.includes("private_key") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("api_key") ||
        lowerKey.includes("api-key") ||
        (lowerKey.includes("token") && !lowerKey.includes("tokens"))
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeLogRecord(value, maxStringLength);
      }
    }
    return result;
  }

  return record;
}

const AntigravityEnvelopeSchema = z.object({
  conversation_id: z.string().min(1).optional(),
  status: z.string().optional(),
  response: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  denied_actions: z.array(z.unknown()).optional(),
}).passthrough();

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed);
}

export class StreamJsonParser {
  private buffer = "";
  private bufferBytes = 0;
  private eventId: number;
  private readonly maximumEventId: number;
  private readonly maxLineBytes: number;
  private readonly onEvent?: ((event: WorkerLogRecord) => void) | undefined;
  private conversationId?: string | undefined;
  private workerResult?: WorkerResult | undefined;
  private deniedActions: unknown[] = [];
  private hasResult = false;
  private providerError?: string | undefined;

  constructor(options: {
    maxLineBytes?: number | undefined;
    initialEventId?: number | undefined;
    onEvent?: ((event: WorkerLogRecord) => void) | undefined;
  } = {}) {
    this.maxLineBytes = options.maxLineBytes ?? 2 * 1024 * 1024;
    this.eventId = options.initialEventId ?? 0;
    this.maximumEventId = this.eventId + EVENTS_PER_ATTEMPT;
    if (options.onEvent !== undefined) {
      this.onEvent = options.onEvent;
    }
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, "utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.bufferBytes -= Buffer.byteLength(rawLine, "utf8") + 1;
      const line = rawLine.trim();
      if (line) {
        this.parseLine(line);
      }
    }
    if (this.bufferBytes > this.maxLineBytes) {
      throw new Error("Antigravity stream exceeded maximum line size");
    }
  }

  private parseLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new Error("Antigravity stream exceeded maximum line size");
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch (err) {
      throw new Error(`Antigravity stream contained malformed JSON: ${String(err)}`);
    }

    if (!record || typeof record !== "object") {
      throw new Error("Antigravity stream record is not an object");
    }

    const declaredType = typeof record.type === "string"
      ? record.type
      : typeof record.event === "string"
        ? record.event
        : "record";
    const nestedResult = declaredType === "result"
      && record.result
      && typeof record.result === "object"
      && !Array.isArray(record.result)
      ? record.result as Record<string, unknown>
      : undefined;
    const envelope = nestedResult ?? record;

    const rawConversationId = envelope.conversation_id ?? record.conversation_id;
    if (typeof rawConversationId === "string" && rawConversationId.trim()) {
      this.conversationId = rawConversationId.trim();
    }

    const deniedActions = envelope.denied_actions ?? record.denied_actions;
    if (Array.isArray(deniedActions) && deniedActions.length > 0) {
      this.deniedActions.push(...deniedActions);
    }

    const providerError = envelope.error ?? record.error;
    if (providerError) {
      this.providerError = typeof providerError === "string" ? providerError : JSON.stringify(providerError);
    }

    let recordType = declaredType;
    const status = envelope.status ?? record.status;

    if (
      recordType === "result" ||
      envelope.structured_output !== undefined ||
      envelope.response !== undefined
    ) {
      recordType = "result";
      this.hasResult = true;

      if (this.deniedActions.length > 0) {
        throw new Error(`Antigravity denied required actions: ${JSON.stringify(this.deniedActions)}`);
      }

      if (status && String(status).toUpperCase() !== "SUCCESS") {
        throw new Error(`Antigravity returned status ${String(status)}`);
      }

      let structured: unknown;
      try {
        structured = parseJsonValue(envelope.structured_output);
        if (structured === undefined) {
          structured = parseJsonValue(envelope.response);
        }
        if (structured === undefined && nestedResult === undefined && record.result !== undefined) {
          structured = parseJsonValue(record.result);
        }
        if (structured === undefined && WorkerResultSchema.safeParse(envelope).success) {
          structured = envelope;
        }
      } catch (error) {
        throw new Error(`Antigravity returned invalid structured JSON: ${String(error)}`);
      }

      if (structured === undefined) {
        throw new Error("Antigravity reported success but returned empty structured output");
      }

      const result = WorkerResultSchema.parse(structured);
      this.workerResult = result;
    } else if (recordType === "init" || ((!record.type && !record.event) && record.conversation_id && !this.workerResult)) {
      recordType = "init";
    } else if (recordType === "step_update") {
      recordType = "step_update";
    }

    const sanitized = sanitizeLogRecord(record);
    if (this.eventId >= this.maximumEventId) {
      throw new Error(`Antigravity stream exceeded ${EVENTS_PER_ATTEMPT} events in one attempt`);
    }
    const event: WorkerLogRecord = {
      ...(sanitized as Record<string, unknown>),
      id: ++this.eventId,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
      type: recordType,
    };

    this.onEvent?.(event);
  }

  finish(): { workerResult: WorkerResult; conversationId?: string } {
    if (this.buffer.trim()) {
      this.parseLine(this.buffer.trim());
      this.buffer = "";
      this.bufferBytes = 0;
    }

    if (this.deniedActions.length > 0) {
      throw new Error(`Antigravity denied required actions: ${JSON.stringify(this.deniedActions)}`);
    }

    if (this.providerError) {
      throw new Error(`Antigravity provider error: ${this.providerError}`);
    }

    if (!this.hasResult || !this.workerResult) {
      throw new Error("Antigravity stream ended without a valid result record");
    }

    const finalResult = this.conversationId !== undefined
      ? { ...this.workerResult, conversation_id: this.conversationId }
      : this.workerResult;

    const returnObj: { workerResult: WorkerResult; conversationId?: string } = {
      workerResult: finalResult,
    };
    if (this.conversationId !== undefined) {
      returnObj.conversationId = this.conversationId;
    }
    return returnObj;
  }
}

export function parseAntigravityOutput(raw: string): WorkerResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Antigravity returned empty output");
  }

  if (!trimmed.includes("\n")) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Antigravity returned invalid structured JSON: ${String(error)}`);
    }

    const envelope = AntigravityEnvelopeSchema.parse(parsedJson);
    const deniedActions = envelope.denied_actions ?? [];
    if (deniedActions.length > 0) {
      throw new Error(`Antigravity denied required actions: ${JSON.stringify(deniedActions)}`);
    }

    if (envelope.status && envelope.status.toUpperCase() !== "SUCCESS") {
      throw new Error(`Antigravity returned status ${envelope.status}`);
    }

    let structured: unknown;
    try {
      structured = parseJsonValue(envelope.structured_output);
      if (structured === undefined) {
        structured = parseJsonValue(envelope.response);
      }
    } catch (error) {
      throw new Error(`Antigravity returned invalid structured JSON: ${String(error)}`);
    }

    if (structured === undefined) {
      throw new Error("Antigravity reported success but returned empty structured output");
    }

    const result = WorkerResultSchema.parse(structured);
    return envelope.conversation_id
      ? { ...result, conversation_id: envelope.conversation_id }
      : result;
  }

  const parser = new StreamJsonParser();
  parser.feed(trimmed + "\n");
  const { workerResult } = parser.finish();
  return workerResult;
}

export class AntigravityAdapter implements Worker {
  constructor(
    private readonly config: HarnessConfig["antigravity"],
    private readonly harnessRoot: string,
  ) {}

  async run(
    task: TaskSpec,
    jobDirectory: string,
    revisionFeedback?: string,
    conversationId?: string,
    signal?: AbortSignal,
    attemptNumber?: number,
  ): Promise<WorkerRunResult> {
    const promptTemplate = await readFile(path.join(this.harnessRoot, "prompts", "worker.md"), "utf8");
    const taskPath = path.join(jobDirectory, "task.json");
    const schemaPath = path.join(this.harnessRoot, "schemas", "worker-result.schema.json");
    const promptParts = [
      promptTemplate,
      "",
      `Read the task contract at @${taskPath} and implement it now.`,
    ];
    if (revisionFeedback) {
      promptParts.push("", "Revision feedback:", revisionFeedback);
    }

    const args = [
      "--print",
      promptParts.join("\n"),
      "--sandbox",
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaPath,
      "--mode",
      "accept-edits",
      "--effort",
      this.config.effort,
      "--print-timeout",
      `${Math.ceil(this.config.timeoutMs / 1000)}s`,
      "--add-dir",
      task.worktree_path,
      "--add-dir",
      jobDirectory,
    ];
    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    if (conversationId) {
      args.push("--conversation", conversationId);
    }

    const runNumber = Date.now();
    const attempt = attemptNumber ?? 1;
    const jsonlPath = path.join(jobDirectory, `worker-attempt-${attempt}-${runNumber}.events.jsonl`);
    const stderrPath = path.join(jobDirectory, `worker-attempt-${attempt}-${runNumber}.stderr.log`);

    const jsonlStream = createWriteStream(jsonlPath, { flags: "a", encoding: "utf8" });
    const stderrStream = createWriteStream(stderrPath, { flags: "a", encoding: "utf8" });
    let streamError: Error | undefined;
    jsonlStream.on("error", (error) => { streamError = error; });
    stderrStream.on("error", (error) => { streamError = error; });
    try {
      await Promise.all([once(jsonlStream, "open"), once(stderrStream, "open")]);
    } catch (error) {
      jsonlStream.destroy();
      stderrStream.destroy();
      throw error;
    }

    const writeWithBackpressure = async (
      stream: typeof jsonlStream,
      content: string,
    ): Promise<void> => {
      if (streamError) throw streamError;
      if (stream.destroyed || stream.closed) {
        throw new Error("Antigravity log stream closed before the worker finished");
      }
      if (!stream.write(content)) {
        await once(stream, "drain");
      }
      if (streamError) throw streamError;
    };

    const pendingJsonl: string[] = [];

    const parser = new StreamJsonParser({
      initialEventId: (attempt - 1) * EVENTS_PER_ATTEMPT,
      onEvent: (event) => {
        pendingJsonl.push(`${JSON.stringify(event)}\n`);
        workerLogEmitter.emit(`worker:${task.id}`, event);
        workerLogEmitter.emit("log", { workerId: task.id, event });
      },
    });

    try {
      const processResult: ProcessResult = await runProcess(this.config.command, args, {
        cwd: task.worktree_path,
        timeoutMs: this.config.timeoutMs + 30_000,
        ...(signal ? { signal } : {}),
        onStdoutChunk: async (chunk) => {
          parser.feed(chunk);
          if (pendingJsonl.length > 0) {
            const content = pendingJsonl.splice(0).join("");
            await writeWithBackpressure(jsonlStream, content);
          }
        },
        onStderrChunk: async (chunk) => {
          await writeWithBackpressure(stderrStream, chunk);
        },
      });
      assertProcessSucceeded(processResult, "Antigravity worker");
      const { workerResult } = parser.finish();
      if (pendingJsonl.length > 0) {
        await writeWithBackpressure(jsonlStream, pendingJsonl.splice(0).join(""));
      }
      return {
        result: workerResult,
        process: processResult,
      };
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => {
          if (stderrStream.destroyed || stderrStream.closed) {
            resolve();
          } else {
            stderrStream.end(() => resolve());
            stderrStream.once("finish", resolve);
            stderrStream.once("close", resolve);
            stderrStream.once("error", () => resolve());
          }
        }),
        new Promise<void>((resolve) => {
          if (jsonlStream.destroyed || jsonlStream.closed) {
            resolve();
          } else {
            jsonlStream.end(() => resolve());
            jsonlStream.once("finish", resolve);
            jsonlStream.once("close", resolve);
            jsonlStream.once("error", () => resolve());
          }
        }),
      ]);
      if (streamError) throw streamError;
    }
  }
}
