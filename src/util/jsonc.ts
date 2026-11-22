/** Minimal, robust JSONC parser: line and block comments, trailing commas, escaped strings. */

import { ConfigError } from "./errors.ts";

function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Remove trailing commas before } or ] (outside strings, which are copied verbatim).
  return out.replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonc(text: string, source = "<jsonc>"): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse ${source}: ${message}`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
