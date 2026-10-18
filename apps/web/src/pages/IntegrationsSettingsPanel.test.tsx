// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // Stable identity: the panel's load effect depends on `t` via useCallback, and a fresh
  // closure per render would retrigger it forever (act would never settle).
  const t = (strings: TemplateStringsArray) => strings.join("");
  const gmailStatus = {
    id: "gmail",
    label: "Gmail",
    description: "Send and read email.",
    connected: true,
    needsSetup: false,
    missingEnvVars: [],
    actions: ["send", "read"],
    source: "secret-store",
  };
  const calendarStatus = {
    id: "google-calendar",
    label: "Google Calendar",
    description: "Create and list events.",
    connected: false,
    needsSetup: true,
    missingEnvVars: ["GOOGLE_CLIENT_ID"],
    actions: ["createEvent", "listEvents"],
    source: "none",
  };
  const integrations = {
    list: vi.fn(async () => ({ connectors: [gmailStatus, calendarStatus] })),
    health: vi.fn(async () => ({
      id: "gmail",
      ok: true,
      checkedAt: "2026-10-18T00:00:00.000Z",
      detail: "smtp ok",
    })),
    saveConfig: vi.fn(async () => ({ ok: true, status: gmailStatus })),
  };
  return { t, integrations };
});

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: mocks.t }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../lib/user-error", () => ({
  errorText: (_cause: unknown, fallback?: string) => fallback ?? "error",
}));

vi.mock("@rakazo/ui-web", () => ({
  Badge: ({ children, ...props }: React.ComponentProps<"span">) => <span {...props}>{children}</span>,
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

vi.mock("../lib/rpc", () => ({ rpc: { integrations: mocks.integrations } }));

import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<IntegrationsSettingsPanel />);
  });
  return { container, root };
}

function click(container: HTMLElement, testid: string) {
  const found = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (!found) throw new Error(`no element ${testid}`);
  found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function type(container: HTMLElement, testid: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
  if (!element) throw new Error(`no input ${testid}`);
  // Go through the native setter so React's value tracker sees the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.integrations.list.mockClear();
  mocks.integrations.health.mockClear();
  mocks.integrations.saveConfig.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("renders the connector list with status badges", async () => {
  const { container, root } = await mount();
  expect(container.textContent).toContain("Gmail");
  expect(container.textContent).toContain("Google Calendar");
  expect(container.textContent).toContain("Connected");
  expect(container.textContent).toContain("Needs setup");
  expect(container.querySelector('[data-testid="integration-gmail"]')).toBeTruthy();
  root.unmount();
});

it("Test connection calls integrations.health and shows the detail", async () => {
  const { container, root } = await mount();
  await act(async () => {
    click(container, "integration-test-gmail");
  });
  expect(mocks.integrations.health).toHaveBeenCalledWith({ id: "gmail" });
  expect(container.textContent).toContain("Connection OK");
  expect(container.textContent).toContain("smtp ok");
  root.unmount();
});

it("save wires integrations.saveConfig with filled fields and re-fetches the list", async () => {
  const { container, root } = await mount();
  await act(async () => {
    click(container, "integration-toggle-gmail");
  });

  await act(async () => {
    type(container, "integration-field-gmail-gmailAddress", "  ops@example.com ");
    type(container, "integration-field-gmail-gmailAppPassword", "abcd efgh ijkl mnop");
  });

  await act(async () => {
    buttonByLabel(container, "Save").click();
  });
  expect(mocks.integrations.saveConfig).toHaveBeenCalledWith({
    id: "gmail",
    gmailAddress: "ops@example.com",
    gmailAppPassword: "abcd efgh ijkl mnop",
    googleClientId: undefined,
    googleClientSecret: undefined,
    googleRefreshToken: undefined,
    googleCalendarId: undefined,
  });
  expect(mocks.integrations.list).toHaveBeenCalledTimes(2);
  root.unmount();
});
