/**
 * direct-integrations.ts — self-hosted connectors for the Integrations Hub (Phase 1).
 *
 * Gmail: SMTP send + IMAP read over app-password (node:tls; no new dependencies).
 * Google Calendar: OAuth refresh-token flow against the Calendar v3 REST API (fetch).
 *
 * Secrets: credentials live in the encrypted SecretStore (record ids
 * `integration:gmail` / `integration:google-calendar`) or in env vars. Values are
 * never returned by any function here — only status, env-var NAMES, and action
 * results produced by the remote services.
 */
import { createConnection } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import {
  CalendarCreateEventParamsSchema,
  CalendarListEventsParamsSchema,
  GmailReadParamsSchema,
  GmailSendParamsSchema,
  type IntegrationActionResult,
  type IntegrationConnectorStatus,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export type IntegrationId = "gmail" | "google-calendar";

export const INTEGRATION_ENV_VARS: Record<IntegrationId, readonly string[]> = {
  gmail: ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"],
  "google-calendar": [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_CALENDAR_ID",
  ],
};

const REQUIRED_ENV_VARS: Record<IntegrationId, readonly string[]> = {
  gmail: ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"],
  "google-calendar": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
};

const RECORD_ID: Record<IntegrationId, string> = {
  gmail: "integration:gmail",
  "google-calendar": "integration:google-calendar",
};

const ACTION_NAMES: Record<IntegrationId, readonly string[]> = {
  gmail: ["send", "read"],
  "google-calendar": ["createEvent", "listEvents"],
};

const DESCRIPTIONS: Record<IntegrationId, string> = {
  gmail: "Send and read email through your Gmail account (app password, IMAP/SMTP).",
  "google-calendar": "Create and list Google Calendar events (OAuth refresh token).",
};

type GmailConfig = { address: string; appPassword: string };
type CalendarConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId?: string;
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export type IntegrationConfigResolution =
  | { source: "secret-store"; config: Record<string, string> }
  | { source: "env"; config: Record<string, string> }
  | { source: "none"; missing: string[] };

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function fromEnv(id: IntegrationId): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of REQUIRED_ENV_VARS[id]) {
    const value = envValue(name);
    if (!value) return null;
    out[name] = value;
  }
  if (id === "google-calendar") out.GOOGLE_CALENDAR_ID = envValue("GOOGLE_CALENDAR_ID") || "primary";
  return out;
}

/** Resolve credentials: encrypted secret store first, env fallback. Values stay in-memory. */
export async function resolveIntegrationConfig(
  prisma: PrismaClient,
  secrets: SecretStore,
  id: IntegrationId,
): Promise<IntegrationConfigResolution> {
  const row = await prisma.integrationProviderConfig.findUnique({ where: { id } }).catch(() => null);
  if (row?.ciphertext) {
    try {
      const plaintext = await secrets.load(row.ciphertext, RECORD_ID[id]);
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) config[k] = v;
      const missing = REQUIRED_ENV_VARS[id].filter((name) => !config[name]);
      if (missing.length === 0) {
        if (id === "google-calendar") config.GOOGLE_CALENDAR_ID ||= "primary";
        return { source: "secret-store", config };
      }
    } catch {
      // Unreadable ciphertext falls through to env, never crashes a status read.
    }
  }
  const envConfig = fromEnv(id);
  if (envConfig) return { source: "env", config: envConfig };
  return { source: "none", missing: [...INTEGRATION_ENV_VARS[id]] };
}

export async function integrationConnectorStatuses(
  prisma: PrismaClient,
  secrets: SecretStore,
): Promise<IntegrationConnectorStatus[]> {
  const ids: IntegrationId[] = ["gmail", "google-calendar"];
  const out: IntegrationConnectorStatus[] = [];
  for (const id of ids) {
    const resolved = await resolveIntegrationConfig(prisma, secrets, id);
    out.push({
      id,
      label: id === "gmail" ? "Gmail" : "Google Calendar",
      description: DESCRIPTIONS[id],
      connected: resolved.source !== "none",
      needsSetup: resolved.source === "none",
      missingEnvVars: resolved.source === "none" ? resolved.missing : [],
      actions: [...ACTION_NAMES[id]],
      source: resolved.source,
    });
  }
  return out;
}

