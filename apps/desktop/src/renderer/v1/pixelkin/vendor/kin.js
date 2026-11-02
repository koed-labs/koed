// Kin model shared by the lab, the generator and apps: character files,
// framing, accessory placement and the renderer member. It never touches the
// page, so apps can import it beside crowd-gl.js.
import { EXPRESSIONS } from './expressions.js';
import { PixelkinAccessories } from './accessories.js';
import { PixelkinPersonalities } from './personalities.js';

export const VIEW_SCALE = 1.32;
export const BODY_WIDTH_MIN = 1.00;
export const BODY_WIDTH_MAX = 2.10;
export const BODY_HEIGHT_MIN = 1.10;
export const BODY_HEIGHT_MAX = 2.10;
export const KIN_SHAPES = Object.freeze(['sphere', 'cube', 'roundedBox', 'capsule']);
export const KIN_COLOURS = Object.freeze([
  { name: 'Red', hex: '#e85555' },
  { name: 'Orange', hex: '#e89e55' },
  { name: 'Yellow', hex: '#e8d855' },
  { name: 'Lime', hex: '#b7dc58' },
  { name: 'Green', hex: '#66cc72' },
  { name: 'Mint', hex: '#55cca3' },
  { name: 'Cyan', hex: '#55cce0' },
  { name: 'Blue', hex: '#559ee8' },
  { name: 'Indigo', hex: '#6862dc' },
  { name: 'Violet', hex: '#a055e8' },
  { name: 'Magenta', hex: '#d855d1' },
  { name: 'Rose', hex: '#e8559e' },
  { name: 'Cream', hex: '#e8e3d5' }
].map(Object.freeze));
export const bodyRoundness=shape=>shape==='cube'?.15:shape==='roundedBox'?.4:.35;

// Defaults for a new Kin and for the stage it is drawn on.
export const KIN_DEFAULTS = {
  body: { shape: 'cube', width: 1.92, height: 1.14, depth: 1.92, roundness: 0.15, stripes: false, pants: false, arms: false, fins: false, shininess: 0, glitter: 0 },
  face: { personality: 'neutral', expression: 'neutral', glasses: 'none', glassesColor: '#400a56', glassesTint: 'dark', glassesFrameMode: '+30_dark', hat: 'none', halloween:'none', christmas:'none', hatHeight: -0.02, disableAccessories: false, autoBlink: true, eyeSize: 1.4, browThickness: 1.7, mouthSize: 1.0 },
  palette: { base: '#7658e8', grayscale: false, gradient: false },
  seed: 890195850
};
export const KIN_RENDER_DEFAULTS = {
  render: { mode: 'pixel', resolution: 96, targetFps: 30, bands: 7, outline: 1.0, dither: true, background: 'studio', groundShadow: false },
  lighting: {
    ambient: 0.16,
    colored: false,
    orbitSelected: false,
    showGizmos: true,
    selected: 0,
    lights: [
      { name: 'Key', directional: true, target: {x:0,y:0,z:0}, enabled: true, x: -1.81, y: 8, z: 7.7, intensity: 0.75, color: '#ffffff' },
    ]
  }
};

export function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function roundTo(value, places = 2) { const factor = 10 ** places; return Math.round(value * factor) / factor; }

export function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  const expanded = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const number = Number.parseInt(expanded, 16);
  if (!Number.isFinite(number)) return { r: 118, g: 88, b: 232 };
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2; const delta = max - min;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = h * 6, x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g] = [c, x]; else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x]; else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c]; else [r, b] = [c, x];
  const m = l - c / 2;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function luminance(rgb) { return (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) / 255; }

export function rgbToHex(r, g, b) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function limitKinSaturation(hex){
  const rgb=hexToRgb(hex),hsl=rgbToHsl(rgb.r,rgb.g,rgb.b);
  if(hsl.s<=.9)return hex;
  const c=hslToRgb(hsl.h,.9,hsl.l);return rgbToHex(c.r,c.g,c.b);
}

export function getHatDefaultHeight(shape, height) { return shape === 'capsule' ? roundTo(-0.04 * clamp((height - 1.10) / 1.00, 0, 1), 3) : -0.02;
}

export function getHatBaseY(hatType, halfX, halfY, halfZ, shapeCode, radius) {
  let hatR = 0.30;
  if (hatType === 'cap') {
    const capScale = clamp(Math.min(halfX, halfZ) * 0.54, 0.20, 0.40);
    hatR = capScale * 0.90;
  } else if (hatType === 'beanie') {
    const bScale = clamp(Math.min(halfX, halfZ) * 0.58, 0.22, 0.44);
    hatR = bScale * 0.88;
  } else if (hatType === 'bowler') {
    const bScale = clamp(Math.min(halfX, halfZ) * 0.58, 0.22, 0.44);
    hatR = bScale * 0.84;
  }

  if (shapeCode === 0) {
    // Esfera: el sombrero entero baja a la cota donde apoya su radio
    const minR = Math.min(halfX, halfZ);
    const u = clamp(hatR / Math.max(0.01, minR), 0, 0.95);
    const yRim = halfY * Math.sqrt(Math.max(0, 1 - u * u));
    return halfY * 0.35 + yRim * 0.65;
  }
  if (shapeCode === 3) {
    // Cápsula: cúpula semiesférica superior
    const capR = Math.min(halfX, halfZ);
    const u = clamp(hatR / Math.max(0.01, capR), 0, 0.95);
    const drop = capR - Math.sqrt(Math.max(0, capR * capR - (hatR * u) * (hatR * u)));
    return halfY - drop * 0.65;
  }
  if (shapeCode === 1) {
    // Cubo redondeado: plano en el centro, curva en los bordes
    const effR = Math.min(radius || 0.2, Math.min(halfX, Math.min(halfY, halfZ)) - 0.005);
    const flatX = Math.max(0, halfX - effR);
    const flatZ = Math.max(0, halfZ - effR);
    const minFlat = Math.min(flatX, flatZ);
    if (hatR > minFlat && effR > 0.001) {
      const delta = Math.min(effR - 0.002, hatR - minFlat);
      const drop = effR - Math.sqrt(Math.max(0, effR * effR - delta * delta));
      return halfY - drop * 0.60;
    }
    return halfY;
  }
  // Cuboide estándar: plano horizontal exacto
  return halfY;
}

