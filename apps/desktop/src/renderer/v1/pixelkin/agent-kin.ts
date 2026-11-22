import { personalProjectKinSchema } from "@koed-labs/shared/personal-desktop";
import type { PersonalProjectKin } from "@koed-labs/shared";
import {
  KIN_COLOURS,
  KIN_DEFAULTS,
  clone,
  editKin,
  kinToJson,
  readKin,
  type Kin,
  type KinShape
} from "./vendor/index.js";

// The agent's look is a Create your Kin character. The profile stores it as
// that tool's JSON file, so a Kin made in the generator loads unchanged.
export type AgentLook = Kin;

export const DEFAULT_AGENT_LOOK: AgentLook = clone(KIN_DEFAULTS);

export const chiefOfStaffBrand = {
  look: {
    ...DEFAULT_AGENT_LOOK,
    body: {
      ...DEFAULT_AGENT_LOOK.body,
      shape: "roundedBox",
      width: 2,
      height: 2,
      depth: 0.9,
      arms: true
    },
    face: { ...DEFAULT_AGENT_LOOK.face, personality: "joyful" },
    palette: { base: "#3083ff", grayscale: false, gradient: true }
  } satisfies AgentLook,
  gradientTop: "#e8d31a"
};

export function chiefOfStaffAppearance(value?: string): {
  look: AgentLook;
  gradientTop?: string;
} {
  try {
    const look = readAgentLook(JSON.parse(value ?? "null"));
    return look ? { look } : chiefOfStaffBrand;
  } catch {
    return chiefOfStaffBrand;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Looks saved before the Pixelkin engine used shape/color/top; keep their spirit.
// The builder has no proportions control, so each shape gets one height
// (width follows it): a wide capsule would read as a sphere.
const shapeHeights: Record<KinShape, number> = {
  cube: 1.3,
  roundedBox: 1.6,
  sphere: 1.6,
  capsule: 1.9
};
export function withAgentShape(look: AgentLook, shape: KinShape): AgentLook {
  editKin(look, "body.shape", shape);
  editKin(look, "body.height", shapeHeights[shape]);
  return look;
}

const legacyShapes: Record<string, KinShape> = {
  block: "roundedBox",
  bean: "sphere",
  tall: "capsule",
  wide: "cube"
};
const legacyColours: Record<string, string> = {
  violet: "Indigo",
  blue: "Blue",
  mint: "Mint",
  lime: "Lime",
  sun: "Yellow",
  coral: "Red",
  pink: "Rose",
  slate: "Cream"
};
function legacyLook(value: Record<string, unknown>): AgentLook | null {
  const shape = legacyShapes[String(value.shape)];
  const colour = KIN_COLOURS.find(
    (entry) => entry.name === legacyColours[String(value.color)]
  );
  if (!shape || !colour) return null;
  const look = withAgentShape(clone(DEFAULT_AGENT_LOOK), shape);
  editKin(look, "palette.base", colour.hex);
  return look;
}

function readAgentLook(value: unknown): AgentLook | null {
  if (!record(value)) return null;
  if ("shape" in value && !("body" in value)) return legacyLook(value);
  try {
    return readKin(value);
  } catch {
    return null;
  }
}

// Accepts a Kin, a Create your Kin file or a legacy look.
export function normalizeAgentLook(value: unknown): AgentLook {
  return readAgentLook(value) ?? clone(DEFAULT_AGENT_LOOK);
}

export function parseAgentLook(value: string | undefined): AgentLook {
  try {
    return normalizeAgentLook(JSON.parse(value ?? ""));
  } catch {
    return clone(DEFAULT_AGENT_LOOK);
  }
}

export const serializeAgentLook = (look: AgentLook, name: string) =>
  JSON.stringify(kinToJson(look, { name: name.trim() }));

export const sameAgentLook = (a: AgentLook, b: AgentLook) =>
  JSON.stringify(kinToJson(a)) === JSON.stringify(kinToJson(b));

const projectShapes: readonly KinShape[] = [
  "roundedBox",
  "cube",
  "sphere",
  "capsule"
];

export function projectKinSettings(look: AgentLook): PersonalProjectKin {
  return personalProjectKinSchema.parse({
    shape: look.body.shape,
    colour: look.palette.base,
    personality: look.face.personality
  });
}

export function projectKinLook(
  projectId: string,
  saved?: PersonalProjectKin
): AgentLook {
  let hash = 2166136261;
  for (const char of projectId)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const value = hash >>> 0;
  const look = withAgentShape(
    clone(DEFAULT_AGENT_LOOK),
    saved?.shape ?? projectShapes[value % projectShapes.length]!
  );
  const colour = KIN_COLOURS[(value >>> 8) % KIN_COLOURS.length];
  editKin(
    look,
    "palette.base",
    saved?.colour ?? colour?.hex ?? look.palette.base
  );
  if (saved) editKin(look, "face.personality", saved.personality);
  look.seed = value % 100000;
  return look;
}
