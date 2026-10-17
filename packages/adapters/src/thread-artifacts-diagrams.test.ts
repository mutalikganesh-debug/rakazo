import { describe, expect, it } from "vitest";
import { manifestDiagramsForAnswer, type ManifestDiagramEntry } from "./thread-artifacts.js";

const concepts: Record<string, ManifestDiagramEntry> = {
  interscalene: {
    file: "anatomy/tos_interscalene_costoclavicular.jpg",
    match: ["interscalene", "thoracic outlet"],
  },
  costoclavicular: {
    file: "anatomy/tos_pectoralis_minor_inset.png",
    match: ["costoclavicular", "thoracic outlet"],
  },
  retropectoralis: {
    file: "anatomy/tos_pectoralis_minor_inset.png",
    match: ["pectoralis minor"],
  },
  cuff: { file: "anatomy/rotator_cuff.png" },
};

describe("manifestDiagramsForAnswer", () => {
  it("attaches one diagram per matching concept, deduped per file", () => {
    const picked = manifestDiagramsForAnswer(
      concepts,
      "Thoracic outlet syndrome compresses in the interscalene triangle, the costoclavicular space, and behind the pectoralis minor.",
    );
    expect(picked.map((entry) => entry.file)).toEqual([
      "anatomy/tos_interscalene_costoclavicular.jpg",
      "anatomy/tos_pectoralis_minor_inset.png",
    ]);
  });

  it("falls back to the file stem and caps at maxDiagrams", () => {
    const picked = manifestDiagramsForAnswer(
      concepts,
      "The rotator cuff and the interscalene triangle and a thoracic outlet note.",
      1,
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]?.file).toBe("anatomy/tos_interscalene_costoclavicular.jpg");
  });

  it("attaches nothing for an unrelated answer", () => {
    expect(
      manifestDiagramsForAnswer(concepts, "The mitral valve has two leaflets."),
    ).toEqual([]);
  });
});