/**
 * Persist a connector config into the encrypted secret store (values are write-only).
 * Fields omitted from `input` keep their previous stored values; empty string clears.
 */
export async function saveIntegrationConfig(
  prisma: PrismaClient,
  secrets: SecretStore,
  context: AdapterContext,
  input: {
    id: IntegrationId;
    gmailAddress?: string;
    gmailAppPassword?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    googleRefreshToken?: string;
    googleCalendarId?: string;
  },
): Promise<void> {
  const existing = await prisma.integrationProviderConfig
    .findUnique({ where: { id: input.id } })
    .catch(() => null);
  let current: Record<string, string> = {};
  if (existing?.ciphertext) {
    try {
      current = JSON.parse(await secrets.load(existing.ciphertext, RECORD_ID[input.id])) as Record<
        string,
        string
      >;
    } catch {
      current = {};
    }
  }
  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") delete current[key];
    else current[key] = value;
  };
  if (input.id === "gmail") {
    assign("GMAIL_ADDRESS", input.gmailAddress);
    assign("GMAIL_APP_PASSWORD", input.gmailAppPassword);
  } else {
    assign("GOOGLE_CLIENT_ID", input.googleClientId);
    assign("GOOGLE_CLIENT_SECRET", input.googleClientSecret);
    assign("GOOGLE_REFRESH_TOKEN", input.googleRefreshToken);
    assign("GOOGLE_CALENDAR_ID", input.googleCalendarId);
  }
  const stored = await secrets.put(JSON.stringify(current), context, {
    recordId: RECORD_ID[input.id],
  });
  await prisma.integrationProviderConfig.upsert({
    where: { id: input.id },
    create: { id: input.id, ciphertext: stored.ciphertext },
    update: { ciphertext: stored.ciphertext },
  });
}

