/** Utilities for deep configuration merging. */

import { isPlainObject } from "./jsonc.ts";

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override) || !isPlainObject(base)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/** Like deepMerge, but skips keys with undefined values. */
export function deepMergeDefined<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return deepMerge(base, cleaned);
}

export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
