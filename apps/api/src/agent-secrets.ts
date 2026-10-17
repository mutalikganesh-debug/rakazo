import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { persistPreparedSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { registerKnownSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";

type AgentSecretDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

function agentSecretDto(row: { id: string; name: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  const roles = membership?.role.split(",").map((role) => role.trim());
  if (!roles?.includes("owner")) throw new ORPCError("FORBIDDEN");
}

export async function listAgentSecrets(deps: AgentSecretDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  const rows = await deps.prisma.agentSecret.findMany({
    where: { spaceId: actor.spaceId },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  return rows.map(agentSecretDto);
}

export async function putAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  input: { name: string; value: string },
  signal = new AbortController().signal,
) {
  await requireSpaceOwner(deps.prisma, actor);
  // Reply leak-guard: a vault value must never echo back into a bot reply.
  registerKnownSecrets([{ name: input.name, value: input.value }]);
  const row = await withTransactionRetry(async () => {
    const stored = await deps.secrets.put(input.value, {
      operationId: `agent-secret:${input.name}`,
      traceId: `agent-secret:${input.name}`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal,
    });
    return persistPreparedSecret(deps.prisma, deps.secrets, stored, () =>
      deps.prisma.$transaction(
        async (tx) => {
          const existing = await tx.agentSecret.findUnique({
            where: { spaceId_name: { spaceId: actor.spaceId, name: input.name } },
            select: { secretId: true },
          });
          await tx.secret.create({
            data: {
              id: stored.id,
              userId: actor.userId,
              spaceId: actor.spaceId,
              kind: "agent-environment",
              ciphertext: stored.ciphertext,
            },
          });
          const updated = await tx.agentSecret.upsert({
            where: { spaceId_name: { spaceId: actor.spaceId, name: input.name } },
            create: {
              spaceId: actor.spaceId,
              createdByUserId: actor.userId,
              name: input.name,
              secretId: stored.id,
            },
            update: {
              createdByUserId: actor.userId,
              secretId: stored.id,
            },
          });
          if (existing && existing.secretId !== stored.id) {
            await tx.secret.deleteMany({
              where: { id: existing.secretId, spaceId: actor.spaceId },
            });
          }
          await tx.secretAudit.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: updated.name,
              action: existing ? "update" : "add",
            },
          });
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  });
  return agentSecretDto(row);
}

export async function deleteAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true }> {
  await requireSpaceOwner(deps.prisma, actor);
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.agentSecret.findFirst({
          where: { id, spaceId: actor.spaceId },
          select: { id: true, secretId: true, name: true },
        });
        if (!existing) throw new ORPCError("NOT_FOUND");
        await tx.agentSecret.delete({ where: { id: existing.id } });
        await tx.secret.deleteMany({
          where: { id: existing.secretId, spaceId: actor.spaceId },
        });
        await tx.secretAudit.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: existing.name,
            action: "delete",
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true };
}

// Per-user reveal rate limit (sliding window).
// ponytail: per-process memory — share via the RateLimit table if api ever scales out
const REVEAL_RATE = { windowMs: 60_000, max: 10 };
const revealAttempts = new Map<string, number[]>();

function revealRateLimited(userId: string, now = Date.now()): boolean {
  const recent = (revealAttempts.get(userId) ?? []).filter((at) => now - at < REVEAL_RATE.windowMs);
  recent.push(now);
  revealAttempts.set(userId, recent);
  return recent.length > REVEAL_RATE.max;
}

export async function revealAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  id: string,
): Promise<{ name: string; value: string }> {
  // Denied and failed attempts are audited too — a probing attacker must be visible.
  // Rate-limited attempts are not: the limit is what bounds audit-table growth.
  const audit = (action: "reveal" | "reveal_denied", name: string) =>
    deps.prisma.secretAudit.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name, action },
    });
  if (revealRateLimited(actor.userId)) throw new ORPCError("TOO_MANY_REQUESTS");
  try {
    await requireSpaceOwner(deps.prisma, actor);
  } catch (error) {
    // Denied attempts record the requested id, not a name — the caller never saw one.
    await audit("reveal_denied", id);
    throw error;
  }
  const row = await deps.prisma.agentSecret.findFirst({
    where: { id, spaceId: actor.spaceId },
    select: { name: true, secret: { select: { id: true, ciphertext: true } } },
  });
  if (!row?.secret) {
    await audit("reveal_denied", id);
    throw new ORPCError("NOT_FOUND");
  }
  let value: string;
  try {
    value = await deps.secrets.load(row.secret.ciphertext, row.secret.id);
  } catch (error) {
    await audit("reveal_denied", row.name);
    throw error;
  }
  // Audit who/when/what-name on every reveal; the value itself is never recorded.
  await audit("reveal", row.name);
  return { name: row.name, value };
}
