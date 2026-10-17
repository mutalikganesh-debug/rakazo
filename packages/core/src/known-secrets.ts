/**
 * Registry of secret values that must never echo into stored or sent bot reply
 * text. Reply redaction runs at the shared message/event chokepoints where no run
 * context exists, so anything that resolves a secret registers it here first.
 */
export type KnownSecret = { name: string; value: string };

// Short values would mask ordinary prose; real credentials are far longer.
const MIN_LENGTH = 8;

const known = new Map<string, KnownSecret>();

export function registerKnownSecrets(entries: ReadonlyArray<string | KnownSecret>): void {
  for (const entry of entries) {
    const named = typeof entry === "string" ? { name: "secret", value: entry } : entry;
    if (named.value.length >= MIN_LENGTH) known.set(named.value, named);
  }
}

export function knownSecrets(): KnownSecret[] {
  return [...known.values()];
}

export function clearKnownSecrets(): void {
  known.clear();
}
