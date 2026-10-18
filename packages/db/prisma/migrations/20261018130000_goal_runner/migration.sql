-- CreateTable
CREATE TABLE "goal_runs" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "threadId" TEXT,
    "clientId" TEXT,
    "objective" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "blockedReason" TEXT,
    "completionConfidence" TEXT,
    "lastEvaluation" JSONB,
    "consecutiveErrorTurns" INTEGER NOT NULL DEFAULT 0,
    "unchangedContinuationTurns" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "tokenBudget" INTEGER,
    "timeUsedMs" INTEGER NOT NULL DEFAULT 0,
    "verifyCmd" TEXT NOT NULL DEFAULT '',
    "evaluationCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "verdictLine" TEXT,
    "output" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goal_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_journal" (
    "id" SERIAL NOT NULL,
    "goalId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_journal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "goal_runs_goalId_key" ON "goal_runs"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_runs_spaceId_clientId_key" ON "goal_runs"("spaceId", "clientId");

-- CreateIndex
CREATE INDEX "goal_runs_spaceId_userId_updatedAt_idx" ON "goal_runs"("spaceId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "goal_journal_goalId_id_idx" ON "goal_journal"("goalId", "id");

-- AddForeignKey
ALTER TABLE "goal_runs" ADD CONSTRAINT "goal_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_runs" ADD CONSTRAINT "goal_runs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