export async function integrationHealth(
  prisma: PrismaClient,
  secrets: SecretStore,
  id: IntegrationId,
): Promise<{ ok: boolean; checkedAt: string; detail: string }> {
  const checkedAt = new Date().toISOString();
  const resolved = await resolveIntegrationConfig(prisma, secrets, id);
  if (resolved.source === "none") {
    return {
      ok: false,
      checkedAt,
      detail: `Not configured — set ${resolved.missing.join(", ")} (env) or save credentials in Settings → Integrations.`,
    };
  }
  try {
    if (id === "gmail") {
      const cfg = resolved.config;
      const creds = {
        address: pick(cfg, "GMAIL_ADDRESS", "address"),
        appPassword: pick(cfg, "GMAIL_APP_PASSWORD", "appPassword"),
      };
      await smtpLogin(creds);
      await imapLoginProbe(creds);
      return { ok: true, checkedAt, detail: `SMTP + IMAP login ok for ${creds.address}` };
    }
    const cfg = resolved.config;
    const token = await refreshGoogleAccessToken({
      clientId: pick(cfg, "GOOGLE_CLIENT_ID"),
      clientSecret: pick(cfg, "GOOGLE_CLIENT_SECRET"),
      refreshToken: pick(cfg, "GOOGLE_REFRESH_TOKEN"),
    });
    const calendarId = cfg.GOOGLE_CALENDAR_ID || "primary";
    await googleApi(
      `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?maxResults=1&singleEvents=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return { ok: true, checkedAt, detail: `Google Calendar API ok (calendar ${calendarId})` };
  } catch (error) {
    return { ok: false, checkedAt, detail: `Health check failed: ${integrationErrorMessage(error)}` };
  }
}

export async function runIntegrationAction(
  prisma: PrismaClient,
  secrets: SecretStore,
  id: IntegrationId,
  action: string,
  params: Record<string, unknown>,
): Promise<IntegrationActionResult> {
  const resolved = await resolveIntegrationConfig(prisma, secrets, id);
  if (resolved.source === "none") {
    return {
      ok: false,
      error: `${id} is not configured.`,
      blockedOnSecret: [...resolved.missing],
    };
  }
  try {
    if (id === "gmail") {
      const cfg = resolved.config;
      const creds = {
        address: pick(cfg, "GMAIL_ADDRESS", "address"),
        appPassword: pick(cfg, "GMAIL_APP_PASSWORD", "appPassword"),
      };
      if (action === "send") {
        const args = GmailSendParamsSchema.parse(params);
        const result = await smtpSend(creds, args);
        return { ok: true, result };
      }
      if (action === "read") {
        const args = GmailReadParamsSchema.parse(params);
        const result = await imapRead(creds, args);
        return { ok: true, result };
      }
      return { ok: false, error: `Unknown gmail action: ${action}` };
    }
    const cfg = resolved.config;
    const token = await refreshGoogleAccessToken({
      clientId: pick(cfg, "GOOGLE_CLIENT_ID"),
      clientSecret: pick(cfg, "GOOGLE_CLIENT_SECRET"),
      refreshToken: pick(cfg, "GOOGLE_REFRESH_TOKEN"),
    });
    const calendarId = cfg.GOOGLE_CALENDAR_ID || "primary";
    if (action === "createEvent") {
      const args = CalendarCreateEventParamsSchema.parse(params);
      const result = await googleCreateEvent(token, calendarId, args);
      return { ok: true, result };
    }
    if (action === "listEvents") {
      const args = CalendarListEventsParamsSchema.parse(params);
      const result = await googleListEvents(token, calendarId, args);
      return { ok: true, result };
    }
    return { ok: false, error: `Unknown google-calendar action: ${action}` };
  } catch (error) {
    return { ok: false, error: integrationErrorMessage(error) };
  }
}

export function integrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First non-empty credential field; throws rather than emitting an undefined credential. */
function pick(config: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = config[name];
    if (value) return value;
  }
  throw new Error(`Missing credential field: ${names[0]}`);
}

/* ------------------------------------------------------------------ Gmail */

type SmtpLine = { code: number; text: string };

function openTlsSocket(
  host: string,
  port: number,
  timeoutMs = 30_000,
): Promise<{ socket: TLSSocket; reader: LineReader }> {
  return new Promise((resolve, reject) => {
    let reader: LineReader | undefined;
    const socket = tlsConnect({ host, port, servername: host }, () => {
      // Attach the line reader in the same callback: a greeting that arrives in the
      // same tick must not land before a listener exists (it would be dropped and the
      // first exchange would then sit in "waiting for server line" forever).
      reader = new LineReader(socket);
      resolve({ socket, reader });
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`timeout connecting to ${host}:${port}`));
    });
    socket.once("error", reject);
    void reader;
  });
}

/** Minimal line/SMTP response reader shared by SMTP and IMAP probes. */
class LineReader {
  private buffer = "";
  /** Lines received before next() was called are QUEUED, never dropped. */
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;
  constructor(private readonly socket: TLSSocket | ReturnType<typeof createConnection>) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx = this.buffer.indexOf("\r\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
        idx = this.buffer.indexOf("\r\n");
      }
    });
    socket.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w("");
    });
  }
  next(timeoutMs = 30_000): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for server line")), timeoutMs);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
      if (this.closed && this.waiters.length > 0) {
        const w = this.waiters.shift();
        clearTimeout(timer);
        if (w) w("");
      }
    });
  }
}

async function smtpExchange(
  reader: LineReader,
  socket: TLSSocket,
  command: string | null,
  expect: number[] | null,
): Promise<SmtpLine> {
  if (command !== null) socket.write(`${command}\r\n`);
  const first = await reader.next();
  const code = Number(first.slice(0, 3));
  let text = first;
  // Multi-line replies: "250-..." continues until "250 ...".
  while (/^\d{3}-/.test(text)) text = await reader.next();
  if (expect && !expect.includes(code)) {
    throw new Error(`SMTP server rejected ${command ?? "greeting"}: ${text.slice(0, 120)}`);
  }
  return { code, text };
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export async function smtpLogin(creds: GmailConfig): Promise<void> {
  const { socket, reader } = await openTlsSocket("smtp.gmail.com", 465);
  try {
    await smtpExchange(reader, socket, null, [220]);
    await smtpExchange(reader, socket, "EHLO rakazo.local", [250]);
    await smtpExchange(reader, socket, "AUTH LOGIN", [334]);
    await smtpExchange(reader, socket, b64(creds.address), [334]);
    await smtpExchange(reader, socket, b64(creds.appPassword), [235]);
    await smtpExchange(reader, socket, "QUIT", [221]);
  } finally {
    socket.destroy();
  }
}

export async function smtpSend(
  creds: GmailConfig,
  args: { to: string; subject: string; body: string },
): Promise<{ accepted: string[]; messageId: string }> {
  const { socket, reader } = await openTlsSocket("smtp.gmail.com", 465);
  try {
    await smtpExchange(reader, socket, null, [220]);
    await smtpExchange(reader, socket, "EHLO rakazo.local", [250]);
    await smtpExchange(reader, socket, "AUTH LOGIN", [334]);
    await smtpExchange(reader, socket, b64(creds.address), [334]);
    await smtpExchange(reader, socket, b64(creds.appPassword), [235]);
    await smtpExchange(reader, socket, `MAIL FROM:<${creds.address}>`, [250]);
    await smtpExchange(reader, socket, `RCPT TO:<${args.to}>`, [250, 251]);
    await smtpExchange(reader, socket, "DATA", [354]);
    const messageId = `${Date.now()}.${Math.random().toString(16).slice(2)}@rakazo.local`;
    const body = args.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const headers = [
      `From: ${creds.address}`,
      `To: ${args.to}`,
      `Subject: ${args.subject.replace(/[\r\n]+/g, " ")}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${messageId}>`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
    ].join("\r\n");
    await smtpExchange(reader, socket, `${headers}\r\n\r\n${body}\r\n.`, [250]);
    await smtpExchange(reader, socket, "QUIT", [221]);
    return { accepted: [args.to], messageId };
  } finally {
    socket.destroy();
  }
}

async function imapCommand(
  reader: LineReader,
  socket: TLSSocket,
  tag: string,
  command: string,
  expect: string = "OK",
): Promise<string> {
  socket.write(`${tag} ${command}\r\n`);
  const lines: string[] = [];
  for (;;) {
    const line = await reader.next();
    lines.push(line);
    if (line.startsWith(`${tag} `)) {
      if (!line.includes(` ${expect}`)) {
        throw new Error(`IMAP ${command.split(" ")[0]} failed: ${line.slice(0, 120)}`);
      }
      return lines.join("\n");
    }
    // Gmail sends "* BYE" before the tagged LOGOUT response — not an error here.
    // A real hang is covered by next()'s timeout; a tagged error line still fails.
  }
}

async function imapLoginProbe(creds: GmailConfig): Promise<void> {
  const { socket, reader } = await openTlsSocket("imap.gmail.com", 993);
  try {
    await reader.next(); // greeting
    await imapCommand(reader, socket, "a1", `LOGIN ${creds.address} "${creds.appPassword}"`);
    await imapCommand(reader, socket, "a2", "LOGOUT");
  } finally {
    socket.destroy();
  }
}

export async function imapRead(
  creds: GmailConfig,
  args: { limit: number; query?: string },
): Promise<{ messages: Array<{ uid: string; from: string; subject: string; date: string; snippet: string }> }> {
  const { socket, reader } = await openTlsSocket("imap.gmail.com", 993);
  try {
    await reader.next();
    await imapCommand(reader, socket, "a1", `LOGIN ${creds.address} "${creds.appPassword}"`);
    await imapCommand(reader, socket, "a2", "SELECT INBOX");
    const criteria = args.query ? `TEXT "${args.query.replace(/["\\]/g, "")}"` : "ALL";
    const searchResp = await imapCommand(reader, socket, "a3", `UID SEARCH ${criteria}`);
    const uids = (searchResp.match(/^\* SEARCH (.*)$/m)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(-args.limit)
      .reverse();
    const messages: Array<{
      uid: string;
      from: string;
      subject: string;
      date: string;
      snippet: string;
    }> = [];
    for (const uid of uids) {
      const fetchResp = await imapCommand(
        reader,
        socket,
        `f${uid}`,
        `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)] BODY.PEEK[TEXT]<0.400>)`,
      );
      messages.push(parseFetch(uid, fetchResp));
    }
    await imapCommand(reader, socket, "a4", "LOGOUT");
    return { messages };
  } finally {
    socket.destroy();
  }
}

