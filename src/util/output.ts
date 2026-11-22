import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** Truncates tool output so it does not blow up the local model's context. */
export function truncateOutput(input: string, options: TruncateOptions = {}): TruncateResult {
  const maxLines = options.maxLines ?? 2000;
  const maxBytes = options.maxBytes ?? 51_200;
  let text = input;
  let truncated = false;

  if (text.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (truncated) text += "\n…[output truncated]";
  return { text, truncated };
}

export interface ManagedOutputOptions {
  directory: string;
  sessionID: string;
  callID?: string;
  previewBytes: number;
  previewLines: number;
  saveFullOutput: boolean;
}

export interface ManagedOutput {
  text: string;
  fullPath?: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

function safeID(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

/**
 * Keeps the model's context bounded. Large output is stored in a managed file
 * and only a head/tail preview plus the file path is returned, the same pattern
 * OpenCode uses for noisy tools.
 */
export function prepareToolOutput(input: string, options: ManagedOutputOptions): ManagedOutput {
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const lines = normalized.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(normalized, "utf8");
  const maxBytes = Math.max(512, options.previewBytes || 8192);
  const maxLines = Math.max(10, options.previewLines || 120);
  const truncated = totalBytes > maxBytes || totalLines > maxLines;

  if (!truncated) {
    return { text: normalized, truncated: false, totalLines, totalBytes };
  }

  const headCount = Math.ceil(maxLines / 2);
  const tailCount = Math.max(0, maxLines - headCount);
  const head = lines.slice(0, headCount);
  const tail = tailCount ? lines.slice(-tailCount) : [];
  const omitted = Math.max(0, totalLines - head.length - tail.length);

  const relative = join(
    ".localcode",
    "output",
    safeID(options.sessionID),
    `${safeID(options.callID ?? `tool-${Date.now()}`)}.log`,
  );
  let fullPath: string | undefined;
  if (options.saveFullOutput) {
    const absolute = join(options.directory, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, normalized, "utf8");
    fullPath = relative;
  }

  const marker = fullPath
    ? `…[${omitted} lines omitted; full output: ${fullPath}]…`
    : `…[${omitted} lines omitted; saveFullOutput is disabled]…`;
  let body = `${head.join("\n")}\n${marker}\n${tail.join("\n")}`.trimEnd();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    body = `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n…[preview truncated]`;
  }
  const hint = fullPath
    ? `\n\nFull output saved to: ${fullPath}\nUse read with offset/limit, or grep/head/tail, to inspect it. Do not re-run the command just to see the full output.`
    : "";

  return { text: `${body}${hint}`, fullPath, truncated: true, totalLines, totalBytes };
}

/** Numbers lines for the read tool, with offset and limit. */
export function numberedLines(text: string, offset = 1, limit = 2000): string {
  const lines = text.split("\n");
  const start = Math.max(0, offset - 1);
  const selected = lines.slice(start, start + limit);
  return selected
    .map((line, index) => {
      const shortened = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
      return `${String(start + index + 1).padStart(5, " ")}: ${shortened}`;
    })
    .join("\n");
}
