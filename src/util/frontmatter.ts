import { isPlainObject, parseJsonc } from "./jsonc.ts";

/** Minimal YAML frontmatter parser (enough for agents/skills/commands). */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { data: {}, body: normalized };

  const lines = match[1]!.split("\n");
  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const [, key, rawValue] = kv;
    const value = rawValue!.trim();

    if (value === "" || value === "|" || value === ">") {
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j]!)) {
        const item = lines[j]!.replace(/^\s+-\s+/, "").trim();
        const nested = item.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (nested) {
          const obj: Record<string, unknown> = {};
          obj[nested[1]!] = parseScalar(nested[2]!);
          j++;
          while (j < lines.length && /^\s{4,}[A-Za-z_]/.test(lines[j]!)) {
            const more = lines[j]!.trim().match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
            if (more) obj[more[1]!] = parseScalar(more[2]!);
            j++;
          }
          items.push(obj);
        } else {
          items.push(parseScalar(item));
          j++;
        }
      }
      if (items.length) {
        data[key!] = items;
        i = j;
        continue;
      }
      // Multi-line text block.
      const block: string[] = [];
      j = i + 1;
      while (j < lines.length && /^\s+/.test(lines[j]!)) {
        block.push(lines[j]!.trim());
        j++;
      }
      data[key!] = block.join(value === "|" ? "\n" : " ");
      i = j;
      continue;
    }

    data[key!] = parseScalar(value);
    i++;
  }

  return { data, body: normalized.slice(match[0].length).trim() };
}

function parseScalar(value: string): unknown {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("{") || v.startsWith("[")) {
    try {
      return parseJsonc(v);
    } catch {
      return v;
    }
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function frontmatterRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
