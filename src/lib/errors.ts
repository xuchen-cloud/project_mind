const ERROR_PREFIX = /^Error:\s*/i;

export function getErrorMessage(error: unknown, fallback = "发生未知错误") {
  if (!error) {
    return fallback;
  }

  if (typeof error === "string") {
    return normalizeErrorText(error, fallback);
  }

  if (error instanceof Error) {
    return normalizeErrorText(error.message, fallback);
  }

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const directMessage = firstStringField(record, ["message", "error", "detail"]);
    if (directMessage) {
      return normalizeErrorText(directMessage, fallback);
    }

    const cause = record.cause;
    if (cause) {
      return getErrorMessage(cause, fallback);
    }
  }

  return normalizeErrorText(String(error), fallback);
}

function firstStringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function normalizeErrorText(value: string, fallback: string) {
  const trimmed = value.trim().replace(ERROR_PREFIX, "").trim();
  return trimmed || fallback;
}
