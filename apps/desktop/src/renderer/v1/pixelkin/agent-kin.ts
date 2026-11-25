import { personalProjectKinSchema } from "@koed-labs/shared/personal-desktop";
import type { PersonalProjectKin } from "@koed-labs/shared";
import {
  KIN_COLOURS,
  KIN_DEFAULTS,
  PixelkinAccessories,
  clone,
  editKin,
  kinFileToSpec,
  kinToJson,
  readKin,
  type Kin,
  type KinShape
} from "@koed-labs/kin-engine";

// The agent's look is a Create your Kin character. The profile stores it as
// that tool's JSON file, so a Kin made in the generator loads unchanged.
export type AgentLook = Kin;

export const DEFAULT_AGENT_LOOK: AgentLook = clone(KIN_DEFAULTS);

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

const legacyGlasses: Readonly<Record<string, string>> = {
  matrix: "matrix_oval",
  "Circle sunglasses": "matrix_oval",
  "Square sunglasses": "matrix_square",
  Aviator: "matrix_aviator",
  matrix_clear: "circle_eyeglasses",
  matrix_aviator_clear: "circle_eyeglasses",
  Eyeglasses: "circle_eyeglasses"
};

function migrateAccessories(spec: Record<string, unknown>) {
  const { face } = spec;
  if (!record(face) || "items" in face) return spec;

  const itemId = (value: unknown) =>
    PixelkinAccessories.find(({ id }) => id === value)?.id;
  const hat = record(face.hat)
    ? face.hat.enabled === false
      ? undefined
      : face.hat.type
    : face.hat;
  const glasses = record(face.glasses) ? face.glasses : undefined;
  const model = glasses
    ? glasses.enabled === false
      ? undefined
      : glasses.model || glasses.name || glasses.type
    : face.glasses;
  const frames =
    glasses && record(glasses.materials) ? glasses.materials : undefined;
  const eyewear =
    itemId(model) ??
    (typeof model === "string" && Object.hasOwn(legacyGlasses, model)
      ? legacyGlasses[model]
      : undefined);
  const halloween = itemId(face.halloween);
  // Halloween replaced all other equipment. Christmas only replaced the hat.
  const items = halloween
    ? [halloween]
    : [itemId(face.christmas) ?? itemId(hat), eyewear].filter(
        (id) => id !== undefined
      );
  return {
    ...spec,
    face: {
      ...face,
      items,
      hatHeight:
        face.hatHeight ??
        (record(face.hat) ? face.hat.heightOffset : undefined),
      glassesColor: face.glassesColor ?? frames?.frameColor,
      glassesTint: face.glassesTint ?? frames?.lensTint
    }
  };
}

// Accepts a Kin, a Create your Kin file or a legacy look; anything else is
// replaced by the default rather than failing the screen that shows it.
export function normalizeAgentLook(value: unknown): AgentLook {
  if (!record(value)) return clone(DEFAULT_AGENT_LOOK);
  if ("shape" in value && !("body" in value))
    return legacyLook(value) ?? clone(DEFAULT_AGENT_LOOK);
  try {
    return readKin(migrateAccessories(kinFileToSpec(value)));
  } catch {
    return clone(DEFAULT_AGENT_LOOK);
  }
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

export const PROJECT_KIN_ACCESSORIES = PixelkinAccessories.filter(
  (item) => item.unlockBit === undefined
);
const projectKinItemIds = new Set(PROJECT_KIN_ACCESSORIES.map(({ id }) => id));
const projectKinItems = (items: readonly string[]) =>
  items.filter((id) => projectKinItemIds.has(id));

function setProjectKinAccessories(look: AgentLook, items: readonly string[]) {
  editKin(look, "face.items", projectKinItems(items));
  // Apply slot rules before sorting so the latest equipped item wins.
  look.face.items.sort();
  return look;
}

export function withProjectKinAccessories(
  look: AgentLook,
  items: readonly string[]
) {
  return setProjectKinAccessories(clone(look), items);
}

export function projectKinSettings(look: AgentLook): PersonalProjectKin {
  return personalProjectKinSchema.parse({
    shape: look.body.shape,
    colour: look.palette.base,
    personality: look.face.personality
  });
}

export const projectKinEquipped = (look: AgentLook) =>
  projectKinItems(look.face.items).sort();

export function projectKinLook(
  projectId: string,
  saved?: PersonalProjectKin,
  items?: readonly string[]
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
  if (items) setProjectKinAccessories(look, items);
  look.seed = value % 100000;
  return look;
}
