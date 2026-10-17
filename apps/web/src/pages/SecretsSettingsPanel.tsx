import { useLingui } from "@lingui/react/macro";
import type { AgentSecret } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

const REVEAL_CLEAR_MS = 30_000;

/** Vault: space secrets, encrypted at rest, masked to model providers, audited on reveal. */
export function SecretsSettingsPanel() {
  const { t } = useLingui();
  const [secrets, setSecrets] = useState<AgentSecret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSecrets(await rpc.agentSecrets.list());
    } catch (cause) {
      setError(errorText(cause, t`Could not load secrets`));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Plaintext lives in React state only briefly: clear every revealed value shortly
  // after the last reveal (component unmount discards the state outright).
  // ponytail: one shared clock restarted by each reveal — per-secret timers if UX cares
  useEffect(() => {
    if (Object.keys(revealed).length === 0) return;
    const timer = setTimeout(() => setRevealed({}), REVEAL_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [revealed]);

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

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {t`Secrets are encrypted at rest, available to agent shells as environment variables, and scrubbed from text sent to model providers (known values and common key patterns). Every reveal is recorded.`}
      </p>
      <div className="space-y-2">
        {secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t`No secrets yet.`}</p>
        ) : (
          secrets.map((secret) => (
            <div key={secret.id} className="flex items-center gap-2">
              <code className="flex-1 truncate text-sm">{secret.name}</code>
              {revealed[secret.id] !== undefined ? (
                <code className="max-w-48 truncate text-sm">{revealed[secret.id]}</code>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (revealed[secret.id] !== undefined) {
                    // Hide is a local clear — re-fetching would re-decrypt, write a
                    // second reveal audit row, and leave the plaintext in state.
                    setRevealed((current) => {
                      const next = { ...current };
                      delete next[secret.id];
                      return next;
                    });
                    return;
                  }
                  void act(async () => {
                    const result = await rpc.agentSecrets.reveal({ id: secret.id });
                    setRevealed((current) => ({ ...current, [secret.id]: result.value }));
                  });
                }}
              >
                {revealed[secret.id] !== undefined ? t`Hide` : t`Reveal`}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await rpc.agentSecrets.remove({ id: secret.id });
                    setRevealed((current) => {
                      const next = { ...current };
                      delete next[secret.id];
                      return next;
                    });
                  })
                }
              >
                {t`Delete`}
              </Button>
            </div>
          ))
        )}
      </div>
      <Field>
        <FieldLabel htmlFor="secret-name">{t`Name`}</FieldLabel>
        <Input
          id="secret-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="OPENAI_API_KEY"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="secret-value">{t`Value`}</FieldLabel>
        <Input
          id="secret-value"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button
        disabled={busy || name.trim() === "" || value === ""}
        onClick={() =>
          void act(async () => {
            await rpc.agentSecrets.put({ name: name.trim(), value });
            setName("");
            setValue("");
          })
        }
      >
        {t`Add secret`}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