export function computeHatParams(hatType, halfX, halfY, halfZ, shapeCode, radius, hatHeightOffset = 0) {
  if (!hatType || hatType === 'none') return null;
  const yBase = getHatBaseY(hatType, halfX, halfY, halfZ, shapeCode, radius) + (Number(hatHeightOffset) || 0);
  if (hatType === 'cap') {
    const capScale = clamp(Math.min(halfX, halfZ) * 0.54, 0.20, 0.40);
    const rx = capScale * 0.90;
    const ry = capScale * 1.04;
    const rz = capScale * 0.96;
    const zOffset = 0.04 * halfZ;
    const vzStart = zOffset + rz * 0.05;
    const visorLength = capScale * 1.55;
    const visorWidth = rx * 1.04;
    const vz = vzStart + visorLength * 0.5;
    return {
      hatType, yBase, capScale, rx, ry, rz, zOffset,
      invRx: 1 / rx, invRy: 1 / ry, invRz: 1 / rz,
      invRx2: 1 / (rx * rx), invRy2: 1 / (ry * ry), invRz2: 1 / (rz * rz),
      visorLength, halfVisorLength: visorLength * 0.5, invVisorLength: 1 / visorLength,
      visorWidth, vzStart, vz,
      yMin: yBase - 0.035, yMax: yBase + ry + 0.03,
      extraX: rx * 0.15, extraZFront: Math.max(0, vzStart + visorLength - halfZ + 0.05), extraZBack: 0.02
    };
  }
  if (hatType === 'beanie') {
    const bScale = clamp(Math.min(halfX, halfZ) * 0.58, 0.22, 0.44);
    const rx = bScale * 0.90;
    const ry = bScale * 0.80;
    const rz = bScale * 0.90;
    const zOffset = -0.02;
    const cuffYCenter = yBase + 0.035;
    const cuffRx = rx * 1.05;
    const cuffRz = rz * 1.05;
    const pomRadius = bScale * 0.36;
    const pomY = yBase + ry + pomRadius * 0.72;
    const pomZOffset = zOffset - 0.02;
    return {
      hatType, yBase, bScale, rx, ry, rz, zOffset,
      invRx: 1 / rx, invRy: 1 / ry, invRz: 1 / rz,
      invRx2: 1 / (rx * rx), invRy2: 1 / (ry * ry), invRz2: 1 / (rz * rz),
      cuffYCenter, cuffRx, cuffRz,
      invCuffRx: 1 / cuffRx, invCuffRz: 1 / cuffRz,
      domeZOffset: zOffset - 0.02,
      pomRadius, pomY, pomZOffset,
      yMin: yBase - 0.02, yMax: pomY + pomRadius + 0.03,
      extraX: Math.max(0, cuffRx - halfX + 0.05), extraZFront: 0.02, extraZBack: 0.04
    };
  }
  if (hatType === 'bowler') {
    const bScale = clamp(Math.min(halfX, halfZ) * 0.58, 0.22, 0.44);
    const rx = bScale * 0.82;
    const ry = bScale * 1.08;
    const rz = bScale * 0.84;
    const bx = bScale * 1.20;
    const bz = bScale * 1.24;
    const curlFactor = bScale * 0.10;
    const minBxBz = Math.min(bx, bz);
    const brimCutRad = rx * 0.85;
    const bandHalfH = 0.064 * (bScale / 0.30);
    const bandCenterY = yBase + 0.015 + bandHalfH;
    return {
      hatType, yBase, bScale, rx, ry, rz, bx, bz,
      invRx: 1 / rx, invRy: 1 / ry, invRz: 1 / rz,
      invRx2: 1 / (rx * rx), invRy2: 1 / (ry * ry), invRz2: 1 / (rz * rz),
      invBx: 1 / bx, invBz: 1 / bz,
      curlFactor, minBxBz, brimCutRad,
      invBrimCutX: 1 / brimCutRad, invBrimCutZ: 1 / (rz * 0.85),
      bandCenterY, bandHalfH,
      yMin: yBase - 0.02, yMax: yBase + ry + 0.04,
      extraX: Math.max(0, bx - halfX + 0.05), extraZFront: Math.max(0, bz - halfZ + 0.05), extraZBack: Math.max(0, bz - halfZ + 0.05)
    };
  }
  return null;
}

