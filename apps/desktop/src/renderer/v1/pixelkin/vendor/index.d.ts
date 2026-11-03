// Types for apps that import the engine (see index.js). Accessory, personality
// and expression ids stay `string` so new catalogue entries need no type change.
// index-types.test.mjs fails if these declarations and the real exports drift.

export type KinShape = "sphere" | "cube" | "roundedBox" | "capsule";

/** A file saved by Create your Kin (`schema: "pixelkin"`, `version: 1`). */
export type KinFile = {
  schema: "pixelkin";
  version: 1;
  name: string;
  role: string;
  seed: number;
  body: {
    shape: KinShape;
    width: number;
    height: number;
    depth: number;
    colour: string;
    gradient: boolean;
    glitter: number;
    shininess: number;
    stripes: boolean;
    arms: boolean;
  };
  face: { eyeSize: number; browThickness: number; mouthSize: number };
  personality: string;
  accessories: {
    christmas: string;
    halloween: string;
    hat: string;
    hatHeight: number;
    glasses: string;
  };
};

/** A Kin as the engine holds it, after `readKin`. */
export type Kin = {
  seed: number;
  body: {
    shape: KinShape;
    width: number;
    height: number;
    depth: number;
    roundness: number;
    stripes: boolean;
    pants: boolean;
    arms: boolean;
    fins: boolean;
    shininess: number;
    glitter: number;
  };
  face: {
    personality: string;
    expression: string;
    glasses: string;
    glassesColor: string;
    glassesTint: string;
    glassesFrameMode: string;
    hat: string;
    halloween: string;
    christmas: string;
    hatHeight: number;
    disableAccessories: boolean;
    autoBlink: boolean;
    eyeSize: number;
    browThickness: number;
    mouthSize: number;
  };
  palette: { base: string; grayscale: boolean; gradient: boolean };
};

export type KinExpression = Readonly<Record<string, number>>;

/** Renderer input for one Kin. Built by `kinMember` and `setKinPose`. */
export type KinMember = {
  seed: number;
  phase: number;
  body: Kin["body"];
  palette: string;
  [field: string]: unknown;
};

export type KinObject = {
  member: KinMember;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
  roll?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  glossy?: number;
  gaze?: readonly [number, number];
  [field: string]: unknown;
};

export type KinLight = {
  name: string;
  directional?: boolean;
  target?: { x: number; y: number; z: number };
  enabled: boolean;
  x: number;
  y: number;
  z: number;
  intensity: number;
  color: string;
};

export type KinRender = {
  mode: "pixel" | "toon" | "smooth" | "mesh";
  resolution: number;
  targetFps: number;
  bands: number;
  outline: number;
  dither: boolean;
  background: string;
  groundShadow: boolean;
};

export type KinLighting = {
  ambient: number;
  colored: boolean;
  orbitSelected: boolean;
  showGizmos: boolean;
  selected: number;
  lights: KinLight[];
};

export type KinScene = {
  width: number;
  height: number;
  objects: readonly KinObject[];
  time: number;
  [field: string]: unknown;
};

export declare class CrowdGLRenderer {
  readonly available: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext | null;
  render(scene: KinScene): HTMLCanvasElement | null;
}

export declare const VIEW_SCALE: number;
export declare const BODY_WIDTH_MIN: number;
export declare const BODY_WIDTH_MAX: number;
export declare const BODY_HEIGHT_MIN: number;
export declare const BODY_HEIGHT_MAX: number;
export declare const KIN_SHAPES: readonly KinShape[];
export declare const KIN_COLOURS: readonly { readonly name: string; readonly hex: string }[];
export declare const KIN_DEFAULTS: Kin;
export declare const KIN_RENDER_DEFAULTS: { render: KinRender; lighting: KinLighting };
export declare const EXPRESSIONS: Readonly<Record<string, KinExpression>>;

type Accessory = { readonly id: string; readonly label: string };
export declare const PixelkinAccessories: {
  readonly version: number;
  readonly hats: readonly Accessory[];
  readonly glasses: readonly (Accessory & {
    readonly square: boolean;
    readonly clear: boolean;
    readonly opacity: number;
    readonly topBridge?: boolean;
  })[];
  readonly halloween: readonly Accessory[];
  readonly christmas: readonly Accessory[];
  getHat(id: string): Accessory | undefined;
  getGlasses(id: string): Accessory | undefined;
  ids(kind: "hat" | "glasses" | "halloween" | "christmas"): string[];
};

