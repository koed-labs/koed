// Canonical Pixelkin specification, seeded generation, and face painter.
// A classic script keeps the offline edition dependency-free. Modules share the same API.
(() => {
  "use strict";
  if (globalThis.PixelkinCore) return;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const roundTo = (value, places = 2) => Number(value.toFixed(places));
  function hashSeed(seed) {
    let value = 2166136261 >>> 0;
    for (const character of String(seed)) {
      value ^= character.charCodeAt(0);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }
  function mulberry32(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }
  const EXPRESSIONS = {
    neutral: {
      leftEyeOpen: 1,
      rightEyeOpen: 1,
      eyeSmile: 0,
      eyeTilt: 0,
      browLift: 0,
      browTilt: 0,
      browAsym: 0,
      mouthCurve: 0.12,
      mouthOpen: 0,
      mouthWidth: 0.74,
      mouthRound: 0,
      mouthTilt: 0
    },
    happy: {
      leftEyeOpen: 0.88,
      rightEyeOpen: 0.88,
      eyeSmile: 0.18,
      eyeTilt: 0,
      browLift: 0.12,
      browTilt: 0.05,
      browAsym: 0,
      mouthCurve: 0.92,
      mouthOpen: 0.18,
      mouthWidth: 1,
      mouthRound: 0,
      mouthTilt: 0
    },
    joy: {
      leftEyeOpen: 0.18,
      rightEyeOpen: 0.18,
      eyeSmile: 1,
      eyeTilt: 0,
      browLift: 0.28,
      browTilt: 0.05,
      browAsym: 0,
      mouthCurve: 0.62,
      mouthOpen: 0.9,
      mouthWidth: 1.04,
      mouthRound: 0.18,
      mouthTilt: 0
    },
    sad: {
      leftEyeOpen: 0.78,
      rightEyeOpen: 0.78,
      eyeSmile: 0,
      eyeTilt: -0.08,
      browLift: 0.1,
      browTilt: -0.68,
      browAsym: 0,
      mouthCurve: -0.86,
      mouthOpen: 0.08,
      mouthWidth: 0.72,
      mouthRound: 0,
      mouthTilt: 0
    },
    angry: {
      leftEyeOpen: 0.63,
      rightEyeOpen: 0.63,
      eyeSmile: 0,
      eyeTilt: 0.12,
      browLift: -0.22,
      browTilt: 0.92,
      browAsym: 0,
      mouthCurve: -0.28,
      mouthOpen: 0.14,
      mouthWidth: 0.82,
      mouthRound: 0,
      mouthTilt: 0
    },
    surprised: {
      leftEyeOpen: 1.34,
      rightEyeOpen: 1.34,
      eyeSmile: 0,
      eyeTilt: 0,
      browLift: 0.82,
      browTilt: 0,
      browAsym: 0,
      mouthCurve: 0,
      mouthOpen: 1.05,
      mouthWidth: 0.52,
      mouthRound: 1,
      mouthTilt: 0
    },
    sleepy: {
      leftEyeOpen: 0.18,
      rightEyeOpen: 0.18,
      eyeSmile: 0.1,
      eyeTilt: -0.04,
      browLift: -0.25,
      browTilt: -0.1,
      browAsym: 0,
      mouthCurve: 0.04,
      mouthOpen: 0.08,
      mouthWidth: 0.62,
      mouthRound: 0.25,
      mouthTilt: 0
    },
    curious: {
      leftEyeOpen: 0.74,
      rightEyeOpen: 1.12,
      eyeSmile: 0,
      eyeTilt: 0.03,
      browLift: 0.18,
      browTilt: 0.1,
      browAsym: 0.72,
      mouthCurve: 0.18,
      mouthOpen: 0,
      mouthWidth: 0.62,
      mouthRound: 0,
      mouthTilt: 0.18
    },
    wink: {
      leftEyeOpen: 0.12,
      rightEyeOpen: 1.02,
      eyeSmile: 0.75,
      eyeTilt: 0,
      browLift: 0.1,
      browTilt: 0.08,
      browAsym: 0.18,
      mouthCurve: 0.76,
      mouthOpen: 0.05,
      mouthWidth: 0.86,
      mouthRound: 0,
      mouthTilt: -0.08
    }
  };
  const DEFAULT_STATE = {
    scene: {
      mode: "solo",
      crowdSize: 18,
      discoMode: false,
      discoSpeed: 1,
      cameraMotion: true,
      voxelGroup: 2,
      voxelCutoff: 0.04,
      cameraYaw: 0,
      cameraPitch: 0.55,
      cameraDistance: 27,
      cameraTargetX: 0,
      cameraTargetZ: 0
    },
    body: {
      shape: "roundedBox",
      width: 1.55,
      height: 1.72,
      depth: 1.32,
      roundness: 0.28
    },
    face: {
      expression: "happy",
      followPointer: true,
      autoBlink: true,
      bodyTurn: 0.7,
      faceSlide: 0.74,
      pupilTravel: 0.85,
      gazeSpring: 9
    },
    palette: { base: "#7658e8", grayscale: false },
    render: {
      mode: "pixel",
      resolution: 96,
      targetFps: 30,
      bands: 5,
      outline: 0.76,
      dither: true,
      background: "studio",
      groundShadow: true
    },
    motion: { idle: 0.65 },
    lighting: {
      ambient: 0.22,
      colored: false,
      orbitSelected: false,
      showGizmos: true,
      selected: 0,
      lights: [
        {
          name: "Key",
          enabled: true,
          x: -1.25,
          y: 1.36,
          z: 2.8,
          intensity: 1.15,
          color: "#fff0c2"
        },
        {
          name: "Fill",
          enabled: true,
          x: 1.45,
          y: 0.28,
          z: 2.15,
          intensity: 0.48,
          color: "#8bdcff"
        },
        {
          name: "Rim",
          enabled: true,
          x: 0.55,
          y: 1.5,
          z: -0.25,
          intensity: 0.72,
          color: "#d69cff"
        }
      ]
    },
    seed: 4812
  };

  function generate(seed, template = DEFAULT_STATE) {
    const state = clone(template);
    state.seed = seed;
    const random = mulberry32(hashSeed(seed)),
      choice = (array) => array[Math.floor(random() * array.length)],
      paletteChoices = [
        "#7658e8",
        "#ef8b36",
        "#47c98b",
        "#ef5f89",
        "#39a7ff",
        "#f0d65b",
        "#8b79ff",
        "#35d5d0"
      ],
      shape = choice(["sphere", "roundedBox", "cuboid", "capsule"]);
    state.body.shape = shape;
    if (shape === "sphere") {
      const base = lerp(1.35, 1.8, random());
      state.body.width = roundTo(base * lerp(0.86, 1.13, random()));
      state.body.height = roundTo(base * lerp(0.88, 1.18, random()));
      state.body.depth = roundTo(base * lerp(0.78, 1.05, random()));
      state.body.roundness = 0.28;
    } else if (shape === "capsule") {
      const width = lerp(1.1, 1.62, random());
      state.body.width = roundTo(width);
      state.body.depth = roundTo(width * lerp(0.84, 1.02, random()));
      state.body.height = roundTo(lerp(width * 1.05, 2.05, random()));
      state.body.roundness = 0.35;
    } else {
      state.body.width = roundTo(lerp(1.1, 1.92, random()));
      state.body.height = roundTo(
        shape === "cuboid"
          ? lerp(1.0, 2.05, random())
          : lerp(1.2, 1.92, random())
      );
      state.body.depth = roundTo(lerp(0.9, 1.68, random()));
      state.body.roundness = roundTo(
        shape === "cuboid"
          ? lerp(0.04, 0.24, random())
          : lerp(0.18, 0.46, random())
      );
    }
    state.palette.base = choice(paletteChoices);
    state.palette.grayscale = false;
    state.face.expression = choice(Object.keys(EXPRESSIONS));
    state.face.bodyTurn = roundTo(lerp(0.42, 0.92, random()));
    state.face.faceSlide = roundTo(lerp(0.5, 0.94, random()));
    state.face.pupilTravel = roundTo(lerp(0.62, 1, random()));
    state.face.gazeSpring = roundTo(lerp(6, 14, random()), 1);
    state.motion.idle = roundTo(lerp(0.35, 0.95, random()));
    state.render.bands = Math.floor(lerp(4, 8, random()));
    state.render.outline = roundTo(lerp(0.56, 0.95, random()));
    state.render.dither = random() > 0.22;
    state.lighting.lights[0].x = roundTo(lerp(-1.8, -0.45, random()));
    state.lighting.lights[0].y = roundTo(lerp(0.75, 1.9, random()));
    state.lighting.lights[0].z = roundTo(lerp(1.9, 3.8, random()));
    state.lighting.lights[0].intensity = roundTo(lerp(0.9, 1.55, random()));
    state.lighting.lights[1].x = roundTo(lerp(0.65, 2, random()));
    state.lighting.lights[1].y = roundTo(lerp(-0.4, 1, random()));
    state.lighting.lights[1].intensity = roundTo(lerp(0.25, 0.72, random()));
    state.lighting.lights[2].x = roundTo(lerp(-0.5, 1.7, random()));
    state.lighting.lights[2].y = roundTo(lerp(0.7, 2.1, random()));
    state.lighting.ambient = roundTo(lerp(0.16, 0.34, random()));
    return state;
  }

  function paintFace(renderer, state, runtime, frame, VIEW_SCALE = 1.68) {
    if (state.render.mode === "normals") return;
    const pixelScale = renderer.width / 96,
      bodyPixelsWide = (frame.width * renderer.width) / (VIEW_SCALE * 2),
      bodyPixelsHigh = (frame.height * renderer.height) / (VIEW_SCALE * 2),
      unit = Math.max(2.1, Math.min(bodyPixelsWide, bodyPixelsHigh) * 0.104);
    const worldFaceX =
        runtime.lookX * frame.width * 0.084 * state.face.faceSlide +
        Math.sin(frame.yaw) * frame.width * 0.045,
      worldFaceY =
        frame.bodyY +
        frame.height * 0.045 +
        runtime.lookY * frame.height * 0.06 * state.face.faceSlide;
    const centerX = (worldFaceX / VIEW_SCALE + 1) * renderer.width * 0.5,
      centerY = (1 - (worldFaceY / VIEW_SCALE + 1) * 0.5) * renderer.height,
      compression = clamp(Math.cos(frame.yaw) * 1.015, 0.76, 1);
    const eyeSpacing = unit * 1.42 * compression,
      eyeY = centerY - unit * 0.72,
      mouthY = centerY + unit * 1.1,
      expression = runtime.expression;
    const darkOffset = 8 * 3,
      midOffset = 78 * 3,
      lightOffset = 242 * 3;
    const dark = [
        runtime.paletteLut[darkOffset],
        runtime.paletteLut[darkOffset + 1],
        runtime.paletteLut[darkOffset + 2]
      ],
      mid = [
        runtime.paletteLut[midOffset],
        runtime.paletteLut[midOffset + 1],
        runtime.paletteLut[midOffset + 2]
      ],
      light = [
        runtime.paletteLut[lightOffset],
        runtime.paletteLut[lightOffset + 1],
        runtime.paletteLut[lightOffset + 2]
      ],
      white = state.palette.grayscale ? light : [245, 247, 251];
    const pupilTravelX = runtime.lookX * unit * 0.36 * state.face.pupilTravel,
      pupilTravelY = -runtime.lookY * unit * 0.25 * state.face.pupilTravel,
      blink = runtime.blinkAmount;
    const leftOpen = clamp(expression.leftEyeOpen * (1 - blink), 0.03, 1.5),
      rightOpen = clamp(expression.rightEyeOpen * (1 - blink), 0.03, 1.5),
      eyeRadiusX = unit * 0.52 * compression,
      browY = eyeY - unit - expression.browLift * unit * 0.44,
      lineThickness = Math.max(1, 1.2 * pixelScale);
    const drawEye = (eyeX, openness, isLeft) => {
      const smileEye = expression.eyeSmile > 0.58 || openness < 0.22,
        asymSmile = state.face.expression === "wink" && isLeft;
      if (smileEye || asymSmile) {
        renderer.drawArc(
          eyeX,
          eyeY + unit * 0.12,
          eyeRadiusX * 0.88,
          unit * (expression.eyeSmile > 0.5 ? 0.54 : 0.24),
          Math.PI * 1.08,
          Math.PI * 1.92,
          lineThickness * 1.22,
          dark
        );
        return;
      }
      const eyeRadiusY = Math.max(0.7, unit * 0.66 * openness);
      renderer.drawEllipse(
        eyeX,
        eyeY,
        eyeRadiusX + lineThickness * 0.65,
        eyeRadiusY + lineThickness * 0.65,
        dark
      );
      renderer.drawEllipse(
        eyeX,
        eyeY,
        Math.max(0.55, eyeRadiusX - lineThickness * 0.48),
        Math.max(0.55, eyeRadiusY - lineThickness * 0.48),
        white
      );
      const pupilX =
          eyeX + clamp(pupilTravelX, -eyeRadiusX * 0.44, eyeRadiusX * 0.44),
        pupilY =
          eyeY + clamp(pupilTravelY, -eyeRadiusY * 0.36, eyeRadiusY * 0.36),
        pupilRadius = Math.max(0.75, unit * 0.24);
      renderer.drawDisc(
        pupilX,
        pupilY,
        pupilRadius,
        runtime.pupilColour || dark
      );
      renderer.drawDisc(
        pupilX - pupilRadius * 0.32,
        pupilY - pupilRadius * 0.34,
        Math.max(0.45, pupilRadius * 0.27),
        light
      );
    };
    drawEye(centerX - eyeSpacing, leftOpen, true);
    drawEye(centerX + eyeSpacing, rightOpen, false);
    const browHalf = unit * 0.72 * compression,
      browTilt = expression.browTilt * unit * 0.48,
      browAsym = expression.browAsym * unit * 0.36;
    renderer.drawLine(
      centerX - eyeSpacing - browHalf,
      browY - browTilt - browAsym,
      centerX - eyeSpacing + browHalf,
      browY + browTilt - browAsym,
      lineThickness,
      dark
    );
    renderer.drawLine(
      centerX + eyeSpacing - browHalf,
      browY + browTilt + browAsym,
      centerX + eyeSpacing + browHalf,
      browY - browTilt + browAsym,
      lineThickness,
      dark
    );
    const mouthWidth = unit * 2.0 * expression.mouthWidth * compression,
      mouthTilt = expression.mouthTilt * unit;
    if (expression.mouthRound > 0.62) {
      const rx = Math.max(unit * 0.46, mouthWidth * 0.42),
        ry = unit * (0.42 + expression.mouthOpen * 0.58);
      renderer.drawEllipse(centerX, mouthY, rx, ry, dark);
      renderer.drawEllipse(
        centerX - rx * 0.22,
        mouthY - ry * 0.28,
        Math.max(0.45, rx * 0.15),
        Math.max(0.4, ry * 0.11),
        mid,
        0.65
      );
    } else if (expression.mouthOpen > 0.18) {
      const rx = mouthWidth * 0.56,
        ry = unit * (0.33 + expression.mouthOpen * 0.57);
      renderer.drawEllipse(centerX, mouthY, rx, ry, dark);
      if (expression.mouthCurve > 0.25)
        renderer.drawEllipse(
          centerX,
          mouthY + ry * 0.52,
          rx * 0.58,
          ry * 0.3,
          state.palette.grayscale ? mid : [224, 102, 133],
          0.9
        );
      renderer.drawArc(
        centerX,
        mouthY - ry * 0.08,
        rx * 0.72,
        ry * 0.52,
        Math.PI * 1.08,
        Math.PI * 1.92,
        Math.max(0.8, lineThickness * 0.72),
        light,
        0.72
      );
    } else {
      const leftX = centerX - mouthWidth * 0.5,
        rightX = centerX + mouthWidth * 0.5;
      renderer.drawQuadratic(
        leftX,
        mouthY - mouthTilt,
        centerX,
        mouthY + expression.mouthCurve * unit * 1.06,
        rightX,
        mouthY + mouthTilt,
        lineThickness * 1.08,
        dark
      );
    }
    if (
      (state.face.expression === "happy" || state.face.expression === "joy") &&
      !state.palette.grayscale
    ) {
      renderer.drawEllipse(
        centerX - eyeSpacing * 1.58,
        mouthY - unit * 0.16,
        unit * 0.42,
        unit * 0.19,
        [239, 103, 143],
        0.24
      );
      renderer.drawEllipse(
        centerX + eyeSpacing * 1.58,
        mouthY - unit * 0.16,
        unit * 0.42,
        unit * 0.19,
        [239, 103, 143],
        0.24
      );
    }
  }

  class FaceRaster {
    constructor(size = 160) {
      this.width = this.height = size;
      this.data = new Uint8ClampedArray(size * size * 4);
      this.mask = new Uint8Array(size * size).fill(1);
      this.materialOnly = true;
      this.paletteLut = new Uint8ClampedArray(256 * 3);
      this.colourKey = "";
    }
    paint(
      spec,
      { expression, lookX = 0, lookY = 0, blink = 0, ink, pupilColour } = {}
    ) {
      if (
        this.colourKey !==
        spec.palette.base + Boolean(spec.palette.grayscale)
      ) {
        buildFacePalette(
          this.paletteLut,
          spec.palette.base,
          spec.palette.grayscale
        );
        this.colourKey = spec.palette.base + Boolean(spec.palette.grayscale);
      }
      const palette = ink ? this.paletteLut.slice() : this.paletteLut;
      if (ink) palette.set(ink, 24);
      this.data.fill(0);
      paintFace(
        this,
        spec,
        {
          lookX,
          lookY,
          blinkAmount: blink,
          expression:
            expression ||
            EXPRESSIONS[spec.face.expression] ||
            EXPRESSIONS.neutral,
          paletteLut: palette,
          pupilColour
        },
        { width: spec.body.width, height: spec.body.height, bodyY: 0, yaw: 0 }
      );
      return {
        pixels: this.data,
        width: this.width,
        height: this.height,
        extent: 1.68
      };
    }
    setPixel(x, y, colour, alpha = 1, clipToBody = true) {
      const ix = Math.round(x),
        iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return;
      const index = iy * this.width + ix;
      if (clipToBody && !this.mask[index]) return;
      const offset = index * 4;
      if (this.materialOnly) {
        const destinationAlpha = this.data[offset + 3] / 255,
          outputAlpha = alpha + destinationAlpha * (1 - alpha);
        if (outputAlpha > 0) {
          this.data[offset] = Math.round(
            (colour[0] * alpha +
              this.data[offset] * destinationAlpha * (1 - alpha)) /
              outputAlpha
          );
          this.data[offset + 1] = Math.round(
            (colour[1] * alpha +
              this.data[offset + 1] * destinationAlpha * (1 - alpha)) /
              outputAlpha
          );
          this.data[offset + 2] = Math.round(
            (colour[2] * alpha +
              this.data[offset + 2] * destinationAlpha * (1 - alpha)) /
              outputAlpha
          );
        }
        this.data[offset + 3] = Math.round(outputAlpha * 255);
        return;
      }
      if (alpha >= 0.999) {
        this.data[offset] = colour[0];
        this.data[offset + 1] = colour[1];
        this.data[offset + 2] = colour[2];
      } else {
        this.data[offset] = Math.round(
          lerp(this.data[offset], colour[0], alpha)
        );
        this.data[offset + 1] = Math.round(
          lerp(this.data[offset + 1], colour[1], alpha)
        );
        this.data[offset + 2] = Math.round(
          lerp(this.data[offset + 2], colour[2], alpha)
        );
      }
      this.data[offset + 3] = 255;
    }

    drawDisc(cx, cy, radius, colour, alpha = 1, clipToBody = true) {
      const minX = Math.floor(cx - radius - 1),
        maxX = Math.ceil(cx + radius + 1),
        minY = Math.floor(cy - radius - 1),
        maxY = Math.ceil(cy + radius + 1),
        radiusSquared = radius * radius;
      for (let y = minY; y <= maxY; y += 1)
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x - cx,
            dy = y - cy;
          if (dx * dx + dy * dy <= radiusSquared)
            this.setPixel(x, y, colour, alpha, clipToBody);
        }
    }

    drawEllipse(cx, cy, rx, ry, colour, alpha = 1, clipToBody = true) {
      rx = Math.max(0.45, rx);
      ry = Math.max(0.45, ry);
      const minX = Math.floor(cx - rx - 1),
        maxX = Math.ceil(cx + rx + 1),
        minY = Math.floor(cy - ry - 1),
        maxY = Math.ceil(cy + ry + 1),
        invX = 1 / (rx * rx),
        invY = 1 / (ry * ry);
      for (let y = minY; y <= maxY; y += 1)
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x - cx,
            dy = y - cy;
          if (dx * dx * invX + dy * dy * invY <= 1)
            this.setPixel(x, y, colour, alpha, clipToBody);
        }
    }

    drawLine(x0, y0, x1, y1, thickness, colour, alpha = 1, clipToBody = true) {
      const distance = Math.hypot(x1 - x0, y1 - y0),
        steps = Math.max(1, Math.ceil(distance * 1.6)),
        radius = Math.max(0.55, thickness * 0.5);
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        this.drawDisc(
          lerp(x0, x1, t),
          lerp(y0, y1, t),
          radius,
          colour,
          alpha,
          clipToBody
        );
      }
    }

    drawQuadratic(
      x0,
      y0,
      cx,
      cy,
      x1,
      y1,
      thickness,
      colour,
      alpha = 1,
      clipToBody = true
    ) {
      let previousX = x0,
        previousY = y0;
      const segments = Math.max(
        8,
        Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.2)
      );
      for (let segment = 1; segment <= segments; segment += 1) {
        const t = segment / segments,
          inverse = 1 - t,
          x = inverse * inverse * x0 + 2 * inverse * t * cx + t * t * x1,
          y = inverse * inverse * y0 + 2 * inverse * t * cy + t * t * y1;
        this.drawLine(
          previousX,
          previousY,
          x,
          y,
          thickness,
          colour,
          alpha,
          clipToBody
        );
        previousX = x;
        previousY = y;
      }
    }

    drawArc(
      cx,
      cy,
      rx,
      ry,
      start,
      end,
      thickness,
      colour,
      alpha = 1,
      clipToBody = true
    ) {
      const segments = Math.max(
        8,
        Math.ceil(Math.abs(end - start) * Math.max(rx, ry) * 1.3)
      );
      let previousX = cx + Math.cos(start) * rx,
        previousY = cy + Math.sin(start) * ry;
      for (let segment = 1; segment <= segments; segment += 1) {
        const angle = lerp(start, end, segment / segments),
          x = cx + Math.cos(angle) * rx,
          y = cy + Math.sin(angle) * ry;
        this.drawLine(
          previousX,
          previousY,
          x,
          y,
          thickness,
          colour,
          alpha,
          clipToBody
        );
        previousX = x;
        previousY = y;
      }
    }
  }
  function buildFacePalette(lut, hex, grayscale = false) {
    const n = parseInt(hex.slice(1), 16),
      r = ((n >> 16) & 255) / 255,
      g = ((n >> 8) & 255) / 255,
      b = (n & 255) / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      delta = max - min,
      l = (max + min) / 2;
    const saturation = delta ? delta / (1 - Math.abs(2 * l - 1)) : 0;
    let hue = delta
      ? (max === r
          ? (g - b) / delta
          : max === g
            ? (b - r) / delta + 2
            : (r - g) / delta + 4) / 6
      : 0;
    if (hue < 0) hue += 1;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      if (grayscale) {
        const v = Math.round(255 * (0.035 + 0.93 * Math.pow(t, 0.86)));
        lut.set([v, v, v], i * 3);
        continue;
      }
      const h = hue + lerp(-0.025, 0.014, t),
        s = clamp(saturation * (1.05 - 0.22 * t) + 0.08, 0, 1),
        light = 0.045 + 0.91 * Math.pow(t, 0.88);
      const a = s * Math.min(light, 1 - light);
      const channel = (k) => {
        k = (k + h * 12) % 12;
        if (k < 0) k += 12;
        return Math.round(
          255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
        );
      };
      lut.set([channel(0), channel(8), channel(4)], i * 3);
    }
  }
  function bodyRadius(body) {
    const limit = Math.min(body.width, body.height, body.depth) * 0.5;
    const radius = clamp(body.roundness, 0.015, limit - 0.01);
    return body.shape === "cuboid"
      ? Math.min(radius * 0.32 + 0.025, limit - 0.005)
      : radius;
  }
  function bodyDistance(body, x, y, z) {
    const bx = body.width * 0.5,
      by = body.height * 0.5,
      bz = body.depth * 0.5;
    if (body.shape === "sphere")
      return (Math.hypot(x / bx, y / by, z / bz) - 1) * Math.min(bx, by, bz);
    if (body.shape === "capsule")
      return (
        Math.hypot(
          x,
          y -
            clamp(
              y,
              -Math.max(0, by - Math.min(bx, bz)),
              Math.max(0, by - Math.min(bx, bz))
            ),
          z
        ) - Math.min(bx, bz)
      );
    const radius = bodyRadius(body),
      qx = Math.abs(x) - Math.max(0.005, bx - radius),
      qy = Math.abs(y) - Math.max(0.005, by - radius),
      qz = Math.abs(z) - Math.max(0.005, bz - radius);
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
      Math.min(Math.max(qx, qy, qz), 0) -
      radius
    );
  }
  globalThis.PixelkinCore = Object.freeze({
    EXPRESSIONS,
    DEFAULT_STATE,
    generate,
    paintFace,
    FaceRaster,
    bodyRadius,
    bodyDistance,
    hashSeed
  });
})();
