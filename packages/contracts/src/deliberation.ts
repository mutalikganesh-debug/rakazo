import * as z from "zod";
import { Id } from "./ids.js";

/** A named agent in the deliberation roster (persona + optional model pin). */
export const AgentProfileSchema = z.object({
  id: Id,
  name: z.string(),
  role: z.string(),
  persona: z.string(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  color: z.string(),
  ordinal: z.number().int(),
  updatedAt: z.string(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentProfileInput = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(80),
  persona: z.string().trim().max(2000),
  modelProvider: z.string().trim().max(120).nullable().optional(),
  modelId: z.string().trim().max(200).nullable().optional(),
  color: z.string().trim().max(40).optional(),
});

export const UpdateAgentInput = z.object({
  agentId: Id,
  name: AgentProfileInput.shape.name.optional(),
  role: AgentProfileInput.shape.role.optional(),
  persona: AgentProfileInput.shape.persona.optional(),
  modelProvider: AgentProfileInput.shape.modelProvider,
  modelId: AgentProfileInput.shape.modelId,
  color: AgentProfileInput.shape.color,
});

export const RoomStatusSchema = z.enum(["running", "complete", "error"]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const DeliberationRoomSchema = z.object({
  id: Id,
  title: z.string(),
  question: z.string(),
  status: RoomStatusSchema,
  jointAnswer: z.string().nullable(),
  dissent: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeliberationRoom = z.infer<typeof DeliberationRoomSchema>;

export const DeliberationTurnSchema = z.object({
  id: Id,
  seq: z.number().int(),
  kind: z.enum(["user", "agent", "note", "joint"]),
  agentId: z.string().nullable(),
  agentName: z.string(),
  agentRole: z.string().nullable(),
  color: z.string().nullable(),
  round: z.number().int(),
  content: z.string(),
  error: z.boolean(),
});
export type DeliberationTurnDto = z.infer<typeof DeliberationTurnSchema>;

export const DeliberationRoomDetailSchema = z.object({
  room: DeliberationRoomSchema,
  turns: z.array(DeliberationTurnSchema),
});
export type DeliberationRoomDetail = z.infer<typeof DeliberationRoomDetailSchema>;

export const CreateRoomInput = z.object({
  question: z.string().trim().min(1).max(4000),
  title: z.string().trim().max(120).optional(),
  agentIds: z.array(Id).min(2).max(6),
});

export const RoomIdInput = z.object({ roomId: Id });
