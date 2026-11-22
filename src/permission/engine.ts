import type { Config, PermissionEffect, PermissionRule } from "../types/config.ts";
import { PermissionDeniedError } from "../util/errors.ts";

/** Glob-style wildcard matching on a string. */
export function matchesPattern(resource: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regex}$`).test(resource);
  } catch {
    return resource === pattern;
  }
}

export type PermissionPrompter = (
  action: string,
  resource: string,
  description: string,
) => Promise<boolean>;

/** Permission engine with ordered rules; the last match wins. */
export class PermissionEngine {
  private rules: PermissionRule[];
  private prompter?: PermissionPrompter;
  /** In auto mode, "ask" is approved (non-interactive runs and tests). */
  autoApprove = false;

  constructor(config: Config, agentRules: PermissionRule[] = []) {
    this.rules = [...config.permissions, ...agentRules];
  }

  withAgentRules(rules: PermissionRule[]): PermissionEngine {
    const engine = new PermissionEngine({ permissions: [] } as Config);
    engine.rules = [...this.rules, ...rules];
    engine.prompter = this.prompter;
    engine.autoApprove = this.autoApprove;
    return engine;
  }

  setPrompter(prompter: PermissionPrompter): void {
    this.prompter = prompter;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** Replaces the global rules after a config reload, preserving the prompter. */
  replaceRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  evaluate(action: string, resource: string): PermissionEffect {
    let effect: PermissionEffect = this.defaultEffect(action);
    for (const rule of this.rules) {
      if (matchesPattern(action, rule.action) && matchesPattern(resource, rule.resource)) {
        effect = rule.effect;
      }
    }
    return effect;
  }

  private defaultEffect(action: string): PermissionEffect {
    if (action === "bash" || action === "subagent" || action === "question") return "ask";
    return "allow";
  }

  async authorize(action: string, resource: string, description = ""): Promise<boolean> {
    const effect = this.evaluate(action, resource);
    if (effect === "deny") throw new PermissionDeniedError(action, resource);
    if (effect === "allow") return true;
    if (this.autoApprove) return true;
    if (!this.prompter) return false;
    return this.prompter(action, resource, description || `${action}: ${resource}`);
  }
}