export function computeArmParams(halfX, halfY, halfZ, baseWidth, baseHeight, armSwing) {
  const rootX = halfX * 0.88;
  const rootY = -halfY * 0.05;
  const angle = 0.65 - armSwing;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  // Arms sweep slightly forward toward camera:
  const cosY = 0.965, sinY = -0.262;

  const scale = (baseWidth * 0.5 + baseHeight * 0.5 * 0.6) / (0.58 + 0.95 * 0.6);
  const armLen = 0.36 * scale;
  const armWid = 0.115 * scale;
  const armThick = 0.098 * scale; // Plump, round cross-section
  const centerArmX = armLen * 0.46;
  const a = armLen * 0.54;
  const b = armWid;
  const c = armThick;

  const tipDx = armLen * cosY * cosA;
  const tipDy = -armLen * cosY * sinA;
  const xMin = rootX - b * 0.7;
  const xMax = rootX + Math.max(0, tipDx) + a * 0.7 + 0.08;
  const yMin = rootY + Math.min(0, tipDy) - a * 0.7 - 0.08;
  const yMax = rootY + Math.max(0, tipDy) + a * 0.7 + 0.08;
  const zMax = Math.abs(tipDx * sinY) + c + 0.14;

  return {
    rootX, rootY,
    cosA, sinA,
    cosY, sinY,
    centerFx: centerArmX, a, b, c,
    invA: 1 / a, invB: 1 / b, invC: 1 / c,
    invA2: 1 / (a * a), invB2: 1 / (b * b), invC2: 1 / (c * c),
    xMin, xMax, yMin, yMax, zMax
  };
}

export function widthToInverseHeight(w) {
  const t = clamp((w - BODY_WIDTH_MIN) / (BODY_WIDTH_MAX - BODY_WIDTH_MIN), 0, 1);
  return roundTo(BODY_HEIGHT_MIN + (1 - t) * (BODY_HEIGHT_MAX - BODY_HEIGHT_MIN), 2);
}

export function heightToInverseWidth(h) {
  const t = clamp((h - BODY_HEIGHT_MIN) / (BODY_HEIGHT_MAX - BODY_HEIGHT_MIN), 0, 1);
  return roundTo(BODY_WIDTH_MIN + (1 - t) * (BODY_WIDTH_MAX - BODY_WIDTH_MIN), 2);
}

export function setByPath(object, path, value) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((target, key) => target[key], object)[last] = value; }

export function hashSeed(seed) { let value = 2166136261 >>> 0; for (const character of String(seed)) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); } return value >>> 0; }

export function mulberry32(seed) { let value = seed >>> 0; return () => { value += 0x6D2B79F5; let result = value; result = Math.imul(result ^ (result >>> 15), result | 1); result ^= result + Math.imul(result ^ (result >>> 7), result | 61); return ((result ^ (result >>> 14)) >>> 0) / 4294967296; }; }

// Character files ---------------------------------------------------------

const record = (value) => value && typeof value === 'object' && !Array.isArray(value), number = (value, fallback, min, max) => { const parsed = Number(value); return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback; }, boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback, option = (value, values, fallback) => values.includes(value) ? value : fallback, colour = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : fallback;

// Converts a "Create Kin" file (schema: "pixelkin") to the lab's sections.
export function kinFileToSpec(input) {
  if(input.schema==='pixelkin') {
    if(input.version!==1 || !input.body || !input.face || !PixelkinPersonalities.profiles[input.personality])throw new Error('Invalid Kin JSON');
    input={seed:input.seed,body:input.body,face:{...input.face,personality:input.personality,...input.accessories},palette:{base:input.body.colour,gradient:input.body.gradient}};
  }
  return input;
}