type PersonalityProfile = {
  readonly label: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly hold: readonly [number, number];
  readonly wink: number;
};
export declare const PixelkinPersonalities: {
  readonly profiles: Readonly<Record<string, PersonalityProfile>>;
  pick(weights: Readonly<Record<string, number>>, random?: () => number): string;
  /** Chooses the next expression over time; `update` returns a new one or null. */
  Controller: new (name?: string, random?: () => number) => {
    select(name: string): void;
    manual(seconds?: number): void;
    update(dt: number, blocked?: boolean): string | null;
  };
};

/** Reads a Kin file (or the lab's body/face/palette sections). Throws on invalid files. */
export declare function readKin(input: unknown): Kin;
export declare function kinToJson(kin: Kin, meta?: { name?: string; role?: string }): KinFile;
export declare function kinFileToSpec(input: Record<string, unknown>): Record<string, unknown>;
export declare function parseKinSections<T extends Pick<Kin, "seed" | "body" | "face" | "palette">>(input: Record<string, unknown>, next: T): T;

/** Applies one editor change (e.g. "body.shape", "face.hat") with the generator's rules. Mutates and returns `kin`. */
export declare function editKin<T extends Kin>(kin: T, path: string, value: unknown, options?: { depthDecoupled?: boolean }): T;
/** The generator's Randomize for a seed. Mutates `kin`; returns the picked accessories and the first expression hold. */
export declare function randomKin(
  kin: Kin,
  seed: number | string
): { glasses: string; hat: string; fins: boolean; stripes: boolean; pants: boolean; expressionHold: number };

export declare function kinMember(kin: Kin, member?: Partial<KinMember>): KinMember;
export declare function setKinPose(
  member: KinMember,
  pose?: { expression?: string; blink?: number; mouthReaction?: number; armSwing?: number }
): KinMember;
export declare function prepareKinHat(member: KinMember, hat?: string, disableAccessories?: boolean): void;
export declare function kinVisualScale(body: Pick<Kin["body"], "shape" | "width" | "height">, solo?: boolean): number;
export declare function kinBounds(
  kin: Kin,
  frame: { halfX: number; halfY: number; halfZ: number; shapeCode: number; radius: number; armParams: unknown; visualScale: number; solo?: boolean }
): { hatParams: unknown; hatExtraX: number; hatExtraY: number; hatExtraZ: number; boundRadius: number; centerOffsetY: number };
/** Body scale and vertical offset that keep the Kin and its accessories in frame. */
export declare function kinRestFrame(kin: Kin, options?: { armSwing?: number }): { visualScale: number; bodyY: number; boundRadius: number };
export declare function kinLights(lighting?: KinLighting): (KinLight & { cr: number; cg: number; cb: number; colourLuma: number })[];
/** The generator's solo stage: camera, lights and pixel settings around `objects`. */
export declare function kinScene(options: {
  width: number;
  height: number;
  objects: readonly KinObject[];
  time?: number;
  render?: KinRender;
  lighting?: KinLighting;
  lights?: readonly unknown[];
  grayscale?: boolean;
}): KinScene;

export declare function bodyRoundness(shape: KinShape): number;
export declare function getHatDefaultHeight(shape: KinShape, height: number): number;
export declare function getHatBaseY(hatType: string, halfX: number, halfY: number, halfZ: number, shapeCode: number, radius: number): number;
export declare function computeHatParams(hatType: string, halfX: number, halfY: number, halfZ: number, shapeCode: number, radius: number, hatHeightOffset?: number): Record<string, number | string> | null;
export declare function computeArmParams(halfX: number, halfY: number, halfZ: number, baseWidth: number, baseHeight: number, armSwing: number): Record<string, number>;

export declare function widthToInverseHeight(width: number): number;
export declare function heightToInverseWidth(height: number): number;
export declare function setByPath(object: object, path: string, value: unknown): void;
export declare function hashSeed(seed: number | string): number;
export declare function mulberry32(seed: number): () => number;
export declare function clone<T>(value: T): T;
export declare function clamp(value: number, min: number, max: number): number;
export declare function lerp(a: number, b: number, t: number): number;
export declare function roundTo(value: number, places?: number): number;
export declare function hexToRgb(hex: string): { r: number; g: number; b: number };
export declare function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number };
export declare function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number };
export declare function rgbToHex(r: number, g: number, b: number): string;
export declare function luminance(rgb: { r: number; g: number; b: number }): number;
export declare function limitKinSaturation(hex: string): string;