function decodeMimeHeader(raw: string): string {
  return raw.replace(/=\?([^?]+)\?[Bb]\?([^?]*)\?=/g, (_m, _cs, b64part) => {
    try {
      return Buffer.from(b64part, "base64").toString("utf8");
    } catch {
      return b64part;
    }
  });
}

export function parseFetch(
  uid: string,
  response: string,
): { uid: string; from: string; subject: string; date: string; snippet: string } {
  const field = (name: string) =>
    decodeMimeHeader(response.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "");
  // Snippet = first non-empty line after the header/body literal separator.
  const bodySplit = response.indexOf("}\r\n");
  const tail = bodySplit >= 0 ? response.slice(bodySplit + 3) : "";
  const snippet = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("f") && !l.startsWith(")"))
    .join(" ")
    .slice(0, 400);
  return { uid, from: field("From"), subject: field("Subject"), date: field("Date"), snippet };
}

/* --------------------------------------------------------- Google Calendar */

export async function refreshGoogleAccessToken(creds: CalendarConfig): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google OAuth token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google OAuth response contained no access_token");
  return data.access_token;
}

async function googleApi(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google Calendar API ${response.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

function toGoogleDate(value: string): { date?: string; dateTime?: string; timeZone?: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Unparseable date/time: ${value}`);
  return { dateTime: date.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export async function googleCreateEvent(
  token: string,
  calendarId: string,
  args: {
    summary: string;
    start: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<{ id: string; htmlLink: string; summary: string; start: string; end: string }> {
  const start = toGoogleDate(args.start);
  const end = args.end
    ? toGoogleDate(args.end)
    : start.date
      ? { date: start.date }
      : { dateTime: new Date(new Date(args.start).getTime() + 3600_000).toISOString(), timeZone: start.timeZone };
  const created = (await googleApi(
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: args.summary,
        start,
        end,
        ...(args.description ? { description: args.description } : {}),
        ...(args.location ? { location: args.location } : {}),
        ...(args.attendees?.length
          ? { attendees: args.attendees.map((email) => ({ email })) }
          : {}),
      }),
    },
  )) as { id?: string; htmlLink?: string; summary?: string; start?: unknown; end?: unknown };
  return {
    id: String(created.id ?? ""),
    htmlLink: String(created.htmlLink ?? ""),
    summary: String(created.summary ?? args.summary),
    start: JSON.stringify(created.start ?? start),
    end: JSON.stringify(created.end ?? end),
  };
}

export async function googleListEvents(
  token: string,
  calendarId: string,
  args: { timeMin?: string; timeMax?: string; limit: number },
): Promise<{ events: Array<{ id: string; summary: string; start: string; end: string; htmlLink: string }> }> {
  const params = new URLSearchParams({
    maxResults: String(args.limit),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (args.timeMin) params.set("timeMin", new Date(args.timeMin).toISOString());
  if (args.timeMax) params.set("timeMax", new Date(args.timeMax).toISOString());
  const data = (await googleApi(
    `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )) as { items?: Array<Record<string, unknown>> };
  return {
    events: (data.items ?? []).map((item) => ({
      id: String(item.id ?? ""),
      summary: String(item.summary ?? "(untitled)"),
      start: JSON.stringify(item.start ?? {}),
      end: JSON.stringify(item.end ?? {}),
      htmlLink: String(item.htmlLink ?? ""),
    })),
  };
}