// Reads seed, body, face and palette from a spec into `next`. The lab uses it
// for its own imports, so files read the same everywhere.
export function parseKinSections(input, next) {
  next.seed = Math.floor(number(input.seed, next.seed, 1, 999999999));
  if (record(input.body)) {
    const source = input.body;
    const size = Array.isArray(source.size) ? source.size : [source.width, source.height, source.depth];
    next.body.shape = option(source.shape, ['sphere', 'cube', 'roundedBox', 'capsule'], next.body.shape);
    next.body.width = number(size[0] ?? source.width, next.body.width, BODY_WIDTH_MIN, BODY_WIDTH_MAX);
    next.body.height = number(size[1] ?? source.height, next.body.height, BODY_HEIGHT_MIN, BODY_HEIGHT_MAX);
    next.body.depth = next.body.shape === 'capsule' ? Math.min(next.body.width,next.body.height) : next.body.width;
    next.body.roundness=bodyRoundness(next.body.shape);
    if (record(source.stripes)) next.body.stripes = boolean(source.stripes.enabled, false);
    else next.body.stripes = boolean(source.stripes ?? source.polkaDots, false);
    if (record(source.pants)) next.body.pants = boolean(source.pants.enabled ?? source.pants, false);
    else next.body.pants = boolean(source.pants, false);
    if (record(source.arms)) {
      next.body.arms = boolean(source.arms.enabled ?? source.arms, false);
      next.body.fins = next.body.arms;
    } else if (source.arms !== undefined) {
      next.body.arms = boolean(source.arms, false);
      next.body.fins = next.body.arms;
    } else if (record(source.fins)) {
      next.body.arms = boolean(source.fins.enabled ?? source.fins, false);
      next.body.fins = next.body.arms;
    } else if (source.fins !== undefined) {
      next.body.arms = boolean(source.fins, false);
      next.body.fins = next.body.arms;
    }
    if (record(source.shininess)) next.body.shininess = source.shininess.enabled ? number(source.shininess.intensity, 0.25, 0, 1) : 0;
    else if (typeof source.shininess === 'boolean') next.body.shininess = source.shininess ? 0.25 : 0;
    else next.body.shininess = number(source.shininess ?? source.brightness, next.body.shininess ?? 0, 0, 1) > 0 ? 0.25 : 0;
    if (record(source.glitter)) next.body.glitter = source.glitter.enabled ? number(source.glitter.intensity, 0.5, 0, 1) : 0;
    else if (typeof source.glitter === 'boolean') next.body.glitter = source.glitter ? 0.5 : 0;
    else next.body.glitter = number(source.glitter, next.body.glitter ?? 0, 0, 1) > 0 ? 0.5 : 0;
  }

  if (record(input.face)) {
    const source = input.face;
    next.face.expression = option(source.expression, Object.keys(EXPRESSIONS), next.face.expression);
    next.face.personality=option(source.personality,Object.keys(PixelkinPersonalities.profiles),"neutral");
    next.face.disableAccessories = boolean(source.disableAccessories, Boolean(next.face.disableAccessories));
    let rawGlasses = source.glasses;
    if (record(rawGlasses)) {
      rawGlasses = rawGlasses.enabled === false ? 'none' : (rawGlasses.model || rawGlasses.name || rawGlasses.type || 'none');
    }
    const mappedGlasses = PixelkinAccessories.getGlasses(rawGlasses) ? rawGlasses : (rawGlasses === 'matrix' || rawGlasses === 'matrix_oval' || rawGlasses === 'Circle sunglasses') ? 'matrix_oval'
      : (rawGlasses === 'matrix_square' || rawGlasses === 'Square sunglasses') ? 'matrix_square'
      : (rawGlasses === 'matrix_aviator' || rawGlasses === 'Aviator') ? 'matrix_aviator'
      : (rawGlasses === 'matrix_clear' || rawGlasses === 'matrix_aviator_clear' || rawGlasses === 'Eyeglasses') ? 'matrix_clear'
      : 'none';
    next.face.glasses = mappedGlasses;
    next.face.glassesColor = colour(source.glassesColor ?? (record(source.glasses) && source.glasses.materials?.frameColor), next.face.glassesColor || '#400a56');
    next.face.glassesFrameMode = option(source.glassesFrameMode, ['+30_dark', '+30_light', '-30_dark', '-30_light', 'custom'], next.face.glassesFrameMode || '+30_dark');
    next.face.glassesTint = option(source.glassesTint ?? (record(source.glasses) && source.glasses.materials?.lensTint), ['dark', 'amber', 'blue', 'rose', 'neon', 'clear'], next.face.glassesTint || 'dark');
    next.face.halloween=option(source.halloween,['none',...PixelkinAccessories.ids('halloween')],'none');
    next.face.christmas=option(source.christmas,['none',...PixelkinAccessories.ids('christmas')],'none');
    let rawHat = source.hat;
    if (record(rawHat)) rawHat = rawHat.enabled === false ? 'none' : (rawHat.type || 'none');
    next.face.hat = option(rawHat, ['none', ...PixelkinAccessories.ids('hat')], next.face.hat || 'none');
    next.face.hatHeight = number(source.hatHeight ?? (record(source.hat) && source.hat.heightOffset), getHatDefaultHeight(next.body.shape, next.body.height), -0.35, 0.45);
    next.face.autoBlink = true;
    next.face.eyeSize = number(source.eyeSize, next.face.eyeSize, 1.0, 1.6);
    next.face.browThickness = number(source.browThickness, next.face.browThickness, 1.5, 4);
    next.face.mouthSize = number(source.mouthSize, next.face.mouthSize, 1.0, 1.5);
  }

  if (record(input.palette)) {
    next.palette.base = limitKinSaturation(colour(input.palette.base, next.palette.base));
    next.palette.grayscale = boolean(input.palette.grayscale, next.palette.grayscale);
    if (record(input.palette.gradient)) next.palette.gradient = boolean(input.palette.gradient.enabled, next.palette.gradient);
    else next.palette.gradient = boolean(input.palette.gradient, next.palette.gradient);
  }
  if(next.face.halloween && next.face.halloween!=='none'){next.face.hat='none';next.face.glasses='none';next.face.christmas='none';}
  if(next.face.christmas!=='none')next.face.hat='none';
  return next;
}

export function readKin(input) {
  if (!record(input)) throw new Error('Expected a JSON object');
  return parseKinSections(kinFileToSpec(input), clone(KIN_DEFAULTS));
}

