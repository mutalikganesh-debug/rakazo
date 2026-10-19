import { describe, expect, it } from "vitest";
import { botColors, darkGradients, tokens } from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product palette used by custom surfaces", () => {
    expect(tokens.background).toBe("#1A1633");
    expect(tokens.foreground).toBe("#ECEBFF");
    expect(tokens.primary).toBe("#6D4AFF");
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe("#3EC5A8");
  });

  it("re-exports the shared dark gradient layer", () => {
    expect(darkGradients.gradientSurface).toContain("linear-gradient");
    expect(darkGradients.gradientAccent).toContain("#6d4aff");
    expect(darkGradients.gradientSelected).toContain("#2e63dc");
  });
});
