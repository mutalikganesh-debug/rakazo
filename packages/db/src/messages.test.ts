import { clearKnownSecrets, registerKnownSecrets } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import {
  createThreadMessage,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("reply leak-guard", () => {
  const vaultValue = "vault-value-9f8e7d6c5b";

  beforeEach(() => {
    clearKnownSecrets();
    registerKnownSecrets([{ name: "OPENAI_API_KEY", value: vaultValue }]);
  });

  it("masks registered vault values and key patterns in stored bot replies", async () => {
    const tx = transaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [
        {
          kind: "text",
          text: `Here is ${vaultValue}, key sk-abc1234567890, and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl`,
        },
      ],
    });
    const stored = JSON.stringify(tx.message.create.mock.calls.at(0));
    expect(stored).not.toContain(vaultValue);
    expect(stored).not.toContain("sk-abc1234567890");
    expect(stored).not.toContain("c2lnbmF0dXJl");
    expect(stored).toContain("[REDACTED:OPENAI_API_KEY]");
  });

  it("leaves user messages and ordinary text alone", async () => {
    const tx = transaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: `my note ${vaultValue} token: 5` }],
    });
    const stored = JSON.stringify(tx.message.create.mock.calls.at(0));
    expect(stored).toContain(vaultValue);
    expect(stored).toContain("token: 5");
  });

  it("masks bot reply payloads on the realtime event path", async () => {
    const createEvent = vi.fn().mockResolvedValue({ id: "event-1", seq: 1, threadId: "thread-1" });
    const tx = {
      thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 1 }) },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
      event: { create: createEvent },
    };
    await appendEventInTransaction(tx as unknown as Prisma.TransactionClient, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "thread.message.created",
      payload: {
        messageId: "message-1",
        role: "bot",
        blocks: [{ kind: "text", text: `echo ${vaultValue} sk-abc1234567890` }],
      },
    });
    const stored = JSON.stringify(createEvent.mock.calls.at(0));
    expect(stored).not.toContain(vaultValue);
    expect(stored).not.toContain("sk-abc1234567890");
    expect(stored).toContain("[REDACTED:OPENAI_API_KEY]");
  });
});