export function kinToJson(kin, { name = '', role = '' } = {}) {
  return {
    schema:'pixelkin',version:1,
    name,
    role,
    seed:kin.seed,
    body:{shape:kin.body.shape,width:kin.body.width,height:kin.body.height,depth:kin.body.depth,colour:kin.palette.base,gradient:Boolean(kin.palette.gradient),glitter:kin.body.glitter,shininess:kin.body.shininess,stripes:Boolean(kin.body.stripes),arms:!kin.face.disableAccessories && Boolean(kin.body.arms)},
    face:{eyeSize:kin.face.eyeSize,browThickness:kin.face.browThickness,mouthSize:kin.face.mouthSize},
    personality:kin.face.personality,
    accessories:{christmas:kin.face.disableAccessories?'none':kin.face.christmas,halloween:kin.face.disableAccessories?'none':kin.face.halloween,hat:kin.face.disableAccessories?'none':kin.face.hat,hatHeight:kin.face.hatHeight,glasses:kin.face.disableAccessories?'none':kin.face.glasses}
  };
}

// Editing -----------------------------------------------------------------

// Applies one editor change with the generator's rules: accessories replace
// each other, width and height trade off, and hat height follows the body.
export function editKin(kin, path, value, { depthDecoupled = false } = {}) {
  const wasDefaultHatHeight = Math.abs(kin.face.hatHeight - getHatDefaultHeight(kin.body.shape, kin.body.height)) < 0.001;
  setByPath(kin, path, value);
  if(path==='face.halloween' && value!=='none'){kin.face.hat='none';kin.face.glasses='none';kin.face.christmas='none';}
  if(path==='face.christmas' && value!=='none'){kin.face.halloween='none';kin.face.hat='none';}
  if(path==='face.hat' && value!=='none')kin.face.christmas='none';
  if(['face.hat','face.glasses'].includes(path) && value!=='none')kin.face.halloween='none';
  if(path==='body.fins' || path==='body.arms'){kin.body.arms=Boolean(value);kin.body.fins=Boolean(value);}
  if (path === 'body.shape') {
    kin.face.hatHeight = getHatDefaultHeight(value, kin.body.height);
    kin.body.roundness=bodyRoundness(value);
    kin.body.depth=value==='capsule'?Math.min(kin.body.width,kin.body.height):kin.body.width;
  } else if (path === 'body.width') {
    kin.body.height = widthToInverseHeight(value);
    kin.body.depth = kin.body.shape === 'capsule' ? Math.min(kin.body.width,kin.body.height) : kin.body.width;
  } else if (path === 'body.height') {
    kin.body.width = heightToInverseWidth(value);
    if (!depthDecoupled) {
      kin.body.depth = kin.body.shape === 'capsule' ? Math.min(kin.body.width,kin.body.height) : kin.body.width;
    }
  } else if (path === 'body.depth') {
    kin.body.depth = Number(value);
  }
  if (wasDefaultHatHeight && ['body.width', 'body.height'].includes(path)) kin.face.hatHeight = getHatDefaultHeight(kin.body.shape, kin.body.height);
  return kin;
}

