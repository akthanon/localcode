import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolvePath(path: string, base: string): string {
  return resolve(base, expandHome(path));
}

/** Converts a path into a safe identifier. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/** Checks that `target` is inside `root` (path traversal protection). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function normalizeRelative(path: string, base: string): string {
  const norm = normalize(path);
  if (isAbsolute(norm)) return norm;
  return relative(base, resolve(base, norm));
}
