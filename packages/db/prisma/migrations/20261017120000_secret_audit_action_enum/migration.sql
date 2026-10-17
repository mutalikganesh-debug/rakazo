-- CreateEnum
CREATE TYPE "SecretAuditAction" AS ENUM ('add', 'update', 'delete', 'reveal', 'reveal_denied');

-- AlterTable
ALTER TABLE "secret_audits" ALTER COLUMN "action" TYPE "SecretAuditAction" USING ("action"::text::"SecretAuditAction");