// The generator's Randomize: rebuilds body, face and palette from a seed.
// Returns the accessories it picked, for editors that keep them aside while
// accessories are disabled, and how long to hold the first expression.
export function randomKin(kin, seed) {
  const keepAccessoriesDisabled = Boolean(kin.face.disableAccessories);
  const random = mulberry32(hashSeed(seed)), choice = (array) => array[Math.floor(random() * array.length)], paletteChoices = ['#7658e8', '#ef8b36', '#47c98b', '#ef5f89', '#39a7ff', '#f0d65b', '#8b79ff', '#35d5d0'], shape = choice(['sphere', 'cube', 'roundedBox', 'capsule']); kin.body.shape = shape;

  if (shape === 'sphere') {
    kin.body.width = roundTo(lerp(BODY_WIDTH_MIN, BODY_WIDTH_MAX, random()));
    kin.body.height = widthToInverseHeight(kin.body.width);
    kin.body.depth = kin.body.shape === 'capsule' ? Math.min(kin.body.width,kin.body.height) : kin.body.width;
    kin.body.roundness = 0.28;
  } else if (shape === 'capsule') {
    kin.body.width = roundTo(lerp(BODY_WIDTH_MIN, BODY_WIDTH_MAX, random()));
    kin.body.height = widthToInverseHeight(kin.body.width);
    kin.body.depth = kin.body.shape === 'capsule' ? Math.min(kin.body.width,kin.body.height) : kin.body.width;
    kin.body.roundness = 0.35;
  } else {
    kin.body.width = roundTo(lerp(BODY_WIDTH_MIN, BODY_WIDTH_MAX, random()));
    kin.body.height = widthToInverseHeight(kin.body.width);
    kin.body.depth = kin.body.shape === 'capsule' ? Math.min(kin.body.width,kin.body.height) : kin.body.width;
    kin.body.roundness = bodyRoundness(shape);
  }
  kin.face.hatHeight = getHatDefaultHeight(shape, kin.body.height);
  kin.body.shininess = random() < 0.45 ? 0.25 : 0;
  kin.body.glitter = random() < 0.25 ? 0.5 : 0;
  const pickedFins = random() < 0.35;
  const pickedStripes = random() < 0.35;
  const pickedPants = false;
  const hasGlasses = random() < 0.50;
  const pickedGlasses = hasGlasses ? choice(PixelkinAccessories.ids('glasses')) : 'none';
  kin.face.halloween=keepAccessoriesDisabled?'none':choice(['none','none','none',...PixelkinAccessories.ids('halloween')]);
  kin.face.christmas=keepAccessoriesDisabled || kin.face.halloween!=='none'?'none':choice(['none','none','none',...PixelkinAccessories.ids('christmas')]);
  const pickedHat = choice(['none','none',...PixelkinAccessories.ids('hat')]);
  kin.face.disableAccessories = keepAccessoriesDisabled;
  if (keepAccessoriesDisabled) {
    kin.face.glasses = 'none';
    kin.face.hat = 'none';
    kin.body.arms = false; kin.body.fins = false;
    kin.body.stripes = false;
    kin.body.pants = false;
  } else {
    kin.body.arms = pickedFins;
    kin.body.fins = pickedFins;
    kin.body.stripes = pickedStripes;
    kin.body.pants = pickedPants;
    kin.face.glasses = kin.face.halloween!=='none'?'none':pickedGlasses;
    kin.face.hat = kin.face.halloween!=='none' || kin.face.christmas!=='none'?'none':pickedHat;
    if (kin.face.glasses !== 'none') {
      kin.face.glassesTint = choice(['dark', 'amber', 'blue', 'rose', 'neon', 'clear']);
      kin.face.glassesFrameMode = choice(['+30_dark', '+30_light', '-30_dark', '-30_light']);
    }
  }
  const randomHue = random();
  const randomSat = lerp(0.30, 0.90, random()); // Saturación de 30 a 100
  const randomLight = lerp(0.50, 0.63, random());
  const randomRgb = hslToRgb(randomHue, randomSat, randomLight);
  kin.palette.base = rgbToHex(randomRgb.r, randomRgb.g, randomRgb.b);
  kin.palette.grayscale = false;
  kin.palette.gradient = random() < 0.45;
  kin.face.personality=choice(Object.keys(PixelkinPersonalities.profiles));
  const personalityProfile=PixelkinPersonalities.profiles[kin.face.personality];
  kin.face.expression=PixelkinPersonalities.pick(personalityProfile.weights,random);
  const expressionHold=lerp(...personalityProfile.hold,random());
  kin.face.eyeSize = roundTo(lerp(1.0, 1.6, random()), 2);
  kin.face.browThickness = roundTo(lerp(1.5, 4, random()), 2);
  kin.face.mouthSize = roundTo(lerp(1.0, 1.5, random()), 2);
  return { glasses: pickedGlasses, hat: pickedHat, fins: pickedFins, stripes: pickedStripes, pants: pickedPants, expressionHold };
}

// Framing -----------------------------------------------------------------

export function kinVisualScale(body, solo = true) {
  const widthMidpoint=(BODY_WIDTH_MIN+BODY_WIDTH_MAX)/2;
  const heightMidpoint=(BODY_HEIGHT_MIN+BODY_HEIGHT_MAX)/2;
  const widthProgress=clamp((body.width-widthMidpoint)/(BODY_WIDTH_MAX-widthMidpoint),0,1);
  const heightProgress=clamp((body.height-heightMidpoint)/(BODY_HEIGHT_MAX-heightMidpoint),0,1);
  const sizeProgress=Math.max(widthProgress,heightProgress);
  const shapeScale=body.shape==='capsule' || body.shape==='sphere' ? 1.10 : 1;
  return solo ? (1-.05*sizeProgress*sizeProgress*(3-2*sizeProgress))*shapeScale : 1;
}

// Extra room above and around the body for hats, horns, antlers and arms.
export function kinBounds(kin, { halfX, halfY, halfZ, shapeCode, radius, armParams, visualScale, solo = true }) {
  const face = kin.face;
  const hasHat = (solo && Boolean(PixelkinAccessories.getHat(face.hat))) && !face.disableAccessories && face.hat && face.hat !== 'none';
  const hatOffset = Number(face.hatHeight ?? 0);
  const hatParams = hasHat ? computeHatParams(face.hat, halfX, halfY, halfZ, shapeCode, radius, hatOffset) : null;
  const hornExtraY=!face.disableAccessories && face.halloween==='devil_horns' ? .4 : 0;
  const christmasExtraY=!face.disableAccessories && face.christmas!=='none'?.65:0;
  const hatExtraY = Math.max(christmasExtraY,hornExtraY,hatParams ? Math.max(0, hatParams.yMax - halfY) : 0);
  const hatExtraZ = hatParams ? Math.max(hatParams.extraZFront || 0, hatParams.extraZBack || 0) : 0;
  const hatExtraX = hatParams ? (hatParams.extraX || 0) : 0;
  const armExtraX = armParams ? Math.max(0.35, armParams.xMax - halfX + 0.05) : 0;
  const armExtraY = armParams ? Math.max(0.35, Math.abs(armParams.yMin) - halfY + 0.05) : 0;
  const boundRadius = Math.hypot(halfX + hatExtraX + armExtraX, halfY + hatExtraY + armExtraY, halfZ + hatExtraZ) + 0.06;
  const ghostLift = !face.disableAccessories && face.halloween === 'ghost' ? 0.12 * visualScale : 0;
  const centerOffsetY = hatExtraY * 0.5 - ghostLift;
  return { hatParams, hatExtraX, hatExtraY, hatExtraZ, boundRadius, centerOffsetY };
}

