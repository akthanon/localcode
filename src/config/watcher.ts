import { watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Runtime } from "../runtime.ts";
import { logger } from "../util/logger.ts";

export interface ConfigWatchOptions {
  debounceMs?: number;
  enabled?: boolean;
}

export interface ConfigWatcher {
  close(): void;
}

/**
 * Watches every discovered localcode.json / localcode.jsonc file and reloads
 * the runtime in place. Editors often rename/replace files, so the parent
 * directories are watched instead of the files themselves.
 */
export function watchConfig(runtime: Runtime, options: ConfigWatchOptions = {}): ConfigWatcher {
  if (options.enabled === false) return { close() {} };

  const debounceMs = options.debounceMs ?? 200;
  const dirs = new Set<string>([runtime.directory, join(runtime.directory, ".localcode")]);
  for (const source of runtime.loaded.sources) {
    if (source.startsWith("<")) continue;
    dirs.add(dirname(resolve(source)));
  }

  const log = logger.child("config-watch");
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let reloading = false;
  let pending = false;

  const apply = async (): Promise<void> => {
    if (reloading) {
      pending = true;
      return;
    }
    reloading = true;
    try {
      await runtime.reload();
    } catch (error) {
      log.warn("Config reload failed", String(error));
      runtime.emit({ type: "error", error: `Config reload failed: ${String(error)}` });
    } finally {
      reloading = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void apply();
    }, debounceMs);
  };

  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : "";
        if (/^localcode\.jsonc?$/i.test(name)) schedule();
      });
      watcher.on("error", () => {
        // Transient rename events are normal with atomic editors.
      });
      watchers.push(watcher);
    } catch {
      // A missing watched directory is harmless.
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
