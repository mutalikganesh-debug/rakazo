-- CreateEnum
CREATE TYPE "SecretAuditAction" AS ENUM ('add', 'update', 'delete', 'reveal', 'reveal_denied');

-- AlterTable: convert the text action column to the enum, preserving existing values
ALTER TABLE "secret_audits" ALTER COLUMN "action" TYPE "SecretAuditAction" USING ("action"::"SecretAuditAction");