// Resting frame for apps that draw a Kin without the lab's interactive motion.
export function kinRestFrame(kin, { armSwing = 0 } = {}) {
  const body = kin.body, visualScale = kinVisualScale(body);
  const halfX = body.width * visualScale * 0.5, halfY = body.height * visualScale * 0.5, halfZ = body.depth * visualScale * 0.5;
  const shapeCode = (body.shape === 'cube' || body.shape === 'roundedBox') ? 1 : body.shape === 'capsule' ? 3 : 0;
  const minRadius = shapeCode === 1 ? 0.10 : 0.015;
  const radius = clamp(bodyRoundness(body.shape) * visualScale, minRadius * visualScale, Math.min(halfX, halfY, halfZ) - 0.01);
  const hasArms = !kin.face.disableAccessories && Boolean(body.arms ?? body.fins);
  const armParams = hasArms ? computeArmParams(halfX, halfY, halfZ, body.width, body.height, armSwing) : null;
  const { boundRadius, centerOffsetY } = kinBounds(kin, { halfX, halfY, halfZ, shapeCode, radius, armParams, visualScale });
  return { visualScale, bodyY: centerOffsetY ? -centerOffsetY : 0, boundRadius };
}

// Renderer member ---------------------------------------------------------

export function prepareKinHat(member, hat = member.hat, disableAccessories = false) {
  member.hatParts=[];
  if(!disableAccessories && member.christmas==='reindeer_antlers'){
    const b=member.body,span=b.shape==='capsule'?Math.min(b.width,b.height):b.width,x=span*.14,height=clamp((b.width+b.height)*.24,.55,.85)*1.1,width=height*.8;
    let root=b.height*.5-.03;
    if(b.shape==='sphere')root=b.height*.5*Math.sqrt(Math.max(0,1-Math.pow((x+width*.065)/(b.width*.5),2)))-.025;
    if(b.shape==='capsule'){const r=Math.min(b.width,b.height,b.depth)*.5,segment=Math.max(0,Math.max(b.width,b.height)*.5-r);root=b.width>b.height?Math.sqrt(Math.max(0,r*r-Math.pow(Math.max(0,x+width*.065-segment),2)))-.025:segment+Math.sqrt(Math.max(0,r*r-Math.pow(x+width*.065,2)))-.025;}
    member.hatParts=[-1,1].map(side=>({shape:side<0?'antlerLeft':'antlerRight',x:side*x,y:root+height*.45-.04,z:0,width,height,depth:width,colour:'#92572f'}));return;
  }
  if(!disableAccessories && (member.christmas==='santa_hat' || member.christmas==='elf_hat')){
    const b=member.body,shape=b.shape==='sphere'?0:b.shape==='capsule'?3:1;
    const p=computeHatParams('beanie',b.width/2,b.height/2,b.depth/2,shape,bodyRoundness(b.shape),Number(member.hatHeight ?? getHatDefaultHeight(b.shape,b.height)));
    const width=p.rx*2,height=p.ry*2.3,elf=member.christmas==='elf_hat';
    member.hatParts=[
      {shape:elf?'elfCrown':'santaCrown',y:p.yBase+height*.5,z:p.domeZOffset,width,height,depth:p.rz*2,colour:elf?'#23864b':'#e32c39'},
      {y:p.cuffYCenter,z:p.zOffset,width:p.cuffRx*2+.036,height:elf?.4056:.24,depth:p.cuffRz*2+.036,colour:elf?'#d93640':'#fff7ed'},
      {lowPoly:true,x:(elf?-1:1)*width*(.65*(1-Math.cos(1.17))+.35*(Math.cos(1.17)-Math.cos(2.47))),y:p.yBase+height*(.65*Math.sin(1.17)+.35*(Math.sin(2.47)-Math.sin(1.17))),z:p.domeZOffset,width:p.pomRadius*2*(elf?.8:1),height:p.pomRadius*2*(elf?.8:1),depth:p.pomRadius*2*(elf?.8:1),colour:elf?'#efc44b':'#fff7ed'}
    ];return;
  }
  if(disableAccessories || !PixelkinAccessories.getHat(hat))return;
  const body=member.body, shapeCode=body.shape==='sphere'?0:body.shape==='capsule'?3:1;
  const p=computeHatParams(hat,body.width/2,body.height/2,body.depth/2,shapeCode,bodyRoundness(body.shape),Number(member.hatHeight ?? getHatDefaultHeight(body.shape, body.height)));
  const rgb=hexToRgb(member.palette),hsl=rgbToHsl(rgb.r,rgb.g,rgb.b);
  const hue=(hsl.h+1/3)%1,sat=clamp(hsl.s*.95,.4,.95),light=clamp(hsl.l*.92,.38,.62);
  const main=hslToRgb(hue,sat,light);
  const whiten=amount=>({r:lerp(main.r,255,amount),g:lerp(main.g,255,amount),b:lerp(main.b,255,amount)});
  const colour=c=>rgbToHex(c.r,c.g,c.b);
  if(hat==='bowler') {
    member.hatParts=[
      {shape:'bowlerCrown',y:p.yBase+.025+p.ry*.5,z:0,width:p.rx*2,height:p.ry,depth:p.rz*2,colour:colour(main),band:{colour:colour(whiten(.7)),top:-1+2*(p.bandHalfH*2)/p.ry}},
      {shape:'bowlerBrim',y:p.yBase+.02,z:0,width:p.bx*2,height:.2,depth:p.bz*2,colour:colour(main)}
    ];
    return;
  }
  if(hat==='cap') {
    const front=hslToRgb((hue+.04)%1,clamp(sat*1.05,.45,.95),clamp(light*1.6,.7,.96));
    member.hatParts=[
      {shape:'hemisphere',y:p.yBase+p.ry*.5,z:p.zOffset,width:p.rx*2,height:p.ry,depth:p.rz*2,colour:colour(main),panel:colour(front)},
      {shape:'capVisor',y:p.yBase+.0325,z:p.vz,width:p.rx*2,height:.065,depth:p.visorLength,colour:colour(main)}
    ];
    return;
  }
  member.hatParts=[
    {shape:"hemisphere",y:p.yBase+p.ry*.5,z:p.domeZOffset,width:p.rx*2,height:p.ry,depth:p.rz*2,colour:colour(main)},
    {y:p.cuffYCenter,z:p.zOffset,width:p.cuffRx*2+.036,height:.27,depth:p.cuffRz*2+.036,colour:colour(whiten(.4))},
    {lowPoly:true,y:p.pomY,z:p.pomZOffset,width:p.pomRadius*2,height:p.pomRadius*2,depth:p.pomRadius*2,colour:colour(whiten(.8))}
  ];
}

