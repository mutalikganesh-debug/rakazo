import * as z from "zod";
import { Id } from "./ids.js";

/** Goal run card (goal_rebuild_spec.md §2.2 `goal_runs` projection + journal tail). */
export const GoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalJournalEntrySchema = z.object({
  id: z.number().int(),
  revision: z.number().int(),
  op: z.string(),
  createdAt: z.string(),
});
export type GoalJournalEntry = z.infer<typeof GoalJournalEntrySchema>;

export const GoalCardSchema = z.object({
  goalId: Id,
  objective: z.string(),
  name: z.string(),
  status: GoalStatusSchema,
  revision: z.number().int(),
  blockedReason: z.string().nullable(),
  completionConfidence: z.string().nullable(),
  error: z.string().nullable(),
  verdictLine: z.string().nullable(),
  tokensUsed: z.number().int(),
  tokenBudget: z.number().int().nullable(),
  consecutiveErrorTurns: z.number().int(),
  unchangedContinuationTurns: z.number().int(),
  evaluationCount: z.number().int(),
  verifyCmd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  journalTail: z.array(GoalJournalEntrySchema),
});
export type GoalCard = z.infer<typeof GoalCardSchema>;

export const CreateGoalInput = z.object({
  objective: z.string().trim().min(1).max(4000),
  verifyCmd: z.string().trim().max(2000).optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
  clientId: z.string().min(1).max(200).optional(),
});

/** Every goal mutation is fenced: it carries (goalId, revision) and fails loud when stale. */
export const GoalMutationInput = z.object({
  goalId: Id,
  revision: z.number().int(),
});

export const BlockGoalInput = GoalMutationInput.extend({
  reason: z.string().trim().min(1).max(500),
});

export const EditGoalInput = GoalMutationInput.extend({
  objective: z.string().trim().min(1).max(4000),
});

/** Fenced evidence recording: append worker evidence ids the evaluator may cite. */
export const EvidenceGoalInput = GoalMutationInput.extend({
  ids: z.array(z.string().trim().min(1).max(128)).min(1).max(64),
});
