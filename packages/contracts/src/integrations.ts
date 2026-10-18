import * as z from "zod";

/** Direct self-hosted connectors shipped with the Integrations Hub (Phase 1). */
export const IntegrationConnectorIdSchema = z.enum(["gmail", "google-calendar"]);
export type IntegrationConnectorId = z.infer<typeof IntegrationConnectorIdSchema>;

export const INTEGRATION_CONNECTOR_LABELS: Record<IntegrationConnectorId, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
};

/** Where the connector's credentials came from. Values are never returned by the API. */
export const IntegrationCredentialSourceSchema = z.enum(["secret-store", "env", "none"]);
export type IntegrationCredentialSource = z.infer<typeof IntegrationCredentialSourceSchema>;

export const IntegrationConnectorStatusSchema = z.object({
  id: IntegrationConnectorIdSchema,
  label: z.string(),
  description: z.string(),
  connected: z.boolean(),
  needsSetup: z.boolean(),
  /** Env var names that would configure this connector when no stored config exists. */
  missingEnvVars: z.array(z.string()),
  /** Action names accepted by integrations.action for this connector. */
  actions: z.array(z.string()),
  source: IntegrationCredentialSourceSchema,
});
export type IntegrationConnectorStatus = z.infer<typeof IntegrationConnectorStatusSchema>;

export const IntegrationsListOutputSchema = z.object({
  connectors: z.array(IntegrationConnectorStatusSchema),
});
export type IntegrationsListOutput = z.infer<typeof IntegrationsListOutputSchema>;

export const IntegrationHealthInputSchema = z.object({ id: IntegrationConnectorIdSchema });
export const IntegrationHealthOutputSchema = z.object({
  id: IntegrationConnectorIdSchema,
  ok: z.boolean(),
  checkedAt: z.string(),
  detail: z.string(),
});
export type IntegrationHealthOutput = z.infer<typeof IntegrationHealthOutputSchema>;

/**
 * Save a connector's credential config into the encrypted secret store.
 * Secret values are write-only: they are never echoed back by any response.
 * Unset fields are left unchanged; pass empty string to clear a field.
 */
export const IntegrationSaveConfigInputSchema = z.object({
  id: IntegrationConnectorIdSchema,
  gmailAddress: z.string().trim().max(320).optional(),
  gmailAppPassword: z.string().trim().max(64).optional(),
  googleClientId: z.string().trim().max(512).optional(),
  googleClientSecret: z.string().trim().max(512).optional(),
  googleRefreshToken: z.string().trim().max(1024).optional(),
  googleCalendarId: z.string().trim().max(320).optional(),
});
export const IntegrationSaveConfigOutputSchema = z.object({
  ok: z.literal(true),
  status: IntegrationConnectorStatusSchema,
});

export const IntegrationActionNameSchema = z.enum([
  "send",
  "read",
  "createEvent",
  "listEvents",
]);
export type IntegrationActionName = z.infer<typeof IntegrationActionNameSchema>;

export const IntegrationActionInputSchema = z.object({
  connector: IntegrationConnectorIdSchema,
  action: IntegrationActionNameSchema,
  params: z.record(z.string(), z.unknown()),
});
export type IntegrationActionInput = z.infer<typeof IntegrationActionInputSchema>;

export const IntegrationActionResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** Env var names that must be set to unblock this action (never values). */
  blockedOnSecret: z.array(z.string()).optional(),
});
export type IntegrationActionResult = z.infer<typeof IntegrationActionResultSchema>;

/** Param shapes per action (documented contract for callers and agent tools). */
export const GmailSendParamsSchema = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().max(500).default(""),
  body: z.string().max(20000).default(""),
});
export const GmailReadParamsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  query: z.string().max(200).optional(),
});
export const CalendarCreateEventParamsSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  start: z.string().trim().min(4),
  end: z.string().trim().min(4).optional(),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.string().trim().email().max(320)).max(50).optional(),
});
export const CalendarListEventsParamsSchema = z.object({
  timeMin: z.string().trim().min(4).optional(),
  timeMax: z.string().trim().min(4).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