// Fills the parts of a renderer member that follow from the Kin itself.
export function kinMember(kin, member = { seed: kin.seed, phase: 0 }) {
  const { body, face, palette } = kin;
  const colour = palette.grayscale ? rgbToHex(...(() => { const c=hexToRgb(palette.base), y=Math.round(luminance(c)*255); return [y,y,y]; })()) : palette.base;
  Object.assign(member, {
    body: {...body, arms: !face.disableAccessories && body.arms, stripes: !face.disableAccessories && body.stripes}, hatHeight: face.hatHeight, palette: colour, gradient: Boolean(palette.gradient),
    glitter: Number(body.glitter || 0), browThickness: Number(face.browThickness ?? 1.7) / 1.7 * 1.2,
    faceStyle: [1, Number(face.eyeSize ?? 1.4) / 1.4, Number(face.eyeSize ?? 1.4) / 1.4, Number(face.mouthSize ?? 1)],
  });
  member.christmas=face.disableAccessories?'none':face.christmas;
  member.halloween=face.disableAccessories?'none':face.halloween;
  prepareKinHat(member, face.hat, Boolean(face.disableAccessories));
  member.glasses=face.disableAccessories?'none':face.glasses;
  const bodyRgb=hexToRgb(palette.base),bodyHsl=rgbToHsl(bodyRgb.r,bodyRgb.g,bodyRgb.b);
  const glassesHue=shift=>{const c=hslToRgb((bodyHsl.h+shift)%1,bodyHsl.s,bodyHsl.l);return rgbToHex(c.r,c.g,c.b);};
  const frameRgb=hexToRgb(glassesHue(1/3));
  member.glassesColor=rgbToHex(frameRgb.r*.192,frameRgb.g*.192,frameRgb.b*.192);member.glassesLensColor=glassesHue(.5);
  member.glassesTint=face.glassesTint;
  return member;
}

// Fills the parts of a renderer member that change from frame to frame.
export function setKinPose(member, { expression = 'neutral', blink = 0, mouthReaction = 0, armSwing = 0 } = {}) {
  const preset = EXPRESSIONS[expression] || EXPRESSIONS.neutral, body = member.body;
  member.expression = { ...preset };
  member.faceExpression = { ...preset };
  member.gazeBlink = blink;
  member.mouthReaction = mouthReaction;
  member.armParams = body.arms ? computeArmParams(body.width/2, body.height/2, body.depth/2, body.width, body.height, armSwing) : null;
  return member;
}

export function kinLights(lighting = KIN_RENDER_DEFAULTS.lighting) {
  return lighting.lights.map((light) => { const colour = hexToRgb(light.color); return { ...light, cr: colour.r / 255, cg: colour.g / 255, cb: colour.b / 255, colourLuma: luminance(colour) }; });
}

// The solo stage the generator draws on: camera, lights and pixel settings.
export function kinScene({ width, height, objects, time = 0, render = KIN_RENDER_DEFAULTS.render, lighting = KIN_RENDER_DEFAULTS.lighting, lights = kinLights(lighting), grayscale = false }) {
  const fov=.32, distance=VIEW_SCALE / Math.tan(fov / 2) * 1.10;
  const camera={position:{x:0,y:0,z:distance},target:{x:0,y:0,z:0},fov};
  return {width,height,pixelStep:1,outlineViewport:{width,height},camera,objects,
    lights,ambient:lighting.ambient,coloured:lighting.colored,paletteMode:"canvas",grayscale,
    floor:false,bands:Number(render.bands),pixelDensity:Number(render.resolution)/5.5,
    dither:render.dither,mode:render.mode,outline:Number(render.outline)*.32,time};
}

export { EXPRESSIONS, PixelkinAccessories, PixelkinPersonalities };
