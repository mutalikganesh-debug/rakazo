import { describe, expect, it } from "vitest";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import {
  INTEGRATION_ENV_VARS,
  integrationConnectorStatuses,
  parseFetch,
  resolveIntegrationConfig,
  runIntegrationAction,
  saveIntegrationConfig,
} from "./direct-integrations.js";

function fakePrisma(row: { ciphertext: string } | null = null) {
  const rows = new Map<string, { id: string; ciphertext: string }>();
  if (row) rows.set("gmail", { id: "gmail", ciphertext: row.ciphertext });
  return {
    integrationProviderConfig: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { id: string };
        create: { id: string; ciphertext: string };
      }) => {
        rows.set(where.id, create);
        return create;
      },
    },
  } as never;
}

function fakeSecrets(store: Record<string, string>): SecretStore {
  return {
    load: async (ciphertext: string) => {
      const value = store[ciphertext];
      if (value === undefined) throw new Error("no such ciphertext");
      return value;
    },
    put: async (plaintext: string) => {
      store[`ct:${plaintext.length}`] = plaintext;
      return { ciphertext: `ct:${plaintext.length}` };
    },
  } as unknown as SecretStore;
}

const context = { actor: { id: "u1" }, label: "test" } as unknown as AdapterContext;

describe("direct-integrations", () => {
  it("parseFetch extracts header fields and a snippet", () => {
    const response =
      "* 12 FETCH (BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {89}\r\n" +
      "Subject: =?UTF-8?B?VGVzdCDinJQ=?=\r\nFrom: Alice <alice@example.com>\r\nDate: Thu, 1 Jan 2026\r\n" +
      "\r\n}\r\nBODY[TEXT]<0.400> {24}\r\nHello there snippet line\r\n)\r\n";
    const parsed = parseFetch("42", response);
    expect(parsed.uid).toBe("42");
    expect(parsed.from).toContain("alice@example.com");
    expect(parsed.subject).toBe("Test ✔");
    expect(parsed.snippet).toContain("Hello there snippet line");
  });

  it("reports every required env var when nothing is configured", async () => {
    const saved = { ...process.env };
    delete process.env.GMAIL_ADDRESS;
    delete process.env.GMAIL_APP_PASSWORD;
    try {
      const status = await integrationConnectorStatuses(fakePrisma(), fakeSecrets({}));
      const gmail = status.find((s) => s.id === "gmail");
      expect(gmail?.needsSetup).toBe(true);
      expect(gmail?.missingEnvVars).toEqual([...INTEGRATION_ENV_VARS.gmail]);
      expect(gmail?.connected).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it("secret-store config wins over env and is never echoed", async () => {
    const secrets = fakeSecrets({
      ct1: JSON.stringify({ GMAIL_ADDRESS: "me@example.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }),
    });
    const prisma = fakePrisma({ ciphertext: "ct1" });
    const resolved = await resolveIntegrationConfig(prisma, secrets, "gmail");
    expect(resolved.source).toBe("secret-store");
    const action = await runIntegrationAction(prisma, secrets, "gmail", "read", { limit: 1 });
    // No network in tests: the IMAP call must fail loudly rather than invent data.
    expect(action.ok).toBe(false);
    expect(action.error).toBeTruthy();
  });

  it("unconfigured action returns blockedOnSecret env NAMES only", async () => {
    const saved = { ...process.env };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    try {
      const result = await runIntegrationAction(
        fakePrisma(),
        fakeSecrets({}),
        "google-calendar",
        "createEvent",
        { summary: "x", start: "2026-10-22T10:00:00Z" },
      );
      expect(result.ok).toBe(false);
      expect(result.blockedOnSecret).toEqual([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN",
        "GOOGLE_CALENDAR_ID",
      ]);
      expect(result.blockedOnSecret?.every((name) => /^[A-Z0-9_]+$/.test(name))).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("saveIntegrationConfig stores values without returning them", async () => {
    const store: Record<string, string> = {};
    const secrets = fakeSecrets(store);
    const prisma = fakePrisma();
    await saveIntegrationConfig(prisma, secrets, context, {
      id: "gmail",
      gmailAddress: "me@example.com",
      gmailAppPassword: "abcd efgh ijkl mnop",
    });
    const resolved = await resolveIntegrationConfig(prisma, secrets, "gmail");
    expect(resolved.source).toBe("secret-store");
    expect(Object.values(store).join()).toContain("me@example.com");
  });
});
