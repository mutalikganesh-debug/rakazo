const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name || "Error",
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|secret|token|authorization|apikey|api_key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi;
const JSON_SECRET_FIELD =
  /"(password|passwd|secret|token|authorization|apikey|api_key|accesstoken|refreshtoken|email|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const BARE_SECRET =
  /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9]{6,})\b/g;

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(JSON_SECRET_FIELD, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET, REDACTED);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}

/** A known secret value with its stable vault name, for [REDACTED:name] masks. */
export type NamedSecret = { name: string; value: string };

// Short values would mask ordinary prose; real credentials are far longer.
const NAMED_MIN_LENGTH = 8;

/**
 * Leak-guard for outbound content (model providers, tool payloads): known secret values
 * become [REDACTED:name], common key material becomes [REDACTED:bearer] / [REDACTED:api-key] /
 * [REDACTED:<field>]. Named values run first so a vault value keeps its stable name even when
 * the value itself looks like a key.
 */
export function redactLeaks(text: string, named: readonly NamedSecret[] = []): string {
  let out = text;
  const values = named
    .filter((secret) => secret.value.length >= NAMED_MIN_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
  for (const secret of values) {
    out = out.split(secret.value).join(`[REDACTED:${secret.name}]`);
  }
  return out
    .replace(JSON_SECRET_FIELD, (_match, key: string) => `"${key}":"[REDACTED:${key}]"`)
    .replace(BEARER, "Bearer [REDACTED:bearer]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED:${key.toLowerCase()}]`)
    .replace(BARE_SECRET, "[REDACTED:api-key]");
}

/**
 * Deep variant for stored/sent content (message blocks, event payloads): scrubs
 * every string inside a JSON-ish value, leaving non-strings untouched.
 */
export function redactLeaksDeep(value: unknown, named: readonly NamedSecret[] = []): unknown {
  if (typeof value === "string") return redactLeaks(value, named);
  if (Array.isArray(value)) return value.map((item) => redactLeaksDeep(item, named));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactLeaksDeep(nested, named)]),
    );
  }
  return value;
}
