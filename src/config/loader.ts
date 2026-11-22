import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { Config, LoadedConfig, ProfileOverride } from "../types/config.ts";
import { ConfigError } from "../util/errors.ts";
import { parseJsonc, isPlainObject } from "../util/jsonc.ts";
import { deepMerge } from "../util/deep.ts";
import { expandHome } from "../util/path.ts";
import { defaultConfig } from "./defaults.ts";
import { normalizeConfig } from "./validate.ts";

export interface LoadOptions {
  /** Working directory; defaults to process.cwd(). */
  directory?: string;
  /** Explicit configuration file (replaces discovery). */
  file?: string;
  /** Profile to apply (takes precedence over config.profile and LOCALCODE_PROFILE). */
  profile?: string;
  /** Inline JSON with the highest priority. */
  content?: string;
  /** Do not search system/global config files. */
  isolated?: boolean;
}

const CONFIG_NAMES = ["localcode.json", "localcode.jsonc"];

/** Discovers configuration files from lowest to highest priority. */
export function discoverConfigFiles(cwd: string, isolated = false): string[] {
  const found: string[] = [];
  const push = (path: string) => {
    if (existsSync(path) && !found.includes(path)) found.push(path);
  };

  if (!isolated) {
    for (const name of CONFIG_NAMES) {
      push(join("/etc/localcode", name));
      push(join(homedir(), ".config", "localcode", name));
    }
  }

  // From the farthest directory to the nearest.
  const ancestors: string[] = [];
  let current = resolve(cwd);
  while (true) {
    ancestors.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const dir of ancestors) {
    for (const name of CONFIG_NAMES) push(join(dir, name));
  }
  // Configs inside .localcode take precedence over direct ones.
  for (const dir of ancestors) {
    for (const name of CONFIG_NAMES) push(join(dir, ".localcode", name));
  }

  return found;
}

/** Substitutes {env:VAR}, ${VAR}, and {file:path} in every string in the tree. */
export function substituteVariables<T>(value: T, configDir: string): T {
  if (typeof value === "string") {
    return value
      .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")
      .replace(/\{file:([^}]+)\}/g, (_, rawPath: string) => {
        const path = rawPath.startsWith("~") || rawPath.startsWith("/")
          ? expandHome(rawPath)
          : resolve(configDir, rawPath);
        try {
          return readFileSync(path, "utf8").trim();
        } catch {
          return "";
        }
      }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, configDir)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteVariables(item, configDir);
    }
    return out as T;
  }
  return value;
}

function readConfigFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  const parsed = parseJsonc(text, path);
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Configuration in ${path} must be a JSON object`);
  }
  return substituteVariables(parsed, dirname(path));
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const directory = resolve(options.directory ?? process.cwd());
  const sources: string[] = [];
  let merged: Record<string, unknown> = {};

  const files = options.file
    ? [resolve(options.file)]
    : discoverConfigFiles(directory, options.isolated);

  for (const file of files) {
    if (!existsSync(file)) {
      if (options.file) throw new ConfigError(`Configuration file does not exist: ${file}`);
      continue;
    }
    merged = deepMerge(merged, readConfigFile(file));
    sources.push(file);
  }

  if (options.content) {
    const parsed = parseJsonc(options.content, "<LOCALCODE_CONFIG_CONTENT>");
    if (!isPlainObject(parsed)) throw new ConfigError("LOCALCODE_CONFIG_CONTENT must be an object");
    merged = deepMerge(merged, substituteVariables(parsed, directory));
    sources.push("<inline>");
  }

  // The profile is resolved before being applied to itself.
  const profile =
    options.profile ??
    process.env.LOCALCODE_PROFILE ??
    (typeof merged.profile === "string" ? merged.profile : "default");

  const profileOverrides = isPlainObject(merged.profiles)
    ? (merged.profiles[profile] as ProfileOverride | undefined)
    : undefined;

  const base = defaultConfig();
  let config = normalizeConfig(deepMerge(base as unknown as Record<string, unknown>, merged) as Config);

  if (profileOverrides) {
    config = normalizeConfig(
      deepMerge(config as unknown as Record<string, unknown>, profileOverrides) as Config,
    );
  }
  config.profile = profile;

  return { config, sources, directory };
}

/** Reloads configuration from scratch (used by /reload and the watcher). */
export function reloadConfig(previous: LoadedConfig, options: LoadOptions = {}): LoadedConfig {
  return loadConfig({
    directory: previous.directory,
    file: options.file,
    profile: options.profile ?? previous.config.profile,
    content: options.content,
    isolated: options.isolated,
  });
}
