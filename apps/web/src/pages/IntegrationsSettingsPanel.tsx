import { useLingui } from "@lingui/react/macro";
import type { IntegrationConnectorId, IntegrationConnectorStatus } from "@rakazo/contracts";
import { Badge, Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type HealthState = { ok: boolean; detail: string };
type FormValues = Partial<Record<string, string>>;

type SetupField = {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
};

/**
 * Integrations Hub: direct self-hosted connectors (Gmail, Google Calendar).
 * Credential values are write-only — the API never returns them, so the setup
 * form never pre-fills anything and only sends fields the operator filled in.
 */
export function IntegrationsSettingsPanel() {
  const { t } = useLingui();
  const [connectors, setConnectors] = useState<IntegrationConnectorStatus[]>([]);
  const [health, setHealth] = useState<Record<string, HealthState>>({});
  const [openId, setOpenId] = useState<IntegrationConnectorId | null>(null);
  const [form, setForm] = useState<FormValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await rpc.integrations.list();
      setConnectors(result.connectors);
    } catch (cause) {
      setError(errorText(cause, t`Could not load integrations`));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function fieldsFor(id: IntegrationConnectorId): SetupField[] {
    return id === "gmail"
      ? [
          {
            key: "gmailAddress",
            label: t`Email address`,
            secret: false,
            placeholder: t`name@example.com`,
          },
          {
            key: "gmailAppPassword",
            label: t`App password`,
            secret: true,
            placeholder: t`16-character app password`,
          },
        ]
      : [
          { key: "googleClientId", label: t`OAuth client ID`, secret: false, placeholder: "" },
          {
            key: "googleClientSecret",
            label: t`OAuth client secret`,
            secret: true,
            placeholder: "",
          },
          {
            key: "googleRefreshToken",
            label: t`OAuth refresh token`,
            secret: true,
            placeholder: "",
          },
          { key: "googleCalendarId", label: t`Calendar ID`, secret: false, placeholder: t`primary` },
        ];
  }

  function enabledNote(id: IntegrationConnectorId) {
    return id === "gmail"
      ? t`Lets your agents send and read email through your Gmail account.`
      : t`Lets your agents create and list events on your Google Calendar.`;
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {t`Connect email and calendar so your agents can act on them. Credentials are stored encrypted and are never shown again after saving.`}
      </p>
      {connectors.map((connector) => {
        const fields = fieldsFor(connector.id);
        const open = openId === connector.id;
        const canSave = fields.some((field) => (form[field.key] ?? "").trim() !== "");
        return (
          <section
            key={connector.id}
            data-testid={`integration-${connector.id}`}
            className="rounded-xl border border-border px-4 py-4"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-[15px] font-medium text-foreground">{connector.label}</h3>
              <Badge variant={connector.connected ? "default" : "secondary"}>
                {connector.connected ? t`Connected` : t`Needs setup`}
              </Badge>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground/70">{connector.description}</p>
            <p className="mt-3 text-[13px] text-foreground/75">{enabledNote(connector.id)}</p>
            {connector.missingEnvVars.length > 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                {t`Alternatively set these environment variables:`}{" "}
                {/* Technical env var names — not translated. */}
                <code>{connector.missingEnvVars.join(", ")}</code>
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                data-testid={`integration-test-${connector.id}`}
                onClick={() =>
                  void act(async () => {
                    const result = await rpc.integrations.health({ id: connector.id });
                    setHealth((current) => ({
                      ...current,
                      [connector.id]: { ok: result.ok, detail: result.detail },
                    }));
                  })
                }
              >
                {t`Test connection`}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`integration-toggle-${connector.id}`}
                onClick={() => {
                  setOpenId(open ? null : connector.id);
                  setForm({});
                }}
              >
                {open ? t`Hide setup` : t`Set up`}
              </Button>
            </div>
            {health[connector.id] ? (
              <p
                data-testid={`integration-health-${connector.id}`}
                className={`mt-2 text-sm ${
                  health[connector.id]?.ok ? "text-muted-foreground" : "text-destructive"
                }`}
              >
                {health[connector.id]?.ok ? t`Connection OK` : t`Connection failed`}
                {health[connector.id]?.detail ? ` — ${health[connector.id]?.detail}` : ""}
              </p>
            ) : null}
            {open ? (
              <div className="mt-4 space-y-3">
                {fields.map((field) => (
                  <Field key={field.key}>
                    <FieldLabel htmlFor={`integration-${connector.id}-${field.key}`}>
                      {field.label}
                    </FieldLabel>
                    <Input
                      id={`integration-${connector.id}-${field.key}`}
                      data-testid={`integration-field-${connector.id}-${field.key}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete={field.secret ? "new-password" : "off"}
                      placeholder={field.placeholder}
                      value={form[field.key] ?? ""}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                    />
                  </Field>
                ))}
                <Button
                  disabled={busy || !canSave}
                  data-testid={`integration-save-${connector.id}`}
                  onClick={() =>
                    void act(async () => {
                      await rpc.integrations.saveConfig({
                        id: connector.id,
                        // Only filled fields are sent: empty input means "leave unchanged".
                        gmailAddress: form.gmailAddress?.trim() || undefined,
                        gmailAppPassword: form.gmailAppPassword?.trim() || undefined,
                        googleClientId: form.googleClientId?.trim() || undefined,
                        googleClientSecret: form.googleClientSecret?.trim() || undefined,
                        googleRefreshToken: form.googleRefreshToken?.trim() || undefined,
                        googleCalendarId: form.googleCalendarId?.trim() || undefined,
                      });
                      setForm({});
                      setOpenId(null);
                    })
                  }
                >
                  {t`Save`}
                </Button>
              </div>
            ) : null}
          </section>
        );
      })}
      {connectors.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">{t`No integrations available.`}</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
