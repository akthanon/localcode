/** Typed errors for clear messages in the TUI, API, and tests. */

export class LocalCodeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code: string = "LOCALCODE_ERROR", details?: unknown) {
    super(message);
    this.name = "LocalCodeError";
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends LocalCodeError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFIG_ERROR", details);
    this.name = "ConfigError";
  }
}

export class ProviderError extends LocalCodeError {
  constructor(message: string, details?: unknown) {
    super(message, "PROVIDER_ERROR", details);
    this.name = "ProviderError";
  }
}

export class PermissionDeniedError extends LocalCodeError {
  constructor(action: string, resource: string) {
    super(`Permission denied: ${action} on ${resource}`, "PERMISSION_DENIED", { action, resource });
    this.name = "PermissionDeniedError";
  }
}

export class AbortError extends LocalCodeError {
  constructor(message = "Operation cancelled") {
    super(message || "Operation cancelled", "ABORTED");
    this.name = "AbortError";
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
