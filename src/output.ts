export interface BoundedText {
  text: string;
  truncated: boolean;
}

export interface TextPage {
  text: string;
  cursor: number;
  nextCursor?: number;
  returnedLines: number;
  totalLines: number;
  totalBytes: number;
  truncatedLine: boolean;
}

export function boundText(raw: string, maxBytes: number, maxLines: number): BoundedText {
  const result: string[] = [];
  let bytes = 0;
  let truncated = false;
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (index >= maxLines || bytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    result.push(line);
    bytes += lineBytes;
  }
  if (truncated) {
    result.push("", "[diff truncated: maximum size limit reached]");
  }
  return { text: result.join("\n"), truncated };
}

export function pageText(raw: string, cursor: number, maxBytes: number, maxLines: number): TextPage {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error("Text page cursor must be a non-negative integer");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("Text page limits must be positive integers");
  }

  const lines = raw ? raw.split(/\r?\n/) : [];
  if (cursor > lines.length) {
    throw new Error(`Text page cursor ${cursor} exceeds total line count ${lines.length}`);
  }

  const result: string[] = [];
  let bytes = 0;
  let index = cursor;
  let truncatedLine = false;
  while (index < lines.length && result.length < maxLines) {
    const line = lines[index] ?? "";
    const separatorBytes = result.length > 0 ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + separatorBytes + lineBytes > maxBytes) {
      if (result.length === 0) {
        const buffer = Buffer.from(line, "utf8");
        result.push(buffer.subarray(0, maxBytes).toString("utf8"));
        truncatedLine = true;
        index += 1;
      }
      break;
    }
    result.push(line);
    bytes += separatorBytes + lineBytes;
    index += 1;
  }

  return {
    text: result.join("\n"),
    cursor,
    ...(index < lines.length ? { nextCursor: index } : {}),
    returnedLines: index - cursor,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(raw, "utf8"),
    truncatedLine,
  };
}

export function formatCommand(argv: string[], platform = process.platform): string {
  return argv.map((arg) => {
    if (arg === "") return "''";
    if (/^[a-zA-Z0-9_\-./:=]+$/.test(arg)) return arg;
    return platform === "win32"
      ? `'${arg.replace(/'/g, "''")}'`
      : `'${arg.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}
