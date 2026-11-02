import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_LOOK,
  normalizeAgentLook,
  parseAgentLook,
  randomAgentLook,
  sameAgentLook,
  serializeAgentLook
} from "./agent-kin.js";
import { PixelkinAccessories, editKin, clone } from "./vendor/index.js";

describe("agent Kin", () => {
  it("saves a Create your Kin file that reads back the same", () => {
    const look = editKin(clone(DEFAULT_AGENT_LOOK), "face.hat", "beanie");
    const saved = serializeAgentLook(look, " Pip ");
    expect(JSON.parse(saved)).toMatchObject({
      schema: "pixelkin",
      version: 1,
      name: "Pip"
    });
    expect(sameAgentLook(parseAgentLook(saved), look)).toBe(true);
  });
  it("fits every random Kin within the profile's saved-look limit", () => {
    for (let i = 0; i < 50; i++) {
      const saved = serializeAgentLook(randomAgentLook(), "A".repeat(24));
      expect(saved.length).toBeLessThanOrEqual(4096);
    }
  });
  it("maps looks saved before the Pixelkin engine to the nearest Kin", () => {
    const look = parseAgentLook(
      JSON.stringify({ shape: "tall", color: "mint", top: "antenna" })
    );
    expect(look.body.shape).toBe("capsule");
    expect(look.body.height).toBe(1.9);
    expect(look.body.width).toBeLessThan(look.body.height);
    expect(look.palette.base).toBe("#55cca3");
    expect(PixelkinAccessories.getHat(look.face.hat)).toBeUndefined();
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
  it("reads a Kin back from an onboarding draft", () => {
    const look = editKin(clone(DEFAULT_AGENT_LOOK), "body.shape", "sphere");
    expect(sameAgentLook(normalizeAgentLook(clone(look)), look)).toBe(true);
  });
  it("keeps surprises within the builder's options while extras are hidden", () => {
    for (let i = 0; i < 50; i++) {
      const look = randomAgentLook();
      expect([
        look.face.hat,
        look.face.glasses,
        look.face.halloween,
        look.face.christmas
      ]).toEqual(["none", "none", "none", "none"]);
      expect(look.body).toMatchObject({
        arms: false,
        stripes: false,
        shininess: 0,
        glitter: 0
      });
      expect(look.palette.gradient).toBe(false);
    }
  });
});
