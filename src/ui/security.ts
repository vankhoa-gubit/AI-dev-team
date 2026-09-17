import { realpath } from "node:fs/promises";
import path from "node:path";

export class SecurityError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SecurityError";
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class UnsupportedMediaTypeError extends Error {
  readonly statusCode = 415;
  constructor(message = "Unsupported Media Type") {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}

export function isLoopbackHost(host: string): boolean {
  if (!host || typeof host !== "string") return false;
  const trimmed = host.trim().toLowerCase();
  if (
    trimmed === "localhost" ||
    trimmed === "127.0.0.1" ||
    trimmed === "::1" ||
    trimmed === "[::1]" ||
    trimmed === "::ffff:127.0.0.1" ||
    trimmed === "[::ffff:127.0.0.1]"
  ) {
    return true;
  }

  // Check IPv4 loopback network (127.0.0.0/8)
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (
    ipv4 &&
    ipv4[1] !== undefined &&
    ipv4[2] !== undefined &&
    ipv4[3] !== undefined &&
    ipv4[4] !== undefined
  ) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if (a === 127 && b <= 255 && c <= 255 && d <= 255) {
      return true;
    }
  }

  return false;
}

export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new SecurityError(
      `Cannot bind to non-loopback address '${host}'. Server must bind to 127.0.0.1 or localhost.`,
      400,
    );
  }
}

const RUN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

export function isValidRunId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.includes(".") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    return false;
  }
  return RUN_ID_REGEX.test(id);
}

export function assertValidRunId(id: string): void {
  if (!isValidRunId(id)) {
    throw new SecurityError("Invalid run id: must be alphanumeric with dashes or underscores", 400);
  }
}

const OPERATION_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;

export function isValidOperationId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.includes(".") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    return false;
  }
  return OPERATION_ID_REGEX.test(id);
}

export function assertValidOperationId(id: string): void {
  if (!isValidOperationId(id)) {
    throw new SecurityError("Invalid operation id: must be alphanumeric with dashes or underscores", 400);
  }
}

export async function assertSafeChildPath(baseDir: string, relativeOrChildPath: string): Promise<string> {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeOrChildPath);

  // Syntactic path traversal check
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new SecurityError("Path traversal detected", 400);
  }

  // Symlink escape check
  try {
    const realBase = await realpath(resolvedBase);
    const realTarget = await realpath(resolvedTarget);
    if (!realTarget.startsWith(realBase + path.sep) && realTarget !== realBase) {
      throw new SecurityError("Symlink escape detected", 403);
    }
    return realTarget;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return resolvedTarget;
    }
    throw error;
  }
}

export function sanitizeErrorMessage(error: unknown): { message: string; statusCode: number } {
  if (error instanceof SecurityError) {
    return { message: error.message, statusCode: error.statusCode };
  }
  if (error instanceof NotFoundError) {
    return { message: error.message, statusCode: 404 };
  }
  if (error instanceof ConflictError) {
    return { message: error.message, statusCode: 409 };
  }
  if (error instanceof UnsupportedMediaTypeError) {
    return { message: error.message, statusCode: 415 };
  }

  // Unknown or internal error: never leak stack trace or internal filesystem details
  return { message: "Internal server error", statusCode: 500 };
}
