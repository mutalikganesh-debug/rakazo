// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const lingui = vi.hoisted(() => {
  // Stable identity: the panel's load effect depends on `t` via useCallback, and a fresh
  // closure per render would retrigger it forever (act would never settle).
  const t = (strings: TemplateStringsArray) => strings.join("");
  return { t };
});

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: lingui.t }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../lib/user-error", () => ({
  errorText: (_cause: unknown, fallback?: string) => fallback ?? "error",
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

const agentSecrets = vi.hoisted(() => ({
  list: vi.fn(async () => [
    {
      id: "as-1",
      name: "ACME_TOKEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]),
  reveal: vi.fn(async () => ({ name: "ACME_TOKEN", value: "plaintext-value-123" })),
  put: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));
vi.mock("../lib/rpc", () => ({ rpc: { agentSecrets } }));

import { SecretsSettingsPanel } from "./SecretsSettingsPanel";

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function mount() {
  const { container, root } = render();
  await act(async () => {
    root.render(<SecretsSettingsPanel />);
  });
  return { container, root };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  agentSecrets.list.mockClear();
  agentSecrets.reveal.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("Hide is a local clear — no second reveal call, plaintext dropped from state", async () => {
  const { container, root } = await mount();
  expect(button(container, "Reveal")).toBeTruthy();

  await act(async () => {
    button(container, "Reveal").click();
  });
  expect(agentSecrets.reveal).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("plaintext-value-123");

  await act(async () => {
    button(container, "Hide").click();
  });
  expect(agentSecrets.reveal).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("plaintext-value-123");
  expect(button(container, "Reveal")).toBeTruthy();
  root.unmount();
});

it("auto-clears revealed values after the reveal timer", async () => {
  vi.useFakeTimers();
  const { container, root } = await mount();
  await act(async () => {
    button(container, "Reveal").click();
  });
  expect(container.textContent).toContain("plaintext-value-123");

  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(container.textContent).not.toContain("plaintext-value-123");
  root.unmount();
});
