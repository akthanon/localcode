import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { matchesPattern } from "../permission/engine.ts";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", "__pycache__", ".venv", ".localcode",
]);

/** Dependency-free recursive glob engine. Supports **, *, ?, and {a,b}. */
export function globFiles(
  pattern: string,
  base: string,
  options: { hidden?: boolean; limit?: number; ignore?: string[] } = {},
): string[] {
  const limit = options.limit ?? 100;
  const results: string[] = [];
  const root = resolve(base);
  const extraIgnored = options.ignore ?? [];
  const patterns = expandBraces(pattern);

  const walk = (dir: string, depth: number) => {
    if (results.length >= limit || depth > 64) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (results.length >= limit) return;
      if (!options.hidden && name.startsWith(".")) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(name) || extraIgnored.includes(name)) continue;
        walk(full, depth + 1);
      } else {
        const rel = relative(root, full).replace(/\\/g, "/");
        if (patterns.some((p) => matchesPattern(rel, p) || matchesPattern(name, p))) {
          results.push(rel);
        }
      }
    }
  };

  walk(root, 0);
  return results.sort();
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const [whole, options] = match;
  const alternatives = options!.split(",");
  return alternatives.flatMap((alt) => expandBraces(pattern.replace(whole!, alt)));
}
