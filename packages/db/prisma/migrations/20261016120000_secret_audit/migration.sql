-- CreateEnum
CREATE TYPE "SecretAuditAction" AS ENUM ('add', 'update', 'delete', 'reveal', 'reveal_denied');

-- CreateTable
CREATE TABLE "secret_audits" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" "SecretAuditAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secret_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "secret_audits_spaceId_createdAt_idx" ON "secret_audits"("spaceId", "createdAt");
