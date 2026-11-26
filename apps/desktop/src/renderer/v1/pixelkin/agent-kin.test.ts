import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_LOOK,
  chiefOfStaffAppearance,
  normalizeAgentLook,
  parseAgentLook,
  projectKinEquipped,
  projectKinLook,
  projectKinSettings,
  sameAgentLook,
  serializeAgentLook
} from "./agent-kin.js";
import { editKin, clone } from "@koed-labs/kin-engine";

describe("agent Kin", () => {
  it("saves a Create your Kin file that reads back the same", () => {
    const look = editKin(clone(DEFAULT_AGENT_LOOK), "face.items", ["beanie"]);
    const saved = serializeAgentLook(look, " Pip ");
    expect(JSON.parse(saved)).toMatchObject({
      schema: "pixelkin",
      version: 1,
      name: "Pip",
      accessories: { items: ["beanie"] }
    });
    expect(sameAgentLook(parseAgentLook(saved), look)).toBe(true);
  });
  it("maps looks saved before the Pixelkin engine to the nearest Kin", () => {
    const look = parseAgentLook(
      JSON.stringify({ shape: "tall", color: "mint", top: "antenna" })
    );
    expect(look.body.shape).toBe("capsule");
    expect(look.body.height).toBe(1.9);
    expect(look.body.width).toBeLessThan(look.body.height);
    expect(look.palette.base).toBe("#55cca3");
    expect(look.face.items).toEqual([]);
  });
  it.each([
    [{ hat: "beanie", glasses: "matrix_square" }, ["beanie", "matrix_square"]],
    [
      { hat: { type: "beanie" }, glasses: { model: "matrix_square" } },
      ["beanie", "matrix_square"]
    ],
    [
      { hat: { type: "beanie", enabled: false }, glasses: { name: "Aviator" } },
      ["matrix_aviator"]
    ],
    [{ glasses: { type: "matrix", enabled: false } }, []],
    [{ glasses: { type: "matrix" } }, ["matrix_oval"]],
    [
      { hat: "beanie", christmas: "santa_hat", glasses: "matrix_square" },
      ["santa_hat", "matrix_square"]
    ],
    [
      { halloween: "ghost", christmas: "santa_hat", glasses: "matrix_square" },
      ["ghost"]
    ]
  ])(
    "migrates legacy equipment in saved looks and drafts (%j)",
    (old, items) => {
      const saved = JSON.parse(serializeAgentLook(DEFAULT_AGENT_LOOK, "Pip"));
      const look = normalizeAgentLook({
        ...saved,
        accessories: { ...old, hatHeight: 0.2 }
      });
      expect(look.face.items).toEqual(items);
      expect(look.face.hatHeight).toBe(0.2);
      const { items: _items, ...face } = DEFAULT_AGENT_LOOK.face;
      const draft = { ...DEFAULT_AGENT_LOOK, face: { ...face, ...old } };
      expect(normalizeAgentLook(draft).face.items).toEqual(items);
    }
  );
  it("preserves accessory settings from a legacy Kin file", () => {
    const saved = JSON.parse(serializeAgentLook(DEFAULT_AGENT_LOOK, "Pip"));
    const look = normalizeAgentLook({
      ...saved,
      accessories: {
        hat: { type: "beanie", heightOffset: 0.2 },
        glasses: {
          model: "matrix_square",
          materials: { frameColor: "#55cca3", lensTint: "amber" }
        }
      }
    });
    expect(look.face).toMatchObject({
      items: ["beanie", "matrix_square"],
      hatHeight: 0.2,
      glassesColor: "#55cca3",
      glassesTint: "amber"
    });
  });
  it("falls back to the default for unreadable looks", () => {
    for (const value of [
      undefined,
      "pixel",
      '{"schema":"pixelkin","version":9}'
    ])
      expect(parseAgentLook(value)).toEqual(DEFAULT_AGENT_LOOK);
    expect(normalizeAgentLook(null)).toEqual(DEFAULT_AGENT_LOOK);
  });
  it("uses the logo gradient by default without overriding saved looks", () => {
    expect(chiefOfStaffAppearance()).toMatchObject({
      look: {
        body: { shape: "roundedBox" },
        palette: { base: "#3083ff", gradient: true }
      },
      gradientTop: "#e8d31a"
    });
    const saved = chiefOfStaffAppearance('{"shape":"tall","color":"mint"}');
    expect(saved.look.body.shape).toBe("capsule");
    expect(saved.look.palette.base).toBe("#55cca3");
    expect(saved.gradientTop).toBeUndefined();
  });
  it("reads a Kin back from an onboarding draft", () => {
    const look = editKin(clone(DEFAULT_AGENT_LOOK), "body.shape", "sphere");
    expect(sameAgentLook(normalizeAgentLook(clone(look)), look)).toBe(true);
  });
});

it("restores known equipped items and applies the engine slot rules", () => {
  const saved = {
    shape: "roundedBox",
    colour: "#55cca3",
    personality: "neutral"
  } as const;
  const look = projectKinLook("project", saved, [
    "beanie",
    "circle_eyeglasses",
    "bowler",
    "unknown"
  ]);
  expect(look.face.items).toEqual(["bowler", "circle_eyeglasses"]);
  expect(projectKinSettings(look)).toEqual(saved);
  expect(projectKinEquipped(look)).toEqual(["bowler", "circle_eyeglasses"]);
  expect(projectKinEquipped(projectKinLook("project"))).toEqual([]);
  expect(
    projectKinLook("project", { ...saved, hat: "cap" }).face.items
  ).toEqual(["cap"]);
  expect(
    projectKinLook("project", { ...saved, hat: "cap" }, []).face.items
  ).toEqual([]);
});
