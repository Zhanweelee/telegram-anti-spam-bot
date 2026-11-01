const FORBIDDEN_FIELD_KEYS = new Set([
  "text",
  "body",
  "caption",
  "raw",
  "messageText",
  "content",
]);

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields;
}

export function sanitizeFields(fields?: LogFields): LogFields {
  const next: Record<string, string | number | boolean> = {};
  if (!fields) {
    return next;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function wrapLogger(logger: Logger): Logger {
  return {
    info(message, fields) {
      logger.info(message, sanitizeFields(fields));
    },
    warn(message, fields) {
      logger.warn(message, sanitizeFields(fields));
    },
    error(message, fields) {
      logger.error(message, sanitizeFields(fields));
    },
  };
}

export function createMemoryLogger(): Logger & {
  readonly entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const push = (
    level: LogEntry["level"],
    message: string,
    fields?: LogFields,
  ): void => {
    entries.push({ level, message, fields: sanitizeFields(fields) });
  };
  return {
    entries,
    info(message, fields) {
      push("info", message, fields);
    },
    warn(message, fields) {
      push("warn", message, fields);
    },
    error(message, fields) {
      push("error", message, fields);
    },
  };
}
