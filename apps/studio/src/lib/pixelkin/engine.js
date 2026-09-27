/** Pixelkin solo engine, extracted from the procedural character lab. */
export const PIXELKIN_EXPRESSIONS = ["neutral","happy","joy","sad","angry","surprised","sleepy","curious","wink"];
export const PIXELKIN_PALETTES = ["#7658e8","#ef8b36","#47c98b","#ef5f89","#39a7ff","#f0d65b","#8b79ff","#35d5d0"];
export const PIXELKIN_SHAPES = ["sphere","roundedBox","cuboid","capsule"];

export function createPixelkinSession(canvas, onChange) {

  'use strict';

  const TAU = Math.PI * 2;
  const VIEW_SCALE = 1.68;
  const CAMERA_Z = 4.0;
  const CROWD_FLOOR_HALF = 8;
  const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  const EXPRESSIONS = {
    neutral: { leftEyeOpen: 1, rightEyeOpen: 1, eyeSmile: 0, eyeTilt: 0, browLift: 0, browTilt: 0, browAsym: 0, mouthCurve: 0.12, mouthOpen: 0, mouthWidth: 0.74, mouthRound: 0, mouthTilt: 0 },
    happy: { leftEyeOpen: 0.88, rightEyeOpen: 0.88, eyeSmile: 0.18, eyeTilt: 0, browLift: 0.12, browTilt: 0.05, browAsym: 0, mouthCurve: 0.92, mouthOpen: 0.18, mouthWidth: 1, mouthRound: 0, mouthTilt: 0 },
    joy: { leftEyeOpen: 0.18, rightEyeOpen: 0.18, eyeSmile: 1, eyeTilt: 0, browLift: 0.28, browTilt: 0.05, browAsym: 0, mouthCurve: 0.62, mouthOpen: 0.9, mouthWidth: 1.04, mouthRound: 0.18, mouthTilt: 0 },
    sad: { leftEyeOpen: 0.78, rightEyeOpen: 0.78, eyeSmile: 0, eyeTilt: -0.08, browLift: 0.1, browTilt: -0.68, browAsym: 0, mouthCurve: -0.86, mouthOpen: 0.08, mouthWidth: 0.72, mouthRound: 0, mouthTilt: 0 },
    angry: { leftEyeOpen: 0.63, rightEyeOpen: 0.63, eyeSmile: 0, eyeTilt: 0.12, browLift: -0.22, browTilt: 0.92, browAsym: 0, mouthCurve: -0.28, mouthOpen: 0.14, mouthWidth: 0.82, mouthRound: 0, mouthTilt: 0 },
    surprised: { leftEyeOpen: 1.34, rightEyeOpen: 1.34, eyeSmile: 0, eyeTilt: 0, browLift: 0.82, browTilt: 0, browAsym: 0, mouthCurve: 0, mouthOpen: 1.05, mouthWidth: 0.52, mouthRound: 1, mouthTilt: 0 },
    sleepy: { leftEyeOpen: 0.18, rightEyeOpen: 0.18, eyeSmile: 0.1, eyeTilt: -0.04, browLift: -0.25, browTilt: -0.1, browAsym: 0, mouthCurve: 0.04, mouthOpen: 0.08, mouthWidth: 0.62, mouthRound: 0.25, mouthTilt: 0 },
    curious: { leftEyeOpen: 0.74, rightEyeOpen: 1.12, eyeSmile: 0, eyeTilt: 0.03, browLift: 0.18, browTilt: 0.1, browAsym: 0.72, mouthCurve: 0.18, mouthOpen: 0, mouthWidth: 0.62, mouthRound: 0, mouthTilt: 0.18 },
    wink: { leftEyeOpen: 0.12, rightEyeOpen: 1.02, eyeSmile: 0.75, eyeTilt: 0, browLift: 0.1, browTilt: 0.08, browAsym: 0.18, mouthCurve: 0.76, mouthOpen: 0.05, mouthWidth: 0.86, mouthRound: 0, mouthTilt: -0.08 }
  };
  window.PIXELKIN_EXPRESSIONS = EXPRESSIONS;

  const DEFAULT_STATE = {
    scene: { mode: 'solo', crowdSize: 18, discoMode: false, discoSpeed: 1, cameraMotion: true, cameraYaw: 0, cameraPitch: 0.55, cameraDistance: 27, cameraTargetX: 0, cameraTargetZ: 0 },
    body: { shape: 'roundedBox', width: 1.55, height: 1.72, depth: 1.32, roundness: 0.28 },
    face: { expression: 'happy', followPointer: true, autoBlink: true, bodyTurn: 0.7, faceSlide: 0.74, pupilTravel: 0.85, gazeSpring: 9 },
    palette: { base: '#7658e8', grayscale: false },
    render: { mode: 'pixel', resolution: 96, targetFps: 30, bands: 5, outline: 0.76, dither: true, background: 'studio', groundShadow: true },
    motion: { idle: 0.65 },
    lighting: {
      ambient: 0.22,
      colored: false,
      orbitSelected: false,
      showGizmos: false,
      selected: 0,
      lights: [
        { name: 'Key', enabled: true, x: -1.25, y: 1.36, z: 2.8, intensity: 1.15, color: '#fff0c2' },
        { name: 'Fill', enabled: true, x: 1.45, y: 0.28, z: 2.15, intensity: 0.48, color: '#8bdcff' },
        { name: 'Rim', enabled: true, x: 0.55, y: 1.5, z: -0.25, intensity: 0.72, color: '#d69cff' }
      ]
    },
    seed: 4812
  };

  let state = clone(DEFAULT_STATE);
  const runtime = {
    lookTargetX: 0, lookTargetY: 0, lookX: 0, lookY: 0, pointerInside: false,
    draggingLight: -1, paused: false, dirty: true, bounce: 0, bounceVelocity: 0,
    blinkAmount: 0, blinkStart: -10, nextBlink: 2.8, expression: clone(EXPRESSIONS.happy),
    lastTime: performance.now(), lastRender: 0, framesThisSecond: 0, fpsWindowStart: performance.now(),
    measuredFps: 0, renderTime: 0, paletteKey: '', paletteLut: new Uint8ClampedArray(256 * 3),
    paletteMeta: { h: 0.7, s: 0.7, l: 0.6 }, toastTimer: 0, currentRenderSize: 96,
    effectiveLights: [], interactionCount: 0, crowdKey: '', crowdMembers: [], danceKey: '', dancePartners: new Map(), cameraDragging: '', cameraPointerX: 0, cameraPointerY: 0,
    lastReadout: 0, specPreviewPending: false
  };

  function stubEl() {
    return {
      value: '', textContent: '', innerHTML: '', checked: false, files: null, type: '', min: 0, max: 100, disabled: false, dataset: {},
      style: { opacity: '1', cursor: '', setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
      querySelector() { return stubEl(); },
      getBoundingClientRect() { return canvas.getBoundingClientRect(); },
      setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    };
  }
  const dummy = stubEl();
  const dom = {
    app: dummy, canvas, stageWrap: canvas.parentElement || canvas,
    lightPad: dummy, resolutionReadout: dummy, fpsReadout: dummy, renderTimeReadout: dummy,
    engineStatus: dummy, pauseButton: dummy, pauseIcon: dummy, gizmoButton: dummy,
    resetButton: dummy, randomizeButton: dummy, exportButton: dummy, copySpecButton: dummy,
    generateSeedButton: dummy, seedInput: dummy, specPreview: dummy, importSpecButton: dummy,
    specFileInput: dummy, toast: dummy, shapeSelect: dummy, roundnessRow: dummy,
    baseColor: dummy, lightEnabled: dummy, lightColor: dummy, lightZ: dummy,
    lightZNumber: dummy, lightZOutput: dummy, lightIntensity: dummy, lightIntensityOutput: dummy,
    interactionHint: dummy, logicalSizeLabel: dummy, crowdControls: dummy,
    shuffleCrowdButton: dummy, resetCameraButton: dummy,
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function damp(current, target, speed, dt) { return lerp(current, target, 1 - Math.exp(-speed * dt)); }
  function roundTo(value, places = 2) { const factor = 10 ** places; return Math.round(value * factor) / factor; }

  function hexToRgb(hex) {
    const clean = String(hex).replace('#', '').trim();
    const expanded = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const number = Number.parseInt(expanded, 16);
    if (!Number.isFinite(number)) return { r: 118, g: 88, b: 232 };
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
  }

  function rgbToHsl(r, g, b) {
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

  function hslToRgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const c = (1 - Math.abs(2 * l - 1)) * s, hp = h * 6, x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) [r, g] = [c, x]; else if (hp < 2) [r, g] = [x, c];
    else if (hp < 3) [g, b] = [c, x]; else if (hp < 4) [g, b] = [x, c];
    else if (hp < 5) [r, b] = [x, c]; else [r, b] = [c, x];
    const m = l - c / 2;
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  function luminance(rgb) { return (rgb.r * 0.2126 + rgb.g * 0.7152 + rgb.b * 0.0722) / 255; }
  function getByPath(object, path) { return path.split('.').reduce((value, key) => value[key], object); }
  function setByPath(object, path, value) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((target, key) => target[key], object)[last] = value; }
  function hashSeed(seed) { let value = 2166136261 >>> 0; for (const character of String(seed)) { value ^= character.charCodeAt(0); value = Math.imul(value, 16777619); } return value >>> 0; }
  function mulberry32(seed) { let value = seed >>> 0; return () => { value += 0x6D2B79F5; let result = value; result = Math.imul(result ^ (result >>> 15), result | 1); result ^= result + Math.imul(result ^ (result >>> 7), result | 61); return ((result ^ (result >>> 14)) >>> 0) / 4294967296; }; }

  function matrixMultiply3(a, b) {
    const out = new Float64Array(9);
    for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) out[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6];
    return out;
  }

  function makeRotation(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
    const ry = new Float64Array([cy, 0, sy, 0, 1, 0, -sy, 0, cy]);
    const rx = new Float64Array([1, 0, 0, 0, cx, -sx, 0, sx, cx]);
    const rz = new Float64Array([cz, -sz, 0, sz, cz, 0, 0, 0, 1]);
    return matrixMultiply3(matrixMultiply3(ry, rx), rz);
  }

  function buildPalette() {
    const key = `${state.palette.base}|${state.palette.grayscale}`;
    if (runtime.paletteKey === key) return;
    runtime.paletteKey = key;
    const rgb = hexToRgb(state.palette.base), hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    runtime.paletteMeta = hsl;
    for (let i = 0; i < 256; i += 1) {
      const t = i / 255; let colour;
      if (state.palette.grayscale) { const value = Math.round(255 * (0.035 + 0.93 * Math.pow(t, 0.86))); colour = { r: value, g: value, b: value }; }
      else colour = hslToRgb(hsl.h + lerp(-0.025, 0.014, t), clamp(hsl.s * (1.05 - 0.22 * t) + 0.08, 0, 1), 0.045 + 0.91 * Math.pow(t, 0.88));
      const offset = i * 3; runtime.paletteLut[offset] = colour.r; runtime.paletteLut[offset + 1] = colour.g; runtime.paletteLut[offset + 2] = colour.b;
    }
  }

  function bodySdf(x, y, z, shapeCode, bx, by, bz, radius) {
    if (shapeCode === 3) {
      const capsuleRadius = Math.min(bx, bz), segment = Math.max(0, by - capsuleRadius), closestY = clamp(y, -segment, segment);
      return Math.hypot(x, y - closestY, z) - capsuleRadius;
    }
    const effectiveRadius = shapeCode === 2 ? Math.min(radius * 0.32 + 0.025, Math.min(bx, by, bz) - 0.005) : radius;
    const qx = Math.abs(x) - Math.max(0.005, bx - effectiveRadius), qy = Math.abs(y) - Math.max(0.005, by - effectiveRadius), qz = Math.abs(z) - Math.max(0.005, bz - effectiveRadius);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - effectiveRadius;
  }

  function getRenderSize() {
    if (state.render.mode === 'pixel') return Number(state.render.resolution);
    if (state.render.mode === 'normals') return 176;
    if (state.render.mode === 'toon') return 192;
    return 216;
  }

  function getSerializableSpec() {
    return {
      seed: state.seed,
      scene: { mode: state.scene.mode, crowdSize: state.scene.crowdSize, discoMode: state.scene.discoMode, discoSpeed: roundTo(state.scene.discoSpeed), cameraMotion: state.scene.cameraMotion, camera: { yaw: roundTo(state.scene.cameraYaw), pitch: roundTo(state.scene.cameraPitch), distance: roundTo(state.scene.cameraDistance), target: [roundTo(state.scene.cameraTargetX), 0, roundTo(state.scene.cameraTargetZ)] } },
      body: { shape: state.body.shape, size: [roundTo(state.body.width), roundTo(state.body.height), roundTo(state.body.depth)], roundness: roundTo(state.body.roundness) },
      face: { expression: state.face.expression, followPointer: state.face.followPointer, bodyTurn: roundTo(state.face.bodyTurn), faceTravel: roundTo(state.face.faceSlide), pupilTravel: roundTo(state.face.pupilTravel), gazeSpring: roundTo(state.face.gazeSpring), autoBlink: state.face.autoBlink },
      palette: { base: state.palette.base.toUpperCase(), grayscale: state.palette.grayscale, bands: state.render.bands },
      render: { mode: state.render.mode, logicalResolution: Number(state.render.resolution), animationFps: Number(state.render.targetFps), outline: roundTo(state.render.outline), dither: state.render.dither, background: state.render.background, groundShadow: state.render.groundShadow },
      motion: { idle: roundTo(state.motion.idle) },
      lighting: {
        ambient: roundTo(state.lighting.ambient), colored: state.lighting.colored, orbitSelected: state.lighting.orbitSelected, showGizmos: state.lighting.showGizmos,
        lights: state.lighting.lights.map((light) => ({ name: light.name, enabled: light.enabled, position: [roundTo(light.x), roundTo(light.y), roundTo(light.z)], intensity: roundTo(light.intensity), color: light.color.toUpperCase() }))
      }
    };
  }

  function normaliseImportedSpec(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object');
    const knownSections = ['seed', 'scene', 'body', 'face', 'palette', 'render', 'motion', 'lighting'];
    if (!knownSections.some((key) => Object.hasOwn(input, key))) throw new Error('No Pixelkin settings found');
    const next = clone(DEFAULT_STATE), record = (value) => value && typeof value === 'object' && !Array.isArray(value), number = (value, fallback, min, max) => { const parsed = Number(value); return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback; }, boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback, option = (value, values, fallback) => values.includes(value) ? value : fallback, colour = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : fallback;

    next.seed = Math.floor(number(input.seed, next.seed, 1, 999999999));
    if (record(input.scene)) {
      const source = input.scene; next.scene.mode = option(source.mode, ['solo', 'crowd'], next.scene.mode); next.scene.crowdSize = Math.round(number(source.crowdSize, next.scene.crowdSize, 4, 48)); next.scene.discoMode = boolean(source.discoMode, next.scene.discoMode); next.scene.discoSpeed = number(source.discoSpeed, next.scene.discoSpeed, .35, 2.5); next.scene.cameraMotion = boolean(source.cameraMotion, next.scene.cameraMotion);
      if (record(source.camera)) { next.scene.cameraYaw = number(source.camera.yaw, next.scene.cameraYaw, -TAU * 16, TAU * 16); next.scene.cameraPitch = number(source.camera.pitch, next.scene.cameraPitch, .14, 1.35); next.scene.cameraDistance = number(source.camera.distance, next.scene.cameraDistance, 7, 50); if (Array.isArray(source.camera.target)) { next.scene.cameraTargetX = number(source.camera.target[0], next.scene.cameraTargetX, -CROWD_FLOOR_HALF, CROWD_FLOOR_HALF); next.scene.cameraTargetZ = number(source.camera.target[2], next.scene.cameraTargetZ, -CROWD_FLOOR_HALF, CROWD_FLOOR_HALF); } }
    }
    if (record(input.body)) { const source = input.body, size = Array.isArray(source.size) ? source.size : [source.width, source.height, source.depth]; next.body.shape = option(source.shape, ['sphere', 'roundedBox', 'cuboid', 'capsule'], next.body.shape); next.body.width = number(size[0], next.body.width, .85, 2.2); next.body.height = number(size[1], next.body.height, .85, 2.25); next.body.depth = number(size[2], next.body.depth, .65, 2.1); next.body.roundness = number(source.roundness, next.body.roundness, .02, .52); }
    if (record(input.face)) { const source = input.face; next.face.expression = option(source.expression, Object.keys(EXPRESSIONS), next.face.expression); next.face.followPointer = boolean(source.followPointer, next.face.followPointer); next.face.autoBlink = boolean(source.autoBlink, next.face.autoBlink); next.face.bodyTurn = number(source.bodyTurn, next.face.bodyTurn, 0, 1); next.face.faceSlide = number(source.faceTravel ?? source.faceSlide, next.face.faceSlide, 0, 1); next.face.pupilTravel = number(source.pupilTravel, next.face.pupilTravel, 0, 1); next.face.gazeSpring = number(source.gazeSpring, next.face.gazeSpring, 2, 18); }
    if (record(input.palette)) { next.palette.base = colour(input.palette.base, next.palette.base); next.palette.grayscale = boolean(input.palette.grayscale, next.palette.grayscale); next.render.bands = Math.round(number(input.palette.bands, next.render.bands, 2, 10)); }
    if (record(input.render)) { const source = input.render, resolutions = [64, 80, 96, 128, 160], frameRates = [12, 15, 24, 30, 60, 120, 240]; next.render.mode = option(source.mode, ['pixel', 'toon', 'smooth', 'normals'], next.render.mode); next.render.resolution = option(Number(source.logicalResolution ?? source.resolution), resolutions, next.render.resolution); next.render.targetFps = option(Number(source.animationFps ?? source.targetFps), frameRates, next.render.targetFps); next.render.outline = number(source.outline, next.render.outline, 0, 1); next.render.dither = boolean(source.dither, next.render.dither); next.render.background = option(source.background, ['studio', 'grid', 'checker', 'void'], next.render.background); next.render.groundShadow = boolean(source.groundShadow, next.render.groundShadow); }
    if (record(input.motion)) next.motion.idle = number(input.motion.idle, next.motion.idle, 0, 1);
    if (record(input.lighting)) {
      const source = input.lighting; next.lighting.ambient = number(source.ambient, next.lighting.ambient, 0, .7); next.lighting.colored = boolean(source.colored, next.lighting.colored); next.lighting.orbitSelected = boolean(source.orbitSelected, next.lighting.orbitSelected); next.lighting.showGizmos = boolean(source.showGizmos, next.lighting.showGizmos);
      if (Array.isArray(source.lights)) source.lights.slice(0, 3).forEach((light, index) => { if (!record(light)) return; const target = next.lighting.lights[index], position = Array.isArray(light.position) ? light.position : [light.x, light.y, light.z]; target.enabled = boolean(light.enabled, target.enabled); target.x = number(position[0], target.x, -5, 5); target.y = number(position[1], target.y, -5, 5); target.z = number(position[2], target.z, -1, 5); target.intensity = number(light.intensity, target.intensity, 0, 2.5); target.color = colour(light.color, target.color); });
    }
    if (next.scene.discoMode) next.lighting.colored = true;
    return next;
  }

  function importSpecText(text, sourceLabel = 'JSON') {
    try {
      const imported = normaliseImportedSpec(JSON.parse(text)); state = imported; runtime.expression = clone(EXPRESSIONS[state.face.expression]); runtime.lookX = 0; runtime.lookY = 0; runtime.lookTargetX = 0; runtime.lookTargetY = 0; runtime.bounce = 0; runtime.bounceVelocity = 0; runtime.paletteKey = ''; runtime.crowdKey = ''; runtime.crowdMembers = []; runtime.danceKey = ''; runtime.dancePartners = new Map(); dom.specPreview.removeAttribute('aria-invalid'); buildPalette(); syncAllControls(); lightPad.render(); showToast(`${sourceLabel} imported`); return true;
    } catch (error) { dom.specPreview.setAttribute('aria-invalid', 'true'); showToast(`Import failed · ${error.message}`); return false; }
  }

  class PixelRenderer {
    constructor(canvas, transparent = false) {
      this.canvas = canvas; this.transparent = transparent; this.ctx = canvas.getContext('2d', { alpha: transparent }); this.ctx.imageSmoothingQuality = 'high';
      this.workCanvas = document.createElement('canvas'); this.workCtx = this.workCanvas.getContext('2d', { alpha: transparent });
      this.width = 0; this.height = 0; this.imageData = null; this.data = null; this.mask = null; this.edgeMask = null;
      this.depth = null; this.normalX = null; this.normalY = null; this.normalZ = null; this.lastFrame = null; this.lastFrameMode = 'pixel';
      this.bodyFrame = null; this.lightScreenPositions = []; this.resizeDisplay();
    }

    resizeDisplay() {
      const rect = this.canvas.getBoundingClientRect(), dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width; this.canvas.height = height; this.ctx = this.canvas.getContext('2d', { alpha: this.transparent }); this.ctx.imageSmoothingQuality = 'high'; runtime.dirty = true;
      }
    }

    ensureBuffers(width, height) {
      if (this.width === width && this.height === height && this.imageData) return;
      this.width = width; this.height = height; this.workCanvas.width = width; this.workCanvas.height = height;
      this.imageData = this.workCtx.createImageData(width, height); this.data = this.imageData.data;
      const count = width * height;
      this.mask = new Uint8Array(count); this.edgeMask = new Uint8Array(count); this.depth = new Float32Array(count);
      this.normalX = new Float32Array(count); this.normalY = new Float32Array(count); this.normalZ = new Float32Array(count);
    }

    render(timeSeconds) {
      const started = performance.now(); buildPalette(); this.resizeDisplay();
      const crowdCeiling = window.CrowdGLRenderer ? 420 : state.scene.discoMode ? 600 : 720;
      const size = state.scene.mode === 'crowd' ? clamp(Math.round(this.canvas.width), 420, crowdCeiling) : getRenderSize();
      this.ensureBuffers(size, size); runtime.currentRenderSize = size;
      const frame = this.makeFrame(timeSeconds); this.bodyFrame = frame;
      if (state.scene.mode === 'crowd') this.renderCrowdWorld(frame);
      else {
        if (this.crowdGL?.canvas) this.crowdGL.canvas.style.display = 'none';
        this.mask.fill(0); this.edgeMask.fill(0); this.depth.fill(Infinity); this.normalX.fill(0); this.normalY.fill(0); this.normalZ.fill(0);
        this.fillBackground(frame); this.renderBody(frame); this.renderOutline(); this.renderFace(frame);
        if (state.lighting.showGizmos) this.renderLightGizmos(frame);
        this.workCtx.putImageData(this.imageData, 0, 0);
      }
      this.ctx.imageSmoothingEnabled = state.render.mode !== 'pixel'; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx.drawImage(this.workCanvas, 0, 0, this.canvas.width, this.canvas.height);
      this.lastFrame = this.workCanvas; this.lastFrameMode = state.render.mode; return performance.now() - started;
    }

    makeFrame(time) {
      const idle = state.motion.idle, breathing = Math.sin(time * 2.05) * 0.025 * idle, secondary = Math.sin(time * 1.13 + 0.6) * 0.012 * idle;
      const bodyY = -0.025 + Math.sin(time * 2.05) * 0.026 * idle + runtime.bounce * 0.31, squashImpact = clamp(-runtime.bounceVelocity * 0.018, -0.055, 0.075);
      const width = state.body.width * (1 + breathing * 0.52 + squashImpact), height = state.body.height * (1 - breathing - squashImpact * 0.82), depth = state.body.depth * (1 + breathing * 0.34 + squashImpact * 0.45);
      const yaw = runtime.lookX * 0.31 * state.face.bodyTurn + Math.sin(time * 0.66) * 0.025 * idle, pitch = -runtime.lookY * 0.19 * state.face.bodyTurn + Math.sin(time * 0.81 + 1.4) * 0.014 * idle, roll = -runtime.lookX * 0.035 * state.face.bodyTurn + secondary;
      const matrix = makeRotation(yaw, pitch, roll), halfX = width * 0.5, halfY = height * 0.5, halfZ = depth * 0.5;
      const radius = clamp(state.body.roundness, 0.015, Math.min(halfX, halfY, halfZ) - 0.01);
      const shapeCode = state.body.shape === 'roundedBox' ? 1 : state.body.shape === 'cuboid' ? 2 : state.body.shape === 'capsule' ? 3 : 0;
      const effectiveLights = state.lighting.lights.map((light, index) => {
        let x = light.x, y = light.y;
        if (state.lighting.orbitSelected && index === state.lighting.selected && !runtime.paused) { const radiusXY = Math.max(0.2, Math.hypot(light.x, light.y)), angle = Math.atan2(light.y, light.x) + time * 0.58; x = Math.cos(angle) * radiusXY; y = Math.sin(angle) * radiusXY; }
        const colour = hexToRgb(light.color); return { ...light, x, y, cr: colour.r / 255, cg: colour.g / 255, cb: colour.b / 255, colourLuma: luminance(colour) };
      });
      runtime.effectiveLights = effectiveLights;
      return { time, bodyY, width, height, depth, halfX, halfY, halfZ, radius, shapeCode, matrix, yaw, pitch, roll, effectiveLights, boundRadius: Math.hypot(halfX, halfY, halfZ) + 0.04 };
    }

    getCrowdMembers() {
      const key = String(state.seed), requestedCount = Number(state.scene.crowdSize);
      if (runtime.crowdKey === key) return runtime.crowdMembers.slice(0, requestedCount).sort((a, b) => a.z - b.z);
      const random = mulberry32(hashSeed(`crowd-${key}`));
      const palettes = ['#7658e8', '#ef8b36', '#47c98b', '#ef5f89', '#39a7ff', '#f0d65b', '#8b79ff', '#35d5d0'];
      const shapes = ['sphere', 'roundedBox', 'cuboid', 'capsule'];
      const expressions = Object.keys(EXPRESSIONS);
      const count = 48, positions = [];
      for (let index = 0; index < count; index += 1) {
        let best = null, bestScore = -1;
        for (let attempt = 0; attempt < 28; attempt += 1) {
          const candidate = { x: lerp(-7.15, 7.15, random()), z: lerp(-7.15, 7.15, random()) };
          const score = positions.length ? positions.reduce((minimum, placed) => Math.min(minimum, Math.hypot(candidate.x - placed.x, candidate.z - placed.z)), Infinity) : Infinity;
          if (score > bestScore) { best = candidate; bestScore = score; }
        }
        positions.push(best);
      }
      runtime.crowdMembers = positions.map((position, index) => {
        const shape = shapes[Math.floor(random() * shapes.length)], body = { shape, width: 1.55, height: 1.72, depth: 1.32, roundness: .28 };
        if (shape === 'sphere') { const base = lerp(1.35, 1.8, random()); body.width = roundTo(base * lerp(.86, 1.13, random())); body.height = roundTo(base * lerp(.88, 1.18, random())); body.depth = roundTo(base * lerp(.78, 1.05, random())); }
        else if (shape === 'capsule') { const capsuleWidth = lerp(1.1, 1.62, random()); body.width = roundTo(capsuleWidth); body.depth = roundTo(capsuleWidth * lerp(.84, 1.02, random())); body.height = roundTo(lerp(capsuleWidth * 1.05, 2.05, random())); body.roundness = .35; }
        else { body.width = roundTo(lerp(1.1, 1.92, random())); body.height = roundTo(shape === 'cuboid' ? lerp(1, 2.05, random()) : lerp(1.2, 1.92, random())); body.depth = roundTo(lerp(.9, 1.68, random())); body.roundness = roundTo(shape === 'cuboid' ? lerp(.04, .24, random()) : lerp(.18, .46, random())); }
        return {
          seed: hashSeed(`${state.seed}-${index}`), x: position.x, z: position.z, body,
          palette: palettes[Math.floor(random() * palettes.length)], expression: expressions[Math.floor(random() * expressions.length)],
          faceStyle: [lerp(.86, 1.15, random()), lerp(.86, 1.16, random()), lerp(.8, 1.18, random()), lerp(.84, 1.17, random())],
          phase: random() * TAU, speed: lerp(1.65, 2.65, random()), bounce: lerp(.65, 1.15, random()), lean: lerp(-.08, .08, random())
        };
      });
      runtime.crowdKey = key;
      return runtime.crowdMembers.slice(0, requestedCount).sort((a, b) => a.z - b.z);
    }

    getDancePartners(members) {
      const key = `${state.seed}|${members.length}`;
      if (runtime.danceKey === key) return runtime.dancePartners;
      const available = new Set(members.map((member) => member.seed)), partners = new Map();
      for (const member of members) {
        if (!available.has(member.seed)) continue;
        available.delete(member.seed); let nearest = null, nearestDistance = Infinity;
        for (const candidate of members) {
          if (!available.has(candidate.seed)) continue;
          const distance = Math.hypot(member.x - candidate.x, member.z - candidate.z);
          if (distance < nearestDistance) { nearest = candidate; nearestDistance = distance; }
        }
        if (!nearest) { partners.set(member.seed, member); continue; }
        available.delete(nearest.seed); partners.set(member.seed, nearest); partners.set(nearest.seed, member);
      }
      runtime.danceKey = key; runtime.dancePartners = partners; return partners;
    }

    getDiscoLights(time) {
      const speed = Number(state.scene.discoSpeed), radii = [5.2, 6.1, 4.4], rates = [.63, -.48, .76];
      return state.lighting.lights.map((light, index) => {
        const angle = time * speed * rates[index] + index * TAU / 3, colour = hexToRgb(light.color);
        return { ...light, x: Math.cos(angle) * radii[index], y: 6.8 + index * .45, z: Math.sin(angle) * radii[index], cr: colour.r / 255, cg: colour.g / 255, cb: colour.b / 255, colourLuma: luminance(colour), coneRadius: 3.15 + index * .3, spotlight: true };
      });
    }

    crowdBodyPath(ctx, member, x, y, width, height) {
      ctx.beginPath();
      if (member.body.shape === 'sphere') ctx.ellipse(x, y, width * 0.5, height * 0.5, member.lean, 0, TAU);
      else if (member.body.shape === 'capsule') ctx.roundRect(x - width * 0.5, y - height * 0.5, width, height, Math.min(width * 0.5, height * 0.28));
      else ctx.roundRect(x - width * 0.5, y - height * 0.5, width, height, member.body.shape === 'cuboid' ? Math.max(1, width * 0.1) : Math.max(2, width * 0.24));
    }

    getCrowdBodySprite(member) {
      const logicalSize = Number(state.render.resolution);
      const disco = state.scene.discoMode;
      const lightingKey = disco ? ['disco-neutral', state.lighting.ambient] : [state.lighting.ambient, state.lighting.colored, state.lighting.lights, roundTo(state.scene.cameraYaw, 2)];
      const cacheKey = JSON.stringify([logicalSize, state.render.mode, state.render.bands, state.render.outline, state.render.dither, state.palette.grayscale, lightingKey, member.body, member.palette]);
      if (member.bodyCanvas && member.bodySpriteKey === cacheKey) return member.bodyCanvas;
      if (!this.crowdBodyRenderer) this.crowdBodyRenderer = new PixelRenderer(document.createElement('canvas'), true);
      const bodyRenderer = this.crowdBodyRenderer, savedState = state;
      const savedRuntime = {
        lookX: runtime.lookX, lookY: runtime.lookY, bounce: runtime.bounce, bounceVelocity: runtime.bounceVelocity,
        expression: runtime.expression, blinkAmount: runtime.blinkAmount, paletteKey: runtime.paletteKey,
        paletteMeta: runtime.paletteMeta, paletteLut: runtime.paletteLut.slice(), effectiveLights: runtime.effectiveLights
      };
      state = clone(savedState); state.scene.mode = 'solo'; state.body = clone(member.body); state.face.expression = member.expression; state.palette.base = member.palette; state.motion.idle = 0; state.render.resolution = logicalSize; state.render.groundShadow = false; state.lighting.showGizmos = false;
      if (disco) {
        state.lighting.ambient = clamp(state.lighting.ambient * .62, .1, .28); state.lighting.colored = false;
        state.lighting.lights = [
          { name: 'Form key', enabled: true, x: -1.65, y: 1.8, z: 3.1, intensity: .92, color: '#ffffff' },
          { name: 'Form fill', enabled: true, x: 1.45, y: .35, z: 2.45, intensity: .28, color: '#ffffff' },
          { name: 'Form rim', enabled: true, x: .55, y: 1.5, z: -.35, intensity: .34, color: '#ffffff' }
        ];
      }
      else { const cameraYaw = state.scene.cameraYaw, cosYaw = Math.cos(cameraYaw), sinYaw = Math.sin(cameraYaw); state.lighting.lights = state.lighting.lights.map((light) => { const worldX = light.x - member.x, worldZ = light.z - member.z; return { ...light, x: worldX * cosYaw - worldZ * sinYaw, z: worldX * sinYaw + worldZ * cosYaw }; }); }
      runtime.lookX = 0; runtime.lookY = 0; runtime.bounce = 0; runtime.bounceVelocity = 0; runtime.blinkAmount = 0; runtime.expression = clone(EXPRESSIONS[member.expression] || EXPRESSIONS.neutral); runtime.paletteKey = '';
      buildPalette(); bodyRenderer.ensureBuffers(logicalSize, logicalSize); bodyRenderer.data.fill(0); bodyRenderer.mask.fill(0); bodyRenderer.edgeMask.fill(0); bodyRenderer.depth.fill(Infinity); bodyRenderer.normalX.fill(0); bodyRenderer.normalY.fill(0); bodyRenderer.normalZ.fill(0);
      const bodyFrame = bodyRenderer.makeFrame(0); bodyRenderer.renderBody(bodyFrame); bodyRenderer.renderOutline(); bodyRenderer.workCtx.putImageData(bodyRenderer.imageData, 0, 0);
      if (!member.bodyCanvas) member.bodyCanvas = document.createElement('canvas');
      member.bodyCanvas.width = logicalSize; member.bodyCanvas.height = logicalSize; const memberContext = member.bodyCanvas.getContext('2d'); memberContext.clearRect(0, 0, logicalSize, logicalSize); memberContext.drawImage(bodyRenderer.workCanvas, 0, 0);
      member.bodySpriteKey = cacheKey; state = savedState; runtime.lookX = savedRuntime.lookX; runtime.lookY = savedRuntime.lookY; runtime.bounce = savedRuntime.bounce; runtime.bounceVelocity = savedRuntime.bounceVelocity; runtime.expression = savedRuntime.expression; runtime.blinkAmount = savedRuntime.blinkAmount; runtime.paletteKey = savedRuntime.paletteKey; runtime.paletteMeta = savedRuntime.paletteMeta; runtime.paletteLut.set(savedRuntime.paletteLut); runtime.effectiveLights = savedRuntime.effectiveLights;
      return member.bodyCanvas;
    }

    getCrowdShadowSprite(member) {
      const bodyCanvas = this.getCrowdBodySprite(member);
      if (member.shadowCanvas && member.shadowSpriteKey === member.bodySpriteKey) return member.shadowCanvas;
      if (!member.shadowCanvas) member.shadowCanvas = document.createElement('canvas');
      const canvas = member.shadowCanvas; canvas.width = bodyCanvas.width; canvas.height = bodyCanvas.height;
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bodyCanvas, 0, 0); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalCompositeOperation = 'source-over'; member.shadowSpriteKey = member.bodySpriteKey;
      return canvas;
    }

    renderCrowdSprite(member, frame, lookX, lookY, keyLight, facing = null) {
      const logicalSize = Number(state.render.resolution), bodyWidth = member.body.width / (VIEW_SCALE * 2) * logicalSize, bodyHeight = member.body.height / (VIEW_SCALE * 2) * logicalSize;
      const spriteWidth = logicalSize, spriteHeight = logicalSize;
      if (!member.spriteCanvas) { member.spriteCanvas = document.createElement('canvas'); member.spriteContext = member.spriteCanvas.getContext('2d'); }
      const canvas = member.spriteCanvas, ctx = member.spriteContext;
      if (canvas.width !== spriteWidth || canvas.height !== spriteHeight) { canvas.width = spriteWidth; canvas.height = spriteHeight; }
      ctx.clearRect(0, 0, spriteWidth, spriteHeight); ctx.imageSmoothingEnabled = false; ctx.drawImage(this.getCrowdBodySprite(member), 0, 0);
      const x = spriteWidth * .5, y = spriteHeight * .5, sourceRgb = hexToRgb(member.palette), sourceLuma = Math.round(luminance(sourceRgb) * 210 + 28);
      const baseRgb = state.palette.grayscale ? { r: sourceLuma, g: sourceLuma, b: sourceLuma } : sourceRgb, baseHsl = rgbToHsl(baseRgb.r, baseRgb.g, baseRgb.b), memberWorldX = member.renderX ?? member.x, memberWorldZ = member.renderZ ?? member.z;
      let lightEnergy = state.lighting.ambient, tintR = state.lighting.ambient, tintG = state.lighting.ambient, tintB = state.lighting.ambient; const dynamicLights = [];
      frame.effectiveLights.forEach((light) => {
        if (!light.enabled || light.intensity <= 0) return;
        const dx = light.x - memberWorldX, dy = light.y - .25, dz = light.z - memberWorldZ, distanceSquared = dx * dx + dy * dy + dz * dz;
        const cone = light.spotlight ? clamp(1 - Math.hypot(dx, dz) / light.coneRadius, 0, 1) : 1;
        const contribution = light.intensity * cone * (0.32 + clamp(dy / (Math.sqrt(distanceSquared) || 1), 0, 1) * .68) / (1 + distanceSquared * (light.spotlight ? .025 : .1));
        lightEnergy += contribution; tintR += contribution * light.cr; tintG += contribution * light.cg; tintB += contribution * light.cb; if (contribution > .002) dynamicLights.push({ light, contribution, dx, dy, dz });
      });
      lightEnergy = clamp(lightEnergy, .14, 1.35);
      const dark = hslToRgb(baseHsl.h, clamp(baseHsl.s * 1.03, 0, 1), clamp(baseHsl.l * .27 + lightEnergy * .04, .04, .28));
      const mid = hslToRgb(baseHsl.h, baseHsl.s, clamp(baseHsl.l * .74 + lightEnergy * .16, .18, .72));
      const bright = hslToRgb(baseHsl.h - .012, clamp(baseHsl.s * .82, 0, 1), clamp(baseHsl.l + lightEnergy * .24, .38, .86));
      if (state.lighting.colored) {
        const tintLuma = Math.max(.001, tintR * .2126 + tintG * .7152 + tintB * .0722);
        [mid, bright].forEach((colour) => { colour.r = clamp(Math.round(colour.r * Math.pow(tintR / tintLuma, .28)), 0, 255); colour.g = clamp(Math.round(colour.g * Math.pow(tintG / tintLuma, .28)), 0, 255); colour.b = clamp(Math.round(colour.b * Math.pow(tintB / tintLuma, .28)), 0, 255); });
      }
      if (state.scene.discoMode) {
        ctx.save(); ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = `rgba(0,0,0,${clamp(.5 - (lightEnergy - state.lighting.ambient) * .32, .12, .48)})`; ctx.fillRect(0, 0, spriteWidth, spriteHeight);
        const camera = this.currentCrowdCamera;
        dynamicLights.forEach(({ light, contribution, dx, dy, dz }) => {
          const distance = Math.hypot(dx, dy, dz) || 1, screenSide = camera ? (dx * camera.right.x + dy * camera.right.y + dz * camera.right.z) / distance : dx / distance;
          const centreX = x + screenSide * bodyWidth * .34, centreY = y - clamp(dy / distance, -.4, 1) * bodyHeight * .3, radius = Math.max(bodyWidth, bodyHeight) * .7, colour = state.lighting.colored ? hexToRgb(light.color) : { r: 255, g: 255, b: 255 }, strength = clamp(contribution * .85, .06, .78), gradient = ctx.createRadialGradient(centreX, centreY, 0, centreX, centreY, radius);
          gradient.addColorStop(0, `rgba(${colour.r},${colour.g},${colour.b},${strength})`); gradient.addColorStop(.42, `rgba(${colour.r},${colour.g},${colour.b},${strength * .42})`); gradient.addColorStop(1, `rgba(${colour.r},${colour.g},${colour.b},0)`); ctx.fillStyle = gradient; ctx.fillRect(0, 0, spriteWidth, spriteHeight);
        });
        ctx.restore();
      }
      const faceVisibility = facing ? facing.visibility : 1, faceSide = facing ? facing.side : 0;
      if (faceVisibility <= .06) return { canvas, bodyWidth, bodyHeight, spriteWidth, spriteHeight };
      const faceWidthFactor = clamp(faceVisibility * 1.2, .22, 1), faceX = x + faceSide * bodyWidth * (1 - faceVisibility) * .31 + lookX * bodyWidth * .08, faceY = y - bodyHeight * .03 - lookY * bodyHeight * .035;
      const expression = EXPRESSIONS[member.expression] || EXPRESSIONS.neutral, eyeGap = bodyWidth * .18 * faceWidthFactor, eyeRadius = Math.max(1, bodyWidth * .055), pupilRadius = Math.max(.65, eyeRadius * .54), ink = `rgb(${dark.r} ${dark.g} ${dark.b})`;
      const blinkCycle = (frame.time * .72 + member.phase) % 3.6, blink = blinkCycle < .15 ? Math.sin(blinkCycle / .15 * Math.PI) : 0, eyeY = faceY - bodyHeight * .12, pupilX = lookX * eyeRadius * .62, pupilY = -lookY * eyeRadius * .45;
      const drawEye = (eyeX, openness, isLeft) => {
        const open = clamp(openness * (1 - blink), .04, 1.4), smileEye = expression.eyeSmile > .58 || open < .2 || (member.expression === 'wink' && isLeft);
        if (smileEye) { ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, logicalSize / 80); ctx.beginPath(); ctx.arc(eyeX, eyeY + eyeRadius * .5, eyeRadius * 1.18, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); return; }
        ctx.fillStyle = state.palette.grayscale ? `rgb(${bright.r} ${bright.g} ${bright.b})` : '#f5f7fb'; ctx.beginPath(); ctx.ellipse(eyeX, eyeY, eyeRadius * 1.25 * faceWidthFactor, Math.max(.7, eyeRadius * 1.55 * open), 0, 0, TAU); ctx.fill();
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(eyeX + pupilX, eyeY + pupilY, pupilRadius, 0, TAU); ctx.fill();
      };
      if (faceVisibility < .3) drawEye(faceX, faceSide < 0 ? expression.leftEyeOpen : expression.rightEyeOpen, faceSide < 0);
      else { drawEye(faceX - eyeGap, expression.leftEyeOpen, true); drawEye(faceX + eyeGap, expression.rightEyeOpen, false); }
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, logicalSize / 96); ctx.lineCap = 'square';
      const browY = eyeY - eyeRadius * 2.5 - expression.browLift * eyeRadius, browTilt = expression.browTilt * eyeRadius;
      ctx.beginPath();
      if (faceVisibility < .3) { ctx.moveTo(faceX - eyeRadius * faceWidthFactor, browY); ctx.lineTo(faceX + eyeRadius * faceWidthFactor, browY + browTilt); }
      else { ctx.moveTo(faceX - eyeGap - eyeRadius, browY - browTilt); ctx.lineTo(faceX - eyeGap + eyeRadius, browY + browTilt); ctx.moveTo(faceX + eyeGap - eyeRadius, browY + browTilt); ctx.lineTo(faceX + eyeGap + eyeRadius, browY - browTilt); }
      ctx.stroke();
      const mouthY = faceY + bodyHeight * .16, mouthWidth = bodyWidth * .23 * expression.mouthWidth * faceWidthFactor;
      ctx.beginPath();
      if (expression.mouthRound > .62) ctx.ellipse(faceX, mouthY, Math.max(1, mouthWidth * .42), Math.max(1.5, bodyHeight * (.035 + expression.mouthOpen * .05)), 0, 0, TAU);
      else if (expression.mouthOpen > .18) ctx.ellipse(faceX, mouthY, mouthWidth * .58, Math.max(1.5, bodyHeight * (.025 + expression.mouthOpen * .04)), 0, 0, TAU);
      else { ctx.moveTo(faceX - mouthWidth, mouthY); ctx.quadraticCurveTo(faceX, mouthY + expression.mouthCurve * bodyHeight * .09, faceX + mouthWidth, mouthY); }
      ctx.stroke();
      return { canvas, bodyWidth, bodyHeight, spriteWidth, spriteHeight };
    }

    renderCrowd(frame) {
      const ctx = this.workCtx, width = this.width, height = this.height, hsl = runtime.paletteMeta;
      const top = hslToRgb(hsl.h, clamp(hsl.s * 0.18, 0.06, 0.2), 0.075), floor = hslToRgb(hsl.h + 0.035, clamp(hsl.s * 0.2, 0.05, 0.22), 0.035);
      const cameraYaw = state.scene.cameraYaw, cameraPitch = state.scene.cameraPitch, cameraZoom = state.scene.cameraZoom, cameraPanX = state.scene.cameraPanX, cameraPanY = state.scene.cameraPanY;
      const horizon = height * (.31 + cameraPitch * .1) + cameraPanY * height, vanishingX = width * (.5 + cameraPanX), background = ctx.createLinearGradient(0, 0, 0, height);
      background.addColorStop(0, `rgb(${top.r} ${top.g} ${top.b})`); background.addColorStop(0.31, `rgb(${Math.round(top.r * .72)} ${Math.round(top.g * .72)} ${Math.round(top.b * .72)})`); background.addColorStop(0.315, `rgb(${floor.r} ${floor.g} ${floor.b})`); background.addColorStop(1, 'rgb(5 7 10)');
      ctx.clearRect(0, 0, width, height); ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(180,190,205,.08)'; ctx.lineWidth = Math.max(0.5, width / 300);
      for (let line = -7; line <= 7; line += 1) { ctx.beginPath(); ctx.moveTo(vanishingX + line * width * .035 + cameraYaw * width * .04, horizon); ctx.lineTo(vanishingX + line * width * .19 - cameraYaw * width * .12, height); ctx.stroke(); }
      for (let line = 1; line <= 7; line += 1) { const t = line / 7, y = horizon + Math.pow(t, 1.65) * (height - horizon); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      const cameraX = 0;
      const members = this.getCrowdMembers(), sharedBounce = runtime.bounce * height * 0.085;
      const crowdHalfSpan = members.reduce((maximum, member) => Math.max(maximum, Math.abs(member.x)), 1);
      const horizontalScale = Math.min(width * 0.105, width * 0.43 / (crowdHalfSpan + 0.62));
      const activeLights = frame.effectiveLights.filter((light) => light.enabled && light.intensity > 0), totalIntensity = activeLights.reduce((sum, light) => sum + light.intensity, 0) || 1;
      const dominantLight = activeLights.reduce((result, light) => ({ x: result.x + light.x * light.intensity, z: result.z + light.z * light.intensity }), { x: 0, z: 0 });
      dominantLight.x /= totalIntensity; dominantLight.z /= totalIntensity;
      const shadowDirectionX = clamp(-dominantLight.x / 3, -.8, .8), shadowDirectionY = clamp(-dominantLight.z / 9, -.42, .24), shadowStrength = clamp(totalIntensity / 5, .12, .5);
      const projected = members.map((member) => {
        const worldZ = (member.z - .5) * 5.2, cosYaw = Math.cos(cameraYaw), sinYaw = Math.sin(cameraYaw), rotatedX = member.x * cosYaw - worldZ * sinYaw, rotatedZ = member.x * sinYaw + worldZ * cosYaw;
        const depth = clamp(rotatedZ / 5.2 + .5, 0, 1), perspective = lerp(.38, 1.05, depth), rawBaseY = lerp(horizon + height * .045, height * .91, Math.pow(depth, 1.18)), baseY = height * .55 + (rawBaseY - height * .55) * cameraZoom;
        const x = vanishingX + (rotatedX - cameraX) * horizontalScale * perspective * cameraZoom;
        const bodyWidth = width * .092 * perspective * cameraZoom * (member.body.width / 1.55), bodyHeight = width * .108 * perspective * cameraZoom * (member.body.height / 1.72);
        const localBounce = Math.max(0, Math.sin(frame.time * member.speed + member.phase)) * height * 0.014 * perspective * member.bounce + sharedBounce;
        const centerY = baseY - bodyHeight * 0.5 - localBounce;
        return { member, depth, perspective, baseY, x, bodyWidth, bodyHeight, localBounce, centerY };
      }).sort((a, b) => a.depth - b.depth);
      if (state.render.groundShadow) projected.forEach((item) => {
        const liftFade = clamp(1 - item.localBounce / Math.max(1, item.bodyHeight), .3, 1), shadowX = item.x + shadowDirectionX * item.bodyWidth * .72, shadowY = item.baseY + shadowDirectionY * item.bodyHeight * .42;
        ctx.fillStyle = `rgba(0,0,0,${shadowStrength * liftFade})`; ctx.beginPath(); ctx.ellipse(shadowX, shadowY, item.bodyWidth * lerp(.45, .82, Math.abs(shadowDirectionX)), Math.max(1, item.bodyHeight * .1), shadowDirectionX * .18, 0, TAU); ctx.fill();
      });
      ctx.imageSmoothingEnabled = state.render.mode !== 'pixel';
      for (const item of projected) {
        const { member, x, centerY, bodyWidth, bodyHeight } = item;
        const lookX = runtime.pointerInside ? runtime.lookX : clamp((cameraX - member.x) * .16, -.35, .35), lookY = runtime.pointerInside ? runtime.lookY : .08;
        const sprite = this.renderCrowdSprite(member, frame, lookX, lookY, dominantLight.x);
        const drawWidth = bodyWidth * sprite.spriteWidth / sprite.bodyWidth, drawHeight = bodyHeight * sprite.spriteHeight / sprite.bodyHeight;
        ctx.drawImage(sprite.canvas, x - drawWidth * .5, centerY - drawHeight * .5, drawWidth, drawHeight);
        ctx.save(); this.crowdBodyPath(ctx, member, x, centerY, bodyWidth, bodyHeight); ctx.clip();
        projected.forEach((caster) => {
          if (caster === item) return;
          const shadowX = caster.x + shadowDirectionX * caster.bodyWidth * .72, shadowY = caster.centerY + shadowDirectionY * caster.bodyHeight * .72;
          const dx = item.x - shadowX, dy = item.centerY - shadowY, reachX = caster.bodyWidth * .72 + item.bodyWidth * .5, reachY = caster.bodyHeight * .62 + item.bodyHeight * .5;
          if (Math.abs(dx) > reachX || Math.abs(dy) > reachY) return;
          ctx.fillStyle = `rgba(3,4,7,${shadowStrength * .24})`; ctx.beginPath(); ctx.ellipse(shadowX, shadowY, caster.bodyWidth * .58, caster.bodyHeight * .5, shadowDirectionX * .16, 0, TAU); ctx.fill();
        });
        ctx.restore();
      }
      if (state.lighting.showGizmos) this.renderCrowdGizmos(frame);
      this.lightScreenPositions = this.lightScreenPositions || [];
    }

    renderCrowdGizmos(frame) {
      const ctx = this.workCtx; this.lightScreenPositions = [];
      frame.effectiveLights.forEach((light, index) => {
        if (!light.enabled) return; const x = (light.x / 6 + .5) * this.width, y = this.height * .2 - light.y * this.height * .04, radius = Math.max(2, this.width * (index === state.lighting.selected ? .019 : .014));
        this.lightScreenPositions[index] = { x, y }; ctx.strokeStyle = light.color; ctx.fillStyle = '#11151c'; ctx.lineWidth = Math.max(1, this.width / 150); ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - radius * 1.6, y); ctx.lineTo(x + radius * 1.6, y); ctx.moveTo(x, y - radius * 1.6); ctx.lineTo(x, y + radius * 1.6); ctx.stroke();
      });
    }

    getCrowdCamera() {
      const yaw = state.scene.cameraYaw, pitch = state.scene.cameraPitch, distance = state.scene.cameraDistance;
      const target = { x: state.scene.cameraTargetX, y: 0, z: state.scene.cameraTargetZ };
      const position = { x: target.x + Math.sin(yaw) * Math.cos(pitch) * distance, y: Math.sin(pitch) * distance, z: target.z + Math.cos(yaw) * Math.cos(pitch) * distance };
      const forwardLength = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z) || 1;
      const forward = { x: (target.x - position.x) / forwardLength, y: (target.y - position.y) / forwardLength, z: (target.z - position.z) / forwardLength };
      const rightLength = Math.hypot(-forward.z, forward.x) || 1, right = { x: -forward.z / rightLength, y: 0, z: forward.x / rightLength };
      const up = { x: right.y * forward.z - right.z * forward.y, y: right.z * forward.x - right.x * forward.z, z: right.x * forward.y - right.y * forward.x };
      const fov = Math.PI * .28, focal = this.height / (2 * Math.tan(fov * .5)), aspect = this.width / this.height;
      const project = (x, y, z) => { const rx = x - position.x, ry = y - position.y, rz = z - position.z, cameraX = rx * right.x + ry * right.y + rz * right.z, cameraY = rx * up.x + ry * up.y + rz * up.z, depth = rx * forward.x + ry * forward.y + rz * forward.z; if (depth <= .08) return null; const scale = focal / depth; return { x: this.width * .5 + cameraX * scale, y: this.height * .5 - cameraY * scale, depth, scale }; };
      return { yaw, pitch, distance, target, position, forward, right, up, fov, focal, aspect, project };
    }

    renderCrowdWorld3D(frame) {
      if (!window.CrowdGLRenderer) return false;
      if (!this.crowdGLAttempted) { this.crowdGLAttempted = true; try { this.crowdGL = new window.CrowdGLRenderer(); if (this.crowdGL.available) { this.crowdGL.canvas.className = 'crowd-gl-canvas'; dom.stageWrap.insertBefore(this.crowdGL.canvas, dom.canvas); } } catch (error) { console.warn('WebGL crowd renderer unavailable; using Canvas fallback.', error); } }
      if (!this.crowdGL?.available) return false;
      const camera = this.getCrowdCamera(); this.currentCrowdCamera = camera;
      const members = this.getCrowdMembers(), disco = state.scene.discoMode, partners = disco ? this.getDancePartners(members) : null, sharedBounce = runtime.bounce * .4, lights = disco ? this.getDiscoLights(frame.time) : frame.effectiveLights;
      const worldMembers = members.map((member) => {
        if (!disco) return { member, x: member.x, z: member.z, bounce: Math.max(0, Math.sin(frame.time * member.speed + member.phase)) * .18 * member.bounce + sharedBounce };
        const partner = partners.get(member.seed) || member, pairPhase = (Math.min(member.seed, partner.seed) % 997) / 997 * TAU, sign = member.seed <= partner.seed ? 1 : -1, beat = frame.time * Number(state.scene.discoSpeed) * 3.15 + pairPhase, px = partner.x - member.x, pz = partner.z - member.z, length = Math.hypot(px, pz) || 1, sideX = -pz / length, sideZ = px / length;
        return { member, partner, x: member.x + sideX * Math.sin(beat) * .2 * sign + px / length * Math.cos(beat * .5) * .08, z: member.z + sideZ * Math.sin(beat) * .2 * sign + pz / length * Math.cos(beat * .5) * .08, bounce: Math.max(0, Math.sin(beat)) * .25 * member.bounce + sharedBounce };
      });
      const worldBySeed = new Map(worldMembers.map((item) => [item.member.seed, item])), objects = worldMembers.map((world) => {
        const partnerWorld = disco ? worldBySeed.get(world.partner?.seed) : null, targetX = partnerWorld && partnerWorld !== world ? partnerWorld.x : camera.position.x, targetZ = partnerWorld && partnerWorld !== world ? partnerWorld.z : camera.position.z, yaw = Math.atan2(targetX - world.x, targetZ - world.z);
        world.member.renderX = world.x; world.member.renderZ = world.z;
        return { member: world.member, x: world.x, y: world.bounce + world.member.body.height * .5, z: world.z, yaw, gaze: disco ? [0, clamp(((partnerWorld?.member.body.height || world.member.body.height) - world.member.body.height) * .18, -.4, .4)] : [runtime.lookX, runtime.lookY] };
      });
      const canvas = this.crowdGL.render({ width: this.width, height: this.height, camera, objects, lights, ambient: state.lighting.ambient, coloured: state.lighting.colored, bands: Number(state.render.bands), pixelDensity: Number(state.render.resolution) / 5.5, dither: state.render.dither, mode: state.render.mode, outline: state.render.outline, disco, time: frame.time });
      if (!canvas) return false; canvas.style.display = 'block'; this.workCtx.clearRect(0, 0, this.width, this.height); if (state.lighting.showGizmos) this.renderCrowdWorldGizmos({ ...frame, effectiveLights: lights }, camera); return true;
    }

    renderCrowdWorld(frame) {
      if (this.renderCrowdWorld3D(frame)) return;
      const ctx = this.workCtx, width = this.width, height = this.height, hsl = runtime.paletteMeta, camera = this.getCrowdCamera(); this.currentCrowdCamera = camera;
      const skyTop = hslToRgb(hsl.h, clamp(hsl.s * .18, .06, .2), .07), skyBottom = hslToRgb(hsl.h + .02, clamp(hsl.s * .15, .05, .18), .025), background = ctx.createLinearGradient(0, 0, 0, height);
      background.addColorStop(0, `rgb(${skyTop.r} ${skyTop.g} ${skyTop.b})`); background.addColorStop(1, `rgb(${skyBottom.r} ${skyBottom.g} ${skyBottom.b})`); ctx.clearRect(0, 0, width, height); ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
      const floorCorners = [[-CROWD_FLOOR_HALF, -CROWD_FLOOR_HALF], [CROWD_FLOOR_HALF, -CROWD_FLOOR_HALF], [CROWD_FLOOR_HALF, CROWD_FLOOR_HALF], [-CROWD_FLOOR_HALF, CROWD_FLOOR_HALF]].map(([x, z]) => camera.project(x, 0, z));
      if (floorCorners.every(Boolean)) { ctx.fillStyle = 'rgba(10,13,18,.96)'; ctx.beginPath(); ctx.moveTo(floorCorners[0].x, floorCorners[0].y); floorCorners.slice(1).forEach((point) => ctx.lineTo(point.x, point.y)); ctx.closePath(); ctx.fill(); }
      ctx.strokeStyle = 'rgba(180,190,205,.11)'; ctx.lineWidth = Math.max(.7, width / 700);
      for (let line = -CROWD_FLOOR_HALF; line <= CROWD_FLOOR_HALF; line += 1) { const a = camera.project(line, .002, -CROWD_FLOOR_HALF), b = camera.project(line, .002, CROWD_FLOOR_HALF), c = camera.project(-CROWD_FLOOR_HALF, .002, line), d = camera.project(CROWD_FLOOR_HALF, .002, line); if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } if (c && d) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke(); } }
      const members = this.getCrowdMembers(), disco = state.scene.discoMode, partners = disco ? this.getDancePartners(members) : null, sharedBounce = runtime.bounce * .4;
      const activeLights = (disco ? this.getDiscoLights(frame.time) : frame.effectiveLights).filter((light) => light.enabled && light.intensity > 0), totalIntensity = activeLights.reduce((sum, light) => sum + light.intensity, 0) || 1;
      const crowdFrame = { ...frame, effectiveLights: activeLights };
      const dominantLight = activeLights.reduce((result, light) => ({ x: result.x + light.x * light.intensity, y: result.y + light.y * light.intensity, z: result.z + light.z * light.intensity }), { x: 0, y: 0, z: 0 }); dominantLight.x /= totalIntensity; dominantLight.y /= totalIntensity; dominantLight.z /= totalIntensity;
      if (disco) activeLights.forEach((light) => {
        const centre = camera.project(light.x, .006, light.z), axisX = camera.project(light.x + light.coneRadius, .006, light.z), axisZ = camera.project(light.x, .006, light.z + light.coneRadius), source = camera.project(light.x, light.y, light.z);
        if (!centre || !axisX || !axisZ) return; const vx = { x: axisX.x - centre.x, y: axisX.y - centre.y }, vz = { x: axisZ.x - centre.x, y: axisZ.y - centre.y }, rgb = hexToRgb(light.color), gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp(light.intensity * .15, .05, .28)})`); gradient.addColorStop(.62, `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp(light.intensity * .055, .02, .11)})`); gradient.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
        ctx.save(); ctx.transform(vx.x, vx.y, vz.x, vz.y, centre.x, centre.y); ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill(); ctx.restore();
        if (source) { ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},.16)`; ctx.lineWidth = Math.max(.7, width / 800); ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(centre.x, centre.y); ctx.stroke(); }
      });
      const screenDistance = 2.2, screenHalfHeight = Math.tan(camera.fov * .5) * screenDistance;
      const gazeTarget = { x: camera.position.x + camera.forward.x * screenDistance + camera.right.x * runtime.lookX * screenHalfHeight * camera.aspect + camera.up.x * runtime.lookY * screenHalfHeight, y: camera.position.y + camera.forward.y * screenDistance + camera.right.y * runtime.lookX * screenHalfHeight * camera.aspect + camera.up.y * runtime.lookY * screenHalfHeight, z: camera.position.z + camera.forward.z * screenDistance + camera.right.z * runtime.lookX * screenHalfHeight * camera.aspect + camera.up.z * runtime.lookY * screenHalfHeight };
      const worldMembers = members.map((member) => {
        if (!disco) return { member, x: member.x, z: member.z, bounce: Math.max(0, Math.sin(frame.time * member.speed + member.phase)) * .18 * member.bounce + sharedBounce };
        const partner = partners.get(member.seed) || member, pairPhase = (Math.min(member.seed, partner.seed) % 997) / 997 * TAU, sign = member.seed <= partner.seed ? 1 : -1, beat = frame.time * Number(state.scene.discoSpeed) * 3.15 + pairPhase;
        const px = partner.x - member.x, pz = partner.z - member.z, length = Math.hypot(px, pz) || 1, sideX = -pz / length, sideZ = px / length;
        return { member, partner, x: member.x + sideX * Math.sin(beat) * .2 * sign + px / length * Math.cos(beat * .5) * .08, z: member.z + sideZ * Math.sin(beat) * .2 * sign + pz / length * Math.cos(beat * .5) * .08, bounce: Math.max(0, Math.sin(beat)) * .25 * member.bounce + sharedBounce };
      });
      const worldBySeed = new Map(worldMembers.map((item) => [item.member.seed, item]));
      const projected = worldMembers.map((world) => {
        const { member } = world, bounceWorld = world.bounce, bottom = camera.project(world.x, bounceWorld, world.z), topPoint = camera.project(world.x, bounceWorld + member.body.height, world.z); if (!bottom || !topPoint) return null;
        member.renderX = world.x; member.renderZ = world.z;
        const head = { x: world.x, y: bounceWorld + member.body.height * .56, z: world.z }, partnerWorld = disco ? worldBySeed.get(world.partner.seed) : null, target = partnerWorld && partnerWorld !== world ? { x: partnerWorld.x, y: partnerWorld.bounce + partnerWorld.member.body.height * .56, z: partnerWorld.z } : gazeTarget;
        const tx = target.x - head.x, ty = target.y - head.y, tz = target.z - head.z, targetLength = Math.hypot(tx, ty, tz) || 1, dx = tx / targetLength, dy = ty / targetLength, dz = tz / targetLength;
        const cx = camera.position.x - head.x, cy = camera.position.y - head.y, cz = camera.position.z - head.z, cameraLength = Math.hypot(cx, cy, cz) || 1, faceForward = { x: cx / cameraLength, y: cy / cameraLength, z: cz / cameraLength };
        const groundTargetLength = Math.hypot(tx, tz) || 1, groundCameraLength = Math.hypot(cx, cz) || 1, frontX = tx / groundTargetLength, frontZ = tz / groundTargetLength, cameraX = cx / groundCameraLength, cameraZ = cz / groundCameraLength;
        const facingDot = frontX * cameraX + frontZ * cameraZ, facingSide = clamp(frontX * camera.right.x + frontZ * camera.right.z, -1, 1), facing = disco ? { visibility: clamp((facingDot + .16) / .76, 0, 1), side: facingSide } : null;
        const forwardDot = Math.max(.01, dx * faceForward.x + dy * faceForward.y + dz * faceForward.z), lookX = disco ? 0 : clamp(Math.atan2(dx * camera.right.x + dy * camera.right.y + dz * camera.right.z, forwardDot) * 2.4, -1, 1), lookY = disco ? clamp(ty / Math.max(.5, targetLength) * .7, -.45, .45) : clamp(Math.atan2(dx * camera.up.x + dy * camera.up.y + dz * camera.up.z, forwardDot) * 2.4, -1, 1);
        const orientedWidth = disco ? Math.abs(facingDot) * member.body.width + Math.abs(facingSide) * member.body.depth : member.body.width, scale = (bottom.scale + topPoint.scale) * .5, bodyWidth = orientedWidth * scale, bodyHeight = member.body.height * scale, centerY = (bottom.y + topPoint.y) * .5;
        return { member, worldX: world.x, worldZ: world.z, depth: bottom.depth, x: bottom.x, bodyWidth, bodyHeight, centerY, bounceWorld, worldCenterY: bounceWorld + member.body.height * .5, lookX, lookY, facing };
      }).filter(Boolean).sort((a, b) => b.depth - a.depth);
      if (state.render.groundShadow) projected.forEach((item) => activeLights.forEach((light) => {
        const sx = item.worldX - light.x, sz = item.worldZ - light.z, horizontal = Math.hypot(sx, sz) || 1, cone = light.spotlight ? clamp(1 - horizontal / light.coneRadius, 0, 1) : 1; if (cone <= .001) return;
        const castLength = clamp(horizontal * item.member.body.height / Math.max(.8, light.y - item.member.body.height), .18, item.member.body.height * 1.8), start = camera.project(item.worldX, .008, item.worldZ), end = camera.project(item.worldX + sx / horizontal * castLength, .008, item.worldZ + sz / horizontal * castLength); if (!start || !end) return;
        const dx = end.x - start.x, dy = end.y - start.y, length = Math.max(2, Math.hypot(dx, dy)), liftFade = clamp(1 - item.bounceWorld / .5, .2, 1), shadow = this.getCrowdShadowSprite(item.member);
        ctx.save(); ctx.translate(start.x, start.y); ctx.rotate(Math.atan2(dy, dx) - Math.PI * .5); ctx.globalAlpha = clamp(light.intensity / totalIntensity * .48 * cone * liftFade, .025, .3); ctx.drawImage(shadow, -item.bodyWidth * .72, 0, item.bodyWidth * 1.44, length * 1.55); ctx.restore();
      }));
      ctx.imageSmoothingEnabled = state.render.mode !== 'pixel';
      for (const item of projected) {
        const sprite = this.renderCrowdSprite(item.member, crowdFrame, item.lookX, item.lookY, dominantLight.x, item.facing), drawWidth = item.bodyWidth * sprite.spriteWidth / sprite.bodyWidth, drawHeight = item.bodyHeight * sprite.spriteHeight / sprite.bodyHeight; ctx.drawImage(sprite.canvas, item.x - drawWidth * .5, item.centerY - drawHeight * .5, drawWidth, drawHeight);
        let occlusion = 0;
        if (!disco) activeLights.forEach((light) => { const rx = item.worldX - light.x, ry = item.worldCenterY - light.y, rz = item.worldZ - light.z, rayLengthSquared = rx * rx + ry * ry + rz * rz || 1; projected.forEach((caster) => { if (caster === item) return; const cx = caster.worldX - light.x, cy = caster.worldCenterY - light.y, cz = caster.worldZ - light.z, along = (cx * rx + cy * ry + cz * rz) / rayLengthSquared; if (along <= .04 || along >= .96) return; const nearestX = light.x + rx * along, nearestY = light.y + ry * along, nearestZ = light.z + rz * along, casterRadius = Math.max(caster.member.body.width, caster.member.body.depth) * .38; if (Math.hypot(caster.worldX - nearestX, caster.worldCenterY - nearestY, caster.worldZ - nearestZ) < casterRadius) occlusion = Math.max(occlusion, light.intensity / totalIntensity); }); });
        if (occlusion > .01) { ctx.save(); this.crowdBodyPath(ctx, item.member, item.x, item.centerY, item.bodyWidth, item.bodyHeight); ctx.clip(); ctx.fillStyle = `rgba(2,3,6,${clamp(occlusion * .3, .06, .34)})`; ctx.fillRect(item.x - item.bodyWidth, item.centerY - item.bodyHeight, item.bodyWidth * 2, item.bodyHeight * 2); ctx.restore(); }
      }
      if (state.lighting.showGizmos) this.renderCrowdWorldGizmos(crowdFrame, camera);
    }

    renderCrowdWorldGizmos(frame, camera) {
      const ctx = this.workCtx; this.lightScreenPositions = [];
      frame.effectiveLights.forEach((light, index) => { if (!light.enabled) return; const point = camera.project(light.x, light.y, light.z); if (!point) return; const radius = Math.max(2, this.width * (index === state.lighting.selected ? .019 : .014)); this.lightScreenPositions[index] = { x: point.x, y: point.y }; ctx.strokeStyle = light.color; ctx.fillStyle = '#11151c'; ctx.lineWidth = Math.max(1, this.width / 150); ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, TAU); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(point.x - radius * 1.6, point.y); ctx.lineTo(point.x + radius * 1.6, point.y); ctx.moveTo(point.x, point.y - radius * 1.6); ctx.lineTo(point.x, point.y + radius * 1.6); ctx.stroke(); });
    }

    fillBackground(frame) {
      const { width, height, data } = this, hsl = runtime.paletteMeta; let top, bottom;
      if (state.render.background === 'void') { top = { r: 6, g: 8, b: 12 }; bottom = { r: 9, g: 11, b: 16 }; }
      else { top = hslToRgb(hsl.h, clamp(hsl.s * 0.22, 0.08, 0.25), 0.072); bottom = hslToRgb(hsl.h + 0.035, clamp(hsl.s * 0.28, 0.08, 0.3), 0.026); }
      const groundY = -0.95, shadowLift = clamp(runtime.bounce * 0.5, 0, 0.8);
      for (let y = 0; y < height; y += 1) {
        const v = y / Math.max(1, height - 1), wy = VIEW_SCALE - ((y + 0.5) / height) * VIEW_SCALE * 2;
        for (let x = 0; x < width; x += 1) {
          const u = x / Math.max(1, width - 1), wx = ((x + 0.5) / width) * VIEW_SCALE * 2 - VIEW_SCALE, offset = (y * width + x) * 4;
          let r, g, b;
          if (state.render.background === 'checker') { const cell = Math.max(4, Math.round(width / 16)), check = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0, base = check ? 23 : 34; r = base; g = base + 2; b = base + 6; }
          else {
            const gradient = Math.pow(v, 1.15); r = lerp(top.r, bottom.r, gradient); g = lerp(top.g, bottom.g, gradient); b = lerp(top.b, bottom.b, gradient);
            const vignette = clamp((Math.hypot(u - 0.5, v - 0.48) - 0.2) * 0.72, 0, 0.34); r *= 1 - vignette; g *= 1 - vignette; b *= 1 - vignette;
            if (state.render.background === 'grid') { const logicalCell = Math.max(5, Math.round(width / 12)); if (x % logicalCell === 0 || y % logicalCell === 0) { r += 7; g += 8; b += 10; } }
          }
          if (state.render.groundShadow) { const sx = wx / Math.max(0.1, frame.halfX * (1.15 + shadowLift * 0.2)), sy = (wy - groundY) / (0.15 + shadowLift * 0.08), shadow = Math.exp(-(sx * sx * 2.4 + sy * sy * 4.4)) * (0.44 - shadowLift * 0.17); r *= 1 - shadow; g *= 1 - shadow; b *= 1 - shadow; }
          data[offset] = clamp(Math.round(r), 0, 255); data[offset + 1] = clamp(Math.round(g), 0, 255); data[offset + 2] = clamp(Math.round(b), 0, 255); data[offset + 3] = 255;
        }
      }
    }

    renderBody(frame) {
      const { width, height, data, mask, depth, normalX, normalY, normalZ } = this, m = frame.matrix;
      const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[3], m11 = m[4], m12 = m[5], m20 = m[6], m21 = m[7], m22 = m[8];
      const dirX = -m20, dirY = -m21, dirZ = -m22, palette = runtime.paletteLut, mode = state.render.mode, quantized = mode === 'pixel' || mode === 'toon';
      const bands = Math.max(2, Number(state.render.bands)), ditherStrength = state.render.dither && quantized ? 0.72 / Math.max(2, bands - 1) : 0;
      const maxSteps = mode === 'pixel' ? 42 : 50, hitEpsilon = 0.0025, ambient = state.lighting.ambient, lights = frame.effectiveLights, colouredLighting = state.lighting.colored;
      for (let pyIndex = 0; pyIndex < height; pyIndex += 1) {
        const worldY = VIEW_SCALE - ((pyIndex + 0.5) / height) * VIEW_SCALE * 2;
        for (let pxIndex = 0; pxIndex < width; pxIndex += 1) {
          const worldX = ((pxIndex + 0.5) / width) * VIEW_SCALE * 2 - VIEW_SCALE, relX = worldX, relY = worldY - frame.bodyY, relZ = CAMERA_Z;
          const originX = m00 * relX + m10 * relY + m20 * relZ, originY = m01 * relX + m11 * relY + m21 * relZ, originZ = m02 * relX + m12 * relY + m22 * relZ;
          const rayB = originX * dirX + originY * dirY + originZ * dirZ, rayC = originX * originX + originY * originY + originZ * originZ - frame.boundRadius * frame.boundRadius, boundDisc = rayB * rayB - rayC;
          if (boundDisc < 0) continue;
          const boundRoot = Math.sqrt(boundDisc); let t = Math.max(0, -rayB - boundRoot); const tFar = -rayB + boundRoot; if (tFar < 0) continue;
          let hit = false, localX = 0, localY = 0, localZ = 0, nLocalX = 0, nLocalY = 0, nLocalZ = 1;
          if (frame.shapeCode === 0) {
            const invX2 = 1 / (frame.halfX * frame.halfX), invY2 = 1 / (frame.halfY * frame.halfY), invZ2 = 1 / (frame.halfZ * frame.halfZ);
            const a = dirX * dirX * invX2 + dirY * dirY * invY2 + dirZ * dirZ * invZ2, b = 2 * (originX * dirX * invX2 + originY * dirY * invY2 + originZ * dirZ * invZ2), c = originX * originX * invX2 + originY * originY * invY2 + originZ * originZ * invZ2 - 1, disc = b * b - 4 * a * c;
            if (disc >= 0) { const root = Math.sqrt(disc), candidateA = (-b - root) / (2 * a), candidateB = (-b + root) / (2 * a); t = candidateA > 0 ? candidateA : candidateB; if (t > 0) { localX = originX + dirX * t; localY = originY + dirY * t; localZ = originZ + dirZ * t; nLocalX = localX * invX2; nLocalY = localY * invY2; nLocalZ = localZ * invZ2; const length = Math.hypot(nLocalX, nLocalY, nLocalZ) || 1; nLocalX /= length; nLocalY /= length; nLocalZ /= length; hit = true; } }
          } else {
            for (let step = 0; step < maxSteps && t <= tFar; step += 1) { localX = originX + dirX * t; localY = originY + dirY * t; localZ = originZ + dirZ * t; const distance = bodySdf(localX, localY, localZ, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius); if (Math.abs(distance) < hitEpsilon) { hit = true; break; } t += Math.max(distance * 0.84, 0.0015); }
            if (hit) { const e = 0.004; nLocalX = bodySdf(localX + e, localY, localZ, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius) - bodySdf(localX - e, localY, localZ, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius); nLocalY = bodySdf(localX, localY + e, localZ, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius) - bodySdf(localX, localY - e, localZ, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius); nLocalZ = bodySdf(localX, localY, localZ + e, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius) - bodySdf(localX, localY, localZ - e, frame.shapeCode, frame.halfX, frame.halfY, frame.halfZ, frame.radius); const length = Math.hypot(nLocalX, nLocalY, nLocalZ) || 1; nLocalX /= length; nLocalY /= length; nLocalZ /= length; }
          }
          if (!hit) continue;
          const worldNormalX = m00 * nLocalX + m01 * nLocalY + m02 * nLocalZ, worldNormalY = m10 * nLocalX + m11 * nLocalY + m12 * nLocalZ, worldNormalZ = m20 * nLocalX + m21 * nLocalY + m22 * nLocalZ;
          const hitWorldX = m00 * localX + m01 * localY + m02 * localZ, hitWorldY = m10 * localX + m11 * localY + m12 * localZ + frame.bodyY, hitWorldZ = m20 * localX + m21 * localY + m22 * localZ;
          const index = pyIndex * width + pxIndex, offset = index * 4; mask[index] = 1; depth[index] = t; normalX[index] = worldNormalX; normalY[index] = worldNormalY; normalZ[index] = worldNormalZ;
          if (mode === 'normals') { data[offset] = Math.round((worldNormalX * 0.5 + 0.5) * 255); data[offset + 1] = Math.round((worldNormalY * 0.5 + 0.5) * 255); data[offset + 2] = Math.round((worldNormalZ * 0.5 + 0.5) * 255); data[offset + 3] = 255; continue; }
          let neutral = ambient, redLight = ambient, greenLight = ambient, blueLight = ambient;
          for (const light of lights) {
            if (!light.enabled || light.intensity <= 0) continue;
            const lx = light.x - hitWorldX, ly = light.y - hitWorldY, lz = light.z - hitWorldZ, distanceSquared = lx * lx + ly * ly + lz * lz, inverseDistance = 1 / Math.sqrt(distanceSquared || 1), dx = lx * inverseDistance, dy = ly * inverseDistance, dz = lz * inverseDistance;
            const diffuseDot = Math.max(0, worldNormalX * dx + worldNormalY * dy + worldNormalZ * dz), attenuation = 1 / (1 + distanceSquared * 0.075), diffuse = light.intensity * diffuseDot * attenuation;
            const hx = dx, hy = dy, hz = dz + 1, halfLength = Math.hypot(hx, hy, hz) || 1, specularDot = Math.max(0, (worldNormalX * hx + worldNormalY * hy + worldNormalZ * hz) / halfLength), specular = Math.pow(specularDot, 28) * light.intensity * 0.2 * attenuation, contribution = diffuse + specular;
            neutral += contribution; redLight += contribution * light.cr; greenLight += contribution * light.cg; blueLight += contribution * light.cb;
          }
          let tone = 1 - Math.exp(-neutral * 1.22);
          if (quantized) { if (ditherStrength > 0) tone += (BAYER_4[(pxIndex & 3) + ((pyIndex & 3) << 2)] / 15 - 0.5) * ditherStrength; tone = Math.round(clamp(tone, 0, 1) * (bands - 1)) / (bands - 1); }
          const paletteIndex = clamp(Math.round(tone * 255), 0, 255), paletteOffset = paletteIndex * 3; let outR = palette[paletteOffset], outG = palette[paletteOffset + 1], outB = palette[paletteOffset + 2];
          if (colouredLighting && neutral > 0.001 && !state.palette.grayscale) { const mixedR = redLight / neutral, mixedG = greenLight / neutral, mixedB = blueLight / neutral, mixedLuma = Math.max(0.001, mixedR * 0.2126 + mixedG * 0.7152 + mixedB * 0.0722); outR *= clamp(Math.pow(mixedR / mixedLuma, 0.34), 0.68, 1.32); outG *= clamp(Math.pow(mixedG / mixedLuma, 0.34), 0.68, 1.32); outB *= clamp(Math.pow(mixedB / mixedLuma, 0.34), 0.68, 1.32); }
          data[offset] = clamp(Math.round(outR), 0, 255); data[offset + 1] = clamp(Math.round(outG), 0, 255); data[offset + 2] = clamp(Math.round(outB), 0, 255); data[offset + 3] = 255;
        }
      }
    }

    renderOutline() {
      if (state.render.mode === 'normals' || state.render.outline <= 0.001) return;
      const { width, height, mask, edgeMask, depth, normalX, normalY, normalZ, data } = this, darkOffset = 8 * 3;
      const darkR = runtime.paletteLut[darkOffset], darkG = runtime.paletteLut[darkOffset + 1], darkB = runtime.paletteLut[darkOffset + 2], normalThreshold = state.render.mode === 'smooth' ? 0.6 : 0.72, depthThreshold = 0.075;
      for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x; if (!mask[index]) continue; const neighbours = [index - 1, index + 1, index - width, index + width];
        for (const other of neighbours) { if (!mask[other] || normalX[index] * normalX[other] + normalY[index] * normalY[other] + normalZ[index] * normalZ[other] < normalThreshold || Math.abs(depth[index] - depth[other]) > depthThreshold) { edgeMask[index] = 1; break; } }
      }
      const strength = state.render.outline * (state.render.mode === 'smooth' ? 0.55 : 1);
      for (let index = 0; index < edgeMask.length; index += 1) if (edgeMask[index]) { const offset = index * 4; data[offset] = Math.round(lerp(data[offset], darkR, strength)); data[offset + 1] = Math.round(lerp(data[offset + 1], darkG, strength)); data[offset + 2] = Math.round(lerp(data[offset + 2], darkB, strength)); }
    }

    setPixel(x, y, colour, alpha = 1, clipToBody = true) {
      const ix = Math.round(x), iy = Math.round(y); if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return; const index = iy * this.width + ix; if (clipToBody && !this.mask[index]) return; const offset = index * 4;
      if (alpha >= 0.999) { this.data[offset] = colour[0]; this.data[offset + 1] = colour[1]; this.data[offset + 2] = colour[2]; }
      else { this.data[offset] = Math.round(lerp(this.data[offset], colour[0], alpha)); this.data[offset + 1] = Math.round(lerp(this.data[offset + 1], colour[1], alpha)); this.data[offset + 2] = Math.round(lerp(this.data[offset + 2], colour[2], alpha)); }
      this.data[offset + 3] = 255;
    }

    drawDisc(cx, cy, radius, colour, alpha = 1, clipToBody = true) {
      const minX = Math.floor(cx - radius - 1), maxX = Math.ceil(cx + radius + 1), minY = Math.floor(cy - radius - 1), maxY = Math.ceil(cy + radius + 1), radiusSquared = radius * radius;
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= radiusSquared) this.setPixel(x, y, colour, alpha, clipToBody); }
    }

    drawEllipse(cx, cy, rx, ry, colour, alpha = 1, clipToBody = true) {
      rx = Math.max(0.45, rx); ry = Math.max(0.45, ry); const minX = Math.floor(cx - rx - 1), maxX = Math.ceil(cx + rx + 1), minY = Math.floor(cy - ry - 1), maxY = Math.ceil(cy + ry + 1), invX = 1 / (rx * rx), invY = 1 / (ry * ry);
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) { const dx = x - cx, dy = y - cy; if (dx * dx * invX + dy * dy * invY <= 1) this.setPixel(x, y, colour, alpha, clipToBody); }
    }

    drawLine(x0, y0, x1, y1, thickness, colour, alpha = 1, clipToBody = true) {
      const distance = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(distance * 1.6)), radius = Math.max(0.55, thickness * 0.5);
      for (let step = 0; step <= steps; step += 1) { const t = step / steps; this.drawDisc(lerp(x0, x1, t), lerp(y0, y1, t), radius, colour, alpha, clipToBody); }
    }

    drawQuadratic(x0, y0, cx, cy, x1, y1, thickness, colour, alpha = 1, clipToBody = true) {
      let previousX = x0, previousY = y0; const segments = Math.max(8, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.2));
      for (let segment = 1; segment <= segments; segment += 1) { const t = segment / segments, inverse = 1 - t, x = inverse * inverse * x0 + 2 * inverse * t * cx + t * t * x1, y = inverse * inverse * y0 + 2 * inverse * t * cy + t * t * y1; this.drawLine(previousX, previousY, x, y, thickness, colour, alpha, clipToBody); previousX = x; previousY = y; }
    }

    drawArc(cx, cy, rx, ry, start, end, thickness, colour, alpha = 1, clipToBody = true) {
      const segments = Math.max(8, Math.ceil(Math.abs(end - start) * Math.max(rx, ry) * 1.3)); let previousX = cx + Math.cos(start) * rx, previousY = cy + Math.sin(start) * ry;
      for (let segment = 1; segment <= segments; segment += 1) { const angle = lerp(start, end, segment / segments), x = cx + Math.cos(angle) * rx, y = cy + Math.sin(angle) * ry; this.drawLine(previousX, previousY, x, y, thickness, colour, alpha, clipToBody); previousX = x; previousY = y; }
    }

    renderFace(frame) {
      if (state.render.mode === 'normals') return;
      const pixelScale = this.width / 96, bodyPixelsWide = frame.width * this.width / (VIEW_SCALE * 2), bodyPixelsHigh = frame.height * this.height / (VIEW_SCALE * 2), unit = Math.max(2.1, Math.min(bodyPixelsWide, bodyPixelsHigh) * 0.104);
      const worldFaceX = runtime.lookX * frame.width * 0.084 * state.face.faceSlide + Math.sin(frame.yaw) * frame.width * 0.045, worldFaceY = frame.bodyY + frame.height * 0.045 + runtime.lookY * frame.height * 0.06 * state.face.faceSlide;
      const centerX = (worldFaceX / VIEW_SCALE + 1) * this.width * 0.5, centerY = (1 - (worldFaceY / VIEW_SCALE + 1) * 0.5) * this.height, compression = clamp(Math.cos(frame.yaw) * 1.015, 0.76, 1);
      const eyeSpacing = unit * 1.42 * compression, eyeY = centerY - unit * 0.72, mouthY = centerY + unit * 1.1, expression = runtime.expression;
      const darkOffset = 8 * 3, midOffset = 78 * 3, lightOffset = 242 * 3;
      const dark = [runtime.paletteLut[darkOffset], runtime.paletteLut[darkOffset + 1], runtime.paletteLut[darkOffset + 2]], mid = [runtime.paletteLut[midOffset], runtime.paletteLut[midOffset + 1], runtime.paletteLut[midOffset + 2]], light = [runtime.paletteLut[lightOffset], runtime.paletteLut[lightOffset + 1], runtime.paletteLut[lightOffset + 2]], white = state.palette.grayscale ? light : [245, 247, 251];
      const pupilTravelX = runtime.lookX * unit * 0.36 * state.face.pupilTravel, pupilTravelY = -runtime.lookY * unit * 0.25 * state.face.pupilTravel, blink = runtime.blinkAmount;
      const leftOpen = clamp(expression.leftEyeOpen * (1 - blink), 0.03, 1.5), rightOpen = clamp(expression.rightEyeOpen * (1 - blink), 0.03, 1.5), eyeRadiusX = unit * 0.52 * compression, browY = eyeY - unit - expression.browLift * unit * 0.44, lineThickness = Math.max(1, 1.2 * pixelScale);
      const drawEye = (eyeX, openness, isLeft) => {
        const smileEye = expression.eyeSmile > 0.58 || openness < 0.22, asymSmile = state.face.expression === 'wink' && isLeft;
        if (smileEye || asymSmile) { this.drawArc(eyeX, eyeY + unit * 0.12, eyeRadiusX * 0.88, unit * (expression.eyeSmile > 0.5 ? 0.54 : 0.24), Math.PI * 1.08, Math.PI * 1.92, lineThickness * 1.22, dark); return; }
        const eyeRadiusY = Math.max(0.7, unit * 0.66 * openness); this.drawEllipse(eyeX, eyeY, eyeRadiusX + lineThickness * 0.65, eyeRadiusY + lineThickness * 0.65, dark); this.drawEllipse(eyeX, eyeY, Math.max(0.55, eyeRadiusX - lineThickness * 0.48), Math.max(0.55, eyeRadiusY - lineThickness * 0.48), white);
        const pupilX = eyeX + clamp(pupilTravelX, -eyeRadiusX * 0.44, eyeRadiusX * 0.44), pupilY = eyeY + clamp(pupilTravelY, -eyeRadiusY * 0.36, eyeRadiusY * 0.36), pupilRadius = Math.max(0.75, unit * 0.24);
        this.drawDisc(pupilX, pupilY, pupilRadius, dark); this.drawDisc(pupilX - pupilRadius * 0.32, pupilY - pupilRadius * 0.34, Math.max(0.45, pupilRadius * 0.27), light);
      };
      drawEye(centerX - eyeSpacing, leftOpen, true); drawEye(centerX + eyeSpacing, rightOpen, false);
      const browHalf = unit * 0.72 * compression, browTilt = expression.browTilt * unit * 0.48, browAsym = expression.browAsym * unit * 0.36;
      this.drawLine(centerX - eyeSpacing - browHalf, browY - browTilt - browAsym, centerX - eyeSpacing + browHalf, browY + browTilt - browAsym, lineThickness, dark);
      this.drawLine(centerX + eyeSpacing - browHalf, browY + browTilt + browAsym, centerX + eyeSpacing + browHalf, browY - browTilt + browAsym, lineThickness, dark);
      const mouthWidth = unit * 2.0 * expression.mouthWidth * compression, mouthTilt = expression.mouthTilt * unit;
      if (expression.mouthRound > 0.62) { const rx = Math.max(unit * 0.46, mouthWidth * 0.42), ry = unit * (0.42 + expression.mouthOpen * 0.58); this.drawEllipse(centerX, mouthY, rx, ry, dark); this.drawEllipse(centerX - rx * 0.22, mouthY - ry * 0.28, Math.max(0.45, rx * 0.15), Math.max(0.4, ry * 0.11), mid, 0.65); }
      else if (expression.mouthOpen > 0.18) { const rx = mouthWidth * 0.56, ry = unit * (0.33 + expression.mouthOpen * 0.57); this.drawEllipse(centerX, mouthY, rx, ry, dark); if (expression.mouthCurve > 0.25) this.drawEllipse(centerX, mouthY + ry * 0.52, rx * 0.58, ry * 0.3, state.palette.grayscale ? mid : [224, 102, 133], 0.9); this.drawArc(centerX, mouthY - ry * 0.08, rx * 0.72, ry * 0.52, Math.PI * 1.08, Math.PI * 1.92, Math.max(0.8, lineThickness * 0.72), light, 0.72); }
      else { const leftX = centerX - mouthWidth * 0.5, rightX = centerX + mouthWidth * 0.5; this.drawQuadratic(leftX, mouthY - mouthTilt, centerX, mouthY + expression.mouthCurve * unit * 1.06, rightX, mouthY + mouthTilt, lineThickness * 1.08, dark); }
      if ((state.face.expression === 'happy' || state.face.expression === 'joy') && !state.palette.grayscale) { this.drawEllipse(centerX - eyeSpacing * 1.58, mouthY - unit * 0.16, unit * 0.42, unit * 0.19, [239, 103, 143], 0.24); this.drawEllipse(centerX + eyeSpacing * 1.58, mouthY - unit * 0.16, unit * 0.42, unit * 0.19, [239, 103, 143], 0.24); }
    }

    renderLightGizmos(frame) {
      this.lightScreenPositions = []; const markerScale = Math.max(1, this.width / 120);
      frame.effectiveLights.forEach((light, index) => { if (!light.enabled) return; const x = (light.x / VIEW_SCALE + 1) * this.width * 0.5, y = (1 - (light.y / VIEW_SCALE + 1) * 0.5) * this.height, rgb = hexToRgb(light.color), colour = [rgb.r, rgb.g, rgb.b], selected = index === state.lighting.selected, radius = (selected ? 3.4 : 2.5) * markerScale; this.lightScreenPositions[index] = { x, y }; this.drawDisc(x, y, radius + 1.25 * markerScale, [20, 23, 30], 0.92, false); this.drawDisc(x, y, radius, colour, 1, false); this.drawLine(x - radius * 1.75, y, x + radius * 1.75, y, markerScale, colour, 0.72, false); this.drawLine(x, y - radius * 1.75, x, y + radius * 1.75, markerScale, colour, 0.72, false); if (selected) this.drawArc(x, y, radius * 2.05, radius * 2.05, 0, TAU, markerScale * 0.65, [238, 243, 249], 0.58, false); });
    }

    lightAtPointer(clientX, clientY) {
      if (!state.lighting.showGizmos) return -1; const rect = this.canvas.getBoundingClientRect(), px = ((clientX - rect.left) / rect.width) * this.width, py = ((clientY - rect.top) / rect.height) * this.height, threshold = Math.max(4, this.width * 0.045); let closest = -1, closestDistance = Infinity;
      this.lightScreenPositions.forEach((position, index) => { if (!position) return; const distance = Math.hypot(px - position.x, py - position.y); if (distance < threshold && distance < closestDistance) { closest = index; closestDistance = distance; } }); return closest;
    }

    updateLightFromStagePointer(index, clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect(), normalizedX = clamp((clientX - rect.left) / rect.width, 0, 1), normalizedY = clamp((clientY - rect.top) / rect.height, 0, 1);
      if (state.scene.mode === 'crowd' && this.currentCrowdCamera) {
        const camera = this.currentCrowdCamera, ndcX = normalizedX * 2 - 1, ndcY = 1 - normalizedY * 2, halfHeight = Math.tan(camera.fov * .5);
        let dx = camera.forward.x + camera.right.x * ndcX * halfHeight * camera.aspect + camera.up.x * ndcY * halfHeight, dy = camera.forward.y + camera.right.y * ndcX * halfHeight * camera.aspect + camera.up.y * ndcY * halfHeight, dz = camera.forward.z + camera.right.z * ndcX * halfHeight * camera.aspect + camera.up.z * ndcY * halfHeight;
        const length = Math.hypot(dx, dy, dz) || 1; dx /= length; dy /= length; dz /= length; const light = state.lighting.lights[index], distance = (light.y - camera.position.y) / dy;
        if (distance > 0) { light.x = roundTo(camera.position.x + dx * distance, 3); light.z = roundTo(camera.position.z + dz * distance, 3); runtime.dirty = true; syncLightControls(); lightPad.render(); updateSpecPreview(); } return;
      }
      state.lighting.lights[index].x = roundTo((normalizedX * 2 - 1) * VIEW_SCALE, 3); state.lighting.lights[index].y = roundTo((1 - normalizedY * 2) * VIEW_SCALE, 3); runtime.dirty = true; syncLightControls(); lightPad.render(); updateSpecPreview();
    }

    exportPng() {
      if (!this.lastFrame) return; const output = document.createElement('canvas'); output.width = 768; output.height = 768; const context = output.getContext('2d', { alpha: false }); context.imageSmoothingEnabled = this.lastFrameMode !== 'pixel'; context.imageSmoothingQuality = 'high'; if (state.scene.mode === 'crowd' && this.crowdGL?.canvas) context.drawImage(this.crowdGL.canvas, 0, 0, 768, 768); context.drawImage(this.lastFrame, 0, 0, 768, 768);
      output.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `pixelkin-${state.body.shape}-${state.seed}.png`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1200); showToast('PNG exported at 768 × 768'); }, 'image/png');
    }
  }

  class LightPad {
    constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.dragging = -1; this.bind(); }
    bind() {
      this.canvas.addEventListener('pointerdown', (event) => { event.preventDefault(); const index = this.nearestLight(event.clientX, event.clientY); this.dragging = index >= 0 ? index : state.lighting.selected; state.lighting.selected = this.dragging; this.canvas.setPointerCapture(event.pointerId); this.updateLight(event.clientX, event.clientY); syncLightControls(); syncButtons(); });
      this.canvas.addEventListener('pointermove', (event) => { if (this.dragging < 0) return; event.preventDefault(); this.updateLight(event.clientX, event.clientY); });
      const finish = (event) => { if (this.dragging >= 0 && this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); this.dragging = -1; };
      this.canvas.addEventListener('pointerup', finish); this.canvas.addEventListener('pointercancel', finish);
    }
    eventPoint(clientX, clientY) { const rect = this.canvas.getBoundingClientRect(); return { x: ((clientX - rect.left) / rect.width) * this.canvas.width, y: ((clientY - rect.top) / rect.height) * this.canvas.height }; }
    nearestLight(clientX, clientY) { const point = this.eventPoint(clientX, clientY); let closest = -1, distance = Infinity; state.lighting.lights.forEach((light, index) => { const x = ((light.x + 3) / 6) * this.canvas.width, y = (1 - (light.y + 3) / 6) * this.canvas.height, candidate = Math.hypot(point.x - x, point.y - y); if (candidate < 28 && candidate < distance) { closest = index; distance = candidate; } }); return closest; }
    updateLight(clientX, clientY) { const point = this.eventPoint(clientX, clientY), light = state.lighting.lights[this.dragging]; light.x = roundTo(clamp((point.x / this.canvas.width) * 6 - 3, -3, 3), 3); light.y = roundTo(clamp((1 - point.y / this.canvas.height) * 6 - 3, -3, 3), 3); runtime.dirty = true; runtime.interactionCount += 1; syncLightControls(); this.render(); updateSpecPreview(); }
    render() {
      const { canvas, ctx } = this, width = canvas.width, height = canvas.height, background = ctx.createLinearGradient(0, 0, 0, height); background.addColorStop(0, '#121722'); background.addColorStop(1, '#090c12'); ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(128,145,166,.12)'; ctx.lineWidth = 1; for (let i = 1; i < 6; i += 1) { const x = (i / 6) * width, y = (i / 6) * height; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(157,253,207,.2)'; ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
      state.lighting.lights.forEach((light, index) => { const x = ((light.x + 3) / 6) * width, y = (1 - (light.y + 3) / 6) * height, selected = index === state.lighting.selected; ctx.save(); ctx.globalAlpha = light.enabled ? 1 : 0.3; ctx.shadowColor = light.color; ctx.shadowBlur = selected ? 22 : 12; ctx.fillStyle = light.color; ctx.beginPath(); ctx.arc(x, y, selected ? 10 : 8, 0, TAU); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = selected ? '#f5f8fb' : 'rgba(255,255,255,.45)'; ctx.lineWidth = selected ? 2 : 1; ctx.beginPath(); ctx.arc(x, y, selected ? 15 : 12, 0, TAU); ctx.stroke(); ctx.fillStyle = '#080a0f'; ctx.font = 'bold 10px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(index + 1), x, y + 0.5); ctx.restore(); });
    }
  }

  const renderer = new PixelRenderer(dom.canvas, false);
  const lightPad = { render() {}, canvas: dummy, ctx: null, dragging: -1, bind() {}, nearestLight() { return -1; }, updateLight() {}, eventPoint() { return { x: 0, y: 0 }; } };

  function updateRangeVisual(input) { const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value); input.style.setProperty('--range-fill', `${clamp(((value - min) / Math.max(0.0001, max - min)) * 100, 0, 100)}%`); }
  function formatOutput(value, format) { if (format === 'percent') return `${Math.round(Number(value) * 100)}%`; if (Number.isInteger(Number(value))) return String(value); return Number(value).toFixed(2); }

  function syncBoundControls() {
    document.querySelectorAll('[data-path]').forEach((element) => { const value = getByPath(state, element.dataset.path); if (element.type === 'checkbox') element.checked = Boolean(value); else element.value = String(value); if (element.type === 'range') updateRangeVisual(element); });
    document.querySelectorAll('[data-output-for]').forEach((output) => { const path = output.dataset.outputFor, input = document.querySelector(`[data-path="${path}"]`), format = input ? input.dataset.format : ''; output.value = formatOutput(getByPath(state, path), format); output.textContent = output.value; });
    dom.seedInput.value = String(state.seed); dom.roundnessRow.style.opacity = state.body.shape === 'sphere' || state.body.shape === 'capsule' ? '0.42' : '1'; const roundnessInput = dom.roundnessRow.querySelector('input'); if (roundnessInput) roundnessInput.disabled = state.body.shape === 'sphere' || state.body.shape === 'capsule';
  }

  function syncButtons() {
    document.querySelectorAll('[data-scene-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.sceneMode === state.scene.mode));
    document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.mode === state.render.mode));
    document.querySelectorAll('[data-expression]').forEach((button) => button.classList.toggle('is-active', button.dataset.expression === state.face.expression));
    document.querySelectorAll('[data-palette]').forEach((button) => button.classList.toggle('is-active', button.dataset.palette.toLowerCase() === state.palette.base.toLowerCase()));
    document.querySelectorAll('[data-light-index]').forEach((button) => button.classList.toggle('is-active', Number(button.dataset.lightIndex) === state.lighting.selected));
    dom.app.classList.toggle('is-crowd', state.scene.mode === 'crowd');
    dom.app.classList.toggle('is-disco', state.scene.mode === 'crowd' && state.scene.discoMode);
    dom.logicalSizeLabel.textContent = state.scene.mode === 'crowd' ? 'Pixel grid / kin' : 'Logical size';
    dom.gizmoButton.classList.toggle('is-active', state.lighting.showGizmos); dom.pauseButton.classList.toggle('is-active', runtime.paused); dom.pauseIcon.textContent = runtime.paused ? '▶' : 'Ⅱ'; dom.pauseButton.setAttribute('aria-label', runtime.paused ? 'Resume animation' : 'Pause animation');
    const cameraMode = state.scene.mode === 'crowd' && state.scene.cameraMotion;
    dom.interactionHint.innerHTML = cameraMode ? `${state.scene.discoMode ? 'DISCO PAIRS ACTIVE <span>•</span> ' : ''}DRAG TO ORBIT <span>•</span> SHIFT / RIGHT DRAG TO PAN <span>•</span> WHEEL TO ZOOM` : state.scene.mode === 'crowd' ? state.scene.discoMode ? 'DISCO PAIRS FOLLOW EACH OTHER <span>•</span> CLICK TO BOUNCE' : 'MOVE TO DIRECT THEIR GAZE <span>•</span> CLICK TO BOUNCE <span>•</span> DRAG ☼ TO RELIGHT' : 'MOVE TO LOOK <span>•</span> CLICK TO BOUNCE <span>•</span> DRAG ☼ TO RELIGHT';
    dom.canvas.style.cursor = cameraMode ? 'grab' : 'crosshair';
    dom.canvas.setAttribute('aria-label', cameraMode ? 'Interactive crowd camera. Drag to orbit, Shift or right-drag to pan, and use the wheel to zoom.' : state.scene.mode === 'crowd' ? 'Interactive crowd of procedural pixel characters. Move the pointer to direct their gaze or click to bounce.' : 'Interactive procedural pixel character. Move the pointer to change its gaze, click it to bounce, or drag a light handle.');
  }

  function syncLightControls() {
    const light = state.lighting.lights[state.lighting.selected]; dom.lightEnabled.checked = light.enabled; dom.lightColor.value = light.color; dom.lightZ.value = String(light.z); dom.lightZNumber.value = String(roundTo(light.z, 1)); dom.lightZOutput.value = Number(light.z).toFixed(1); dom.lightZOutput.textContent = dom.lightZOutput.value; dom.lightIntensity.value = String(light.intensity); dom.lightIntensityOutput.value = Number(light.intensity).toFixed(2); dom.lightIntensityOutput.textContent = dom.lightIntensityOutput.value; updateRangeVisual(dom.lightZ); updateRangeVisual(dom.lightIntensity);
  }
  function updateSpecPreview() { dom.specPreview.value = JSON.stringify(getSerializableSpec(), null, 2); dom.specPreview.removeAttribute('aria-invalid'); }
  function scheduleSpecPreview() { if (runtime.specPreviewPending) return; runtime.specPreviewPending = true; setTimeout(() => { runtime.specPreviewPending = false; updateSpecPreview(); }, 120); }
  function syncAllControls() { syncBoundControls(); syncButtons(); syncLightControls(); updateSpecPreview(); runtime.dirty = true; }
  function showToast(message) { clearTimeout(runtime.toastTimer); dom.toast.textContent = message; dom.toast.classList.add('is-visible'); runtime.toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2200); }
  function copyText(text) { if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text); const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); return Promise.resolve(); }
  function markInteraction() { runtime.interactionCount += 1; if (runtime.interactionCount > 2) dom.interactionHint.style.opacity = '0'; }

  function bindControls() {
    document.querySelectorAll('[data-path]').forEach((element) => {
      const eventName = element.dataset.path === 'scene.crowdSize' || element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
      element.addEventListener(eventName, () => { const oldValue = getByPath(state, element.dataset.path); let value; if (element.type === 'checkbox') value = element.checked; else if (typeof oldValue === 'number') value = Number(element.value); else value = element.value; setByPath(state, element.dataset.path, value); if (element.dataset.path === 'scene.discoMode' && value) { state.render.targetFps = 240; state.lighting.colored = true; } if (element.dataset.path === 'palette.base' || element.dataset.path === 'palette.grayscale') runtime.paletteKey = ''; if (element.type === 'range') updateRangeVisual(element); syncBoundControls(); syncButtons(); updateSpecPreview(); runtime.dirty = true; markInteraction(); });
    });
    document.querySelectorAll('[data-scene-mode]').forEach((button) => button.addEventListener('click', () => { state.scene.mode = button.dataset.sceneMode; runtime.lookX = 0; runtime.lookY = 0; runtime.dirty = true; syncButtons(); updateSpecPreview(); markInteraction(); }));
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => { state.render.mode = button.dataset.mode; syncButtons(); updateSpecPreview(); runtime.dirty = true; markInteraction(); }));
    document.querySelectorAll('[data-expression]').forEach((button) => button.addEventListener('click', () => { state.face.expression = button.dataset.expression; syncButtons(); updateSpecPreview(); runtime.dirty = true; markInteraction(); }));
    document.querySelectorAll('[data-palette]').forEach((button) => button.addEventListener('click', () => { state.palette.base = button.dataset.palette; state.palette.grayscale = false; runtime.paletteKey = ''; syncAllControls(); markInteraction(); }));
    document.querySelectorAll('[data-light-index]').forEach((button) => button.addEventListener('click', () => { state.lighting.selected = Number(button.dataset.lightIndex); syncButtons(); syncLightControls(); lightPad.render(); runtime.dirty = true; }));
    dom.lightEnabled.addEventListener('change', () => { state.lighting.lights[state.lighting.selected].enabled = dom.lightEnabled.checked; lightPad.render(); runtime.dirty = true; updateSpecPreview(); });
    dom.lightColor.addEventListener('input', () => { state.lighting.lights[state.lighting.selected].color = dom.lightColor.value; lightPad.render(); runtime.dirty = true; updateSpecPreview(); });
    dom.lightZ.addEventListener('input', () => { const value = Number(dom.lightZ.value); state.lighting.lights[state.lighting.selected].z = value; dom.lightZNumber.value = String(roundTo(value, 1)); syncLightControls(); runtime.dirty = true; updateSpecPreview(); });
    dom.lightZNumber.addEventListener('input', () => { const value = clamp(Number(dom.lightZNumber.value), -1, 5); if (!Number.isFinite(value)) return; state.lighting.lights[state.lighting.selected].z = value; syncLightControls(); runtime.dirty = true; updateSpecPreview(); });
    dom.lightIntensity.addEventListener('input', () => { state.lighting.lights[state.lighting.selected].intensity = Number(dom.lightIntensity.value); syncLightControls(); runtime.dirty = true; updateSpecPreview(); });
    dom.pauseButton.addEventListener('click', () => { runtime.paused = !runtime.paused; runtime.lastTime = performance.now(); runtime.dirty = true; syncButtons(); });
    dom.gizmoButton.addEventListener('click', () => { state.lighting.showGizmos = !state.lighting.showGizmos; runtime.dirty = true; syncButtons(); updateSpecPreview(); });
    dom.resetButton.addEventListener('click', () => { state = clone(DEFAULT_STATE); runtime.expression = clone(EXPRESSIONS[state.face.expression]); runtime.lookX = 0; runtime.lookY = 0; runtime.lookTargetX = 0; runtime.lookTargetY = 0; runtime.paletteKey = ''; syncAllControls(); showToast('Character reset'); });
    dom.randomizeButton.addEventListener('click', () => { state.seed = Math.floor(1000 + Math.random() * 999998999); randomizeFromSeed(state.seed); });
    dom.shuffleCrowdButton.addEventListener('click', () => { state.seed = Math.floor(1000 + Math.random() * 999998999); runtime.crowdKey = ''; runtime.danceKey = ''; dom.seedInput.value = String(state.seed); updateSpecPreview(); runtime.bounceVelocity += 1.2; runtime.dirty = true; showToast(`Crowd shuffled · seed ${state.seed}`); });
    dom.resetCameraButton.addEventListener('click', () => { state.scene.cameraYaw = 0; state.scene.cameraPitch = .55; state.scene.cameraDistance = 27; state.scene.cameraTargetX = 0; state.scene.cameraTargetZ = 0; runtime.dirty = true; updateSpecPreview(); showToast('Camera reset'); });
    dom.generateSeedButton.addEventListener('click', () => { const seed = clamp(Math.floor(Number(dom.seedInput.value) || 1), 1, 999999999); state.seed = seed; randomizeFromSeed(seed); });
    dom.seedInput.addEventListener('change', () => { state.seed = clamp(Math.floor(Number(dom.seedInput.value) || 1), 1, 999999999); updateSpecPreview(); });
    dom.copySpecButton.addEventListener('click', () => copyText(JSON.stringify(getSerializableSpec(), null, 2)).then(() => showToast('Character specification copied')));
    dom.importSpecButton.addEventListener('click', () => importSpecText(dom.specPreview.value, 'Pasted JSON'));
    dom.specFileInput.addEventListener('change', async () => { const file = dom.specFileInput.files?.[0]; if (!file) return; try { const text = await file.text(); dom.specPreview.value = text; importSpecText(text, file.name); } catch (error) { showToast(`Import failed · ${error.message}`); } finally { dom.specFileInput.value = ''; } });
    dom.exportButton.addEventListener('click', () => renderer.exportPng());
    dom.canvas.addEventListener('pointerdown', (event) => {
      const lightIndex = renderer.lightAtPointer(event.clientX, event.clientY); if (lightIndex >= 0) { runtime.draggingLight = lightIndex; state.lighting.selected = lightIndex; dom.canvas.setPointerCapture(event.pointerId); syncButtons(); syncLightControls(); markInteraction(); return; }
      if (state.scene.mode === 'crowd' && state.scene.cameraMotion) { event.preventDefault(); runtime.cameraDragging = event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'orbit'; runtime.cameraPointerX = event.clientX; runtime.cameraPointerY = event.clientY; dom.canvas.setPointerCapture(event.pointerId); dom.canvas.style.cursor = 'grabbing'; markInteraction(); return; }
      if (event.button === 0) { runtime.bounceVelocity += 2.15; runtime.dirty = true; markInteraction(); }
    });
    dom.canvas.addEventListener('pointermove', (event) => {
      if (runtime.draggingLight >= 0) { renderer.updateLightFromStagePointer(runtime.draggingLight, event.clientX, event.clientY); return; }
      const rect = dom.canvas.getBoundingClientRect(); runtime.pointerInside = true;
      runtime.lookTargetX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1); runtime.lookTargetY = clamp(1 - ((event.clientY - rect.top) / rect.height) * 2, -1, 1); dom.canvas.style.cursor = renderer.lightAtPointer(event.clientX, event.clientY) >= 0 ? 'grab' : 'crosshair';
      if (runtime.cameraDragging) { const dx = (event.clientX - runtime.cameraPointerX) / rect.width, dy = (event.clientY - runtime.cameraPointerY) / rect.height; runtime.cameraPointerX = event.clientX; runtime.cameraPointerY = event.clientY; if (runtime.cameraDragging === 'orbit') { state.scene.cameraYaw += dx * 3.2; state.scene.cameraPitch = clamp(state.scene.cameraPitch + dy * 1.8, .14, 1.35); } else { const camera = renderer.currentCrowdCamera || renderer.getCrowdCamera(), groundForwardLength = Math.hypot(camera.forward.x, camera.forward.z) || 1, sensitivity = state.scene.cameraDistance * 1.05; state.scene.cameraTargetX -= dx * sensitivity * camera.right.x + dy * sensitivity * camera.forward.x / groundForwardLength; state.scene.cameraTargetZ -= dx * sensitivity * camera.right.z + dy * sensitivity * camera.forward.z / groundForwardLength; state.scene.cameraTargetX = clamp(state.scene.cameraTargetX, -CROWD_FLOOR_HALF, CROWD_FLOOR_HALF); state.scene.cameraTargetZ = clamp(state.scene.cameraTargetZ, -CROWD_FLOOR_HALF, CROWD_FLOOR_HALF); } runtime.dirty = true; scheduleSpecPreview(); return; }
      if (state.scene.mode === 'crowd' && state.scene.cameraMotion) { dom.canvas.style.cursor = 'grab'; return; }
    });
    dom.canvas.addEventListener('pointerenter', () => { runtime.pointerInside = true; });
    dom.canvas.addEventListener('pointerleave', () => { if (runtime.draggingLight < 0 && !runtime.cameraDragging) { runtime.pointerInside = false; runtime.lookTargetX = 0; runtime.lookTargetY = 0; } });
    const endCanvasDrag = (event) => { if ((runtime.draggingLight >= 0 || runtime.cameraDragging) && dom.canvas.hasPointerCapture(event.pointerId)) dom.canvas.releasePointerCapture(event.pointerId); runtime.draggingLight = -1; runtime.cameraDragging = ''; dom.canvas.style.cursor = state.scene.mode === 'crowd' && state.scene.cameraMotion ? 'grab' : 'crosshair'; };
    dom.canvas.addEventListener('pointerup', endCanvasDrag); dom.canvas.addEventListener('pointercancel', endCanvasDrag);
    dom.canvas.addEventListener('wheel', (event) => { if (state.scene.mode !== 'crowd' || !state.scene.cameraMotion) return; event.preventDefault(); state.scene.cameraDistance = clamp(state.scene.cameraDistance * Math.exp(event.deltaY * .0012), 7, 50); runtime.dirty = true; scheduleSpecPreview(); markInteraction(); }, { passive: false });
    dom.canvas.addEventListener('contextmenu', (event) => { if (state.scene.mode === 'crowd' && state.scene.cameraMotion) event.preventDefault(); });
    window.addEventListener('keydown', (event) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return; if (event.code === 'Space') { event.preventDefault(); runtime.bounceVelocity += 2.15; runtime.dirty = true; } else if (event.key.toLowerCase() === 'r') { state.seed = Math.floor(1000 + Math.random() * 999998999); randomizeFromSeed(state.seed); } else if (['1', '2', '3', '4'].includes(event.key)) { state.render.mode = ['pixel', 'toon', 'smooth', 'normals'][Number(event.key) - 1]; syncButtons(); updateSpecPreview(); runtime.dirty = true; } });
    const observer = new ResizeObserver(() => renderer.resizeDisplay()); observer.observe(dom.stageWrap);
  }

  function randomizeFromSeed(seed) {
    const random = mulberry32(hashSeed(seed)), choice = (array) => array[Math.floor(random() * array.length)], paletteChoices = ['#7658e8', '#ef8b36', '#47c98b', '#ef5f89', '#39a7ff', '#f0d65b', '#8b79ff', '#35d5d0'], shape = choice(['sphere', 'roundedBox', 'cuboid', 'capsule']); state.body.shape = shape;
    if (shape === 'sphere') { const base = lerp(1.35, 1.8, random()); state.body.width = roundTo(base * lerp(0.86, 1.13, random())); state.body.height = roundTo(base * lerp(0.88, 1.18, random())); state.body.depth = roundTo(base * lerp(0.78, 1.05, random())); state.body.roundness = 0.28; }
    else if (shape === 'capsule') { const width = lerp(1.1, 1.62, random()); state.body.width = roundTo(width); state.body.depth = roundTo(width * lerp(0.84, 1.02, random())); state.body.height = roundTo(lerp(width * 1.05, 2.05, random())); state.body.roundness = 0.35; }
    else { state.body.width = roundTo(lerp(1.1, 1.92, random())); state.body.height = roundTo(shape === 'cuboid' ? lerp(1.0, 2.05, random()) : lerp(1.2, 1.92, random())); state.body.depth = roundTo(lerp(0.9, 1.68, random())); state.body.roundness = roundTo(shape === 'cuboid' ? lerp(0.04, 0.24, random()) : lerp(0.18, 0.46, random())); }
    state.palette.base = choice(paletteChoices); state.palette.grayscale = false; state.face.expression = choice(Object.keys(EXPRESSIONS)); state.face.bodyTurn = roundTo(lerp(0.42, 0.92, random())); state.face.faceSlide = roundTo(lerp(0.5, 0.94, random())); state.face.pupilTravel = roundTo(lerp(0.62, 1, random())); state.face.gazeSpring = roundTo(lerp(6, 14, random()), 1); state.motion.idle = roundTo(lerp(0.35, 0.95, random())); state.render.bands = Math.floor(lerp(4, 8, random())); state.render.outline = roundTo(lerp(0.56, 0.95, random())); state.render.dither = random() > 0.22;
    state.lighting.lights[0].x = roundTo(lerp(-1.8, -0.45, random())); state.lighting.lights[0].y = roundTo(lerp(0.75, 1.9, random())); state.lighting.lights[0].z = roundTo(lerp(1.9, 3.8, random())); state.lighting.lights[0].intensity = roundTo(lerp(0.9, 1.55, random())); state.lighting.lights[1].x = roundTo(lerp(0.65, 2, random())); state.lighting.lights[1].y = roundTo(lerp(-0.4, 1, random())); state.lighting.lights[1].intensity = roundTo(lerp(0.25, 0.72, random())); state.lighting.lights[2].x = roundTo(lerp(-0.5, 1.7, random())); state.lighting.lights[2].y = roundTo(lerp(0.7, 2.1, random())); state.lighting.ambient = roundTo(lerp(0.16, 0.34, random())); runtime.paletteKey = ''; runtime.bounceVelocity += 1.4; syncAllControls(); showToast(`Generated seed ${seed}`);
  }

  function updateRuntime(now, dt) {
    const time = now / 1000; if (!state.face.followPointer || !runtime.pointerInside) { runtime.lookTargetX = 0; runtime.lookTargetY = 0; }
    runtime.lookX = damp(runtime.lookX, runtime.lookTargetX, state.face.gazeSpring, dt); runtime.lookY = damp(runtime.lookY, runtime.lookTargetY, state.face.gazeSpring, dt);
    const targetExpression = EXPRESSIONS[state.face.expression] || EXPRESSIONS.neutral; Object.keys(runtime.expression).forEach((key) => { runtime.expression[key] = damp(runtime.expression[key], targetExpression[key], 10.5, dt); });
    runtime.bounceVelocity += -19 * runtime.bounce * dt; runtime.bounceVelocity *= Math.exp(-5.4 * dt); runtime.bounce += runtime.bounceVelocity * dt;
    if (runtime.bounce < 0) { runtime.bounce = 0; if (runtime.bounceVelocity < -0.08) runtime.bounceVelocity *= -0.28; else runtime.bounceVelocity = 0; } runtime.bounce = clamp(runtime.bounce, 0, 1.25);
    if (state.face.autoBlink) { if (time >= runtime.nextBlink && time - runtime.blinkStart > 0.25) { runtime.blinkStart = time; runtime.nextBlink = time + lerp(2.2, 5.4, Math.random()) * (state.face.expression === 'sleepy' ? 0.58 : 1); } const progress = (time - runtime.blinkStart) / (state.face.expression === 'sleepy' ? 0.28 : 0.17); runtime.blinkAmount = progress >= 0 && progress <= 1 ? Math.sin(progress * Math.PI) : 0; } else runtime.blinkAmount = damp(runtime.blinkAmount, 0, 18, dt);
    runtime.dirty = true;
  }

  function updateReadouts(now) {
    runtime.framesThisSecond += 1; if (now - runtime.fpsWindowStart >= 1000) { runtime.measuredFps = Math.round(runtime.framesThisSecond * 1000 / (now - runtime.fpsWindowStart)); runtime.framesThisSecond = 0; runtime.fpsWindowStart = now; }
    if (now - runtime.lastReadout < 200) return; runtime.lastReadout = now;
    const size = state.scene.mode === 'crowd' ? Number(state.render.resolution) : runtime.currentRenderSize; dom.resolutionReadout.textContent = state.scene.mode === 'crowd' ? `${size} × ${size} / KIN` : `${size} × ${size}`; dom.fpsReadout.textContent = `${runtime.measuredFps || state.render.targetFps} FPS`; dom.renderTimeReadout.textContent = `${runtime.renderTime.toFixed(1)} MS`; dom.engineStatus.textContent = runtime.renderTime > 30 ? 'SHADER LOAD HIGH' : state.scene.mode === 'crowd' && renderer.crowdGL?.available ? 'WEBGL MESH PIPELINE ONLINE' : 'SOFTWARE SHADER ONLINE';
  }

  let running = true;
  let raf = 0;

  function animationLoop(now) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0, (now - runtime.lastTime) / 1000)); runtime.lastTime = now; if (!runtime.paused) updateRuntime(now, dt);
    const interval = 1000 / Math.max(1, Number(state.render.targetFps)); if (runtime.dirty && now - runtime.lastRender >= interval - 0.5) { runtime.lastRender = now; runtime.renderTime = renderer.render(now / 1000); updateReadouts(now); runtime.dirty = !runtime.paused; }
    raf = requestAnimationFrame(animationLoop);
  }

  function bindAvatarCanvas() {
    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      runtime.pointerInside = true;
      runtime.lookTargetX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      runtime.lookTargetY = clamp(1 - ((event.clientY - rect.top) / rect.height) * 2, -1, 1);
    };
    const onLeave = () => { runtime.pointerInside = false; runtime.lookTargetX = 0; runtime.lookTargetY = 0; };
    const onDown = (event) => { if (event.button === 0) { runtime.bounceVelocity += 2.15; runtime.dirty = true; } };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerenter', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    const observer = new ResizeObserver(() => renderer.resizeDisplay());
    observer.observe(canvas.parentElement || canvas);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerenter', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      observer.disconnect();
    };
  }

  const unbind = bindAvatarCanvas();
  state.scene.mode = 'solo';
  state.lighting.showGizmos = false;
  syncAllControls();
  buildPalette();
  renderer.render(performance.now() / 1000);
  raf = requestAnimationFrame(animationLoop);

  function notify() {
    if (typeof onChange === 'function') onChange(getSerializableSpec());
  }

  return {
    expressions: Object.keys(EXPRESSIONS),
    palettes: ['#7658e8', '#ef8b36', '#47c98b', '#ef5f89', '#39a7ff', '#f0d65b', '#8b79ff', '#35d5d0'],
    shapes: ['sphere', 'roundedBox', 'cuboid', 'capsule'],
    getSpec() { return getSerializableSpec(); },
    getState() { return clone(state); },
    applySpec(spec) {
      state = normaliseImportedSpec(spec);
      state.scene.mode = 'solo';
      state.lighting.showGizmos = false;
      runtime.expression = clone(EXPRESSIONS[state.face.expression] || EXPRESSIONS.happy);
      runtime.paletteKey = '';
      runtime.dirty = true;
      syncAllControls();
      notify();
    },
    randomize() {
      state.seed = Math.floor(1000 + Math.random() * 999998999);
      randomizeFromSeed(state.seed);
      state.scene.mode = 'solo';
      state.lighting.showGizmos = false;
      notify();
    },
    reset() {
      state = clone(DEFAULT_STATE);
      state.scene.mode = 'solo';
      state.lighting.showGizmos = false;
      runtime.expression = clone(EXPRESSIONS[state.face.expression]);
      runtime.lookX = 0; runtime.lookY = 0; runtime.lookTargetX = 0; runtime.lookTargetY = 0;
      runtime.paletteKey = '';
      runtime.dirty = true;
      syncAllControls();
      notify();
    },
    setShape(shape) {
      state.body.shape = shape;
      runtime.dirty = true;
      notify();
    },
    setPalette(hex) {
      state.palette.base = hex;
      state.palette.grayscale = false;
      runtime.paletteKey = '';
      runtime.dirty = true;
      notify();
    },
    setExpression(name) {
      state.face.expression = name;
      runtime.dirty = true;
      notify();
    },
    capturePng(size = 128) {
      renderer.render(performance.now() / 1000);
      const output = document.createElement('canvas');
      output.width = size;
      output.height = size;
      const context = output.getContext('2d');
      if (!context) return canvas.toDataURL('image/png');
      context.imageSmoothingEnabled = false;
      const source = renderer.lastFrame || canvas;
      context.drawImage(source, 0, 0, size, size);
      return output.toDataURL('image/png');
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      unbind();
    },
  };

}
