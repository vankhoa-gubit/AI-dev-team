export interface BoundedText {
  text: string;
  truncated: boolean;
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

export function formatCommand(argv: string[], platform = process.platform): string {
  return argv.map((arg) => {
    if (arg === "") return "''";
    if (/^[a-zA-Z0-9_\-./:=]+$/.test(arg)) return arg;
    return platform === "win32"
      ? `'${arg.replace(/'/g, "''")}'`
      : `'${arg.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}
