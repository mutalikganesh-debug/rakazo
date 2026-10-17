import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAgentSecret,
  listAgentSecrets,
  putAgentSecret,
  revealAgentSecret,
} from "./agent-secrets.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

describe("agent secrets", () => {
  const put = vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" }));
  const load = vi.fn(async () => "plain-value-never-audited");
  const prisma = {
    spaceMember: {
      findUnique: vi.fn(async () => ({ role: "owner" })),
    },
    agentSecret: {
      findMany: vi.fn(async () => [
        {
          id: "as-1",
          name: "ACME_TOKEN",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ]),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: "as-1", secretId: "secret-1", name: "ACME_TOKEN" })),
      upsert: vi.fn(async () => ({
        id: "as-1",
        name: "ACME_TOKEN",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      })),
      delete: vi.fn(async () => undefined),
    },
    secret: {
      create: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    secretAudit: {
      create: vi.fn(async () => undefined),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "owner" });
  });

  it("lists secrets for space owners", async () => {
    await expect(
      listAgentSecrets({ prisma: prisma as never, secrets: { put } }, actor),
    ).resolves.toEqual([
      {
        id: "as-1",
        name: "ACME_TOKEN",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("rejects non-owners", async () => {
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "member" });
    await expect(
      listAgentSecrets({ prisma: prisma as never, secrets: { put } }, actor),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("writes a fresh key after a serialization conflict", async () => {
    prisma.secret.create.mockRejectedValueOnce({ code: "P2034" });
    put.mockResolvedValueOnce({ id: "losing", ciphertext: "deleted-ref" });
    put.mockResolvedValueOnce({ id: "winning", ciphertext: "live-ref" });
    await putAgentSecret({ prisma: prisma as never, secrets: { put } }, actor, {
      name: "ACME_TOKEN",
      value: "fake",
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(prisma.secret.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        id: "winning",
        ciphertext: "live-ref",
      }),
    });
  });

  it("puts and removes secrets", async () => {
    await putAgentSecret({ prisma: prisma as never, secrets: { put } }, actor, {
      name: "ACME_TOKEN",
      value: "super-secret",
    });
    expect(put).toHaveBeenCalled();
    expect(prisma.secret.create).toHaveBeenCalled();
    expect(prisma.agentSecret.upsert).toHaveBeenCalled();

    await expect(
      deleteAgentSecret({ prisma: prisma as never, secrets: { put } }, actor, "as-1"),
    ).resolves.toEqual({ ok: true });
    expect(prisma.agentSecret.delete).toHaveBeenCalledWith({ where: { id: "as-1" } });
  });

  it("audits a denied reveal attempt", async () => {
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "member" });
    await expect(
      revealAgentSecret({ prisma: prisma as never, secrets: { put, load } }, actor, "as-1"),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(prisma.secretAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "reveal_denied", name: "as-1" }),
    });
  });

  it("audits a failed reveal and never records the revealed value", async () => {
    prisma.agentSecret.findFirst.mockResolvedValueOnce(null);
    await expect(
      revealAgentSecret({ prisma: prisma as never, secrets: { put, load } }, actor, "as-missing"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.secretAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "reveal_denied", name: "as-missing" }),
    });

    prisma.agentSecret.findFirst.mockResolvedValueOnce({
      name: "ACME_TOKEN",
      secret: { id: "secret-1", ciphertext: "cipher" },
    });
    await expect(
      revealAgentSecret({ prisma: prisma as never, secrets: { put, load } }, actor, "as-1"),
    ).resolves.toEqual({ name: "ACME_TOKEN", value: "plain-value-never-audited" });
    expect(prisma.secretAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "reveal", name: "ACME_TOKEN" }),
    });
    expect(JSON.stringify(prisma.secretAudit.create.mock.calls)).not.toContain(
      "plain-value-never-audited",
    );
  });

  it("rate-limits reveal attempts per user", async () => {
    const floodActor = { ...actor, userId: "reveal-flood-user" };
    prisma.agentSecret.findFirst.mockResolvedValue({
      name: "ACME_TOKEN",
      secret: { id: "secret-1", ciphertext: "cipher" },
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await revealAgentSecret(
        { prisma: prisma as never, secrets: { put, load } },
        floodActor,
        "as-1",
      );
    }
    await expect(
      revealAgentSecret({ prisma: prisma as never, secrets: { put, load } }, floodActor, "as-1"),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
