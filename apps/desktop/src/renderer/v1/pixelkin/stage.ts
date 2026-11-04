import {
  CrowdGLRenderer,
  PixelkinPersonalities,
  kinMember,
  kinRestFrame,
  kinScene,
  setKinPose,
  type Kin,
  type KinMember
} from "./vendor/index.js";

// Every Pixelkin shares one WebGL2 renderer: the renderer draws each Kin in
// turn and the result is copied into that Kin's own 2D canvas. One context per
// avatar would exhaust Chromium's WebGL context limit on busy screens.
type Personality = InstanceType<typeof PixelkinPersonalities.Controller>;
export type PixelkinActor = {
  canvas: HTMLCanvasElement;
  size: number;
  visible: boolean;
  hopAt: number | null;
  gaze: [number, number];
  kin: Kin;
  member: KinMember;
  rest: ReturnType<typeof kinRestFrame>;
  personality: Personality;
  expression: string;
  // A screen-chosen mood (for example Home's states) overrides the personality.
  pinnedExpression: string | null;
  painted: number;
};

const TAU = Math.PI * 2;
const HOP = 1.1;
// The generator's pixel resolution; smaller Kin render with fewer pixels.
const MAX_PIXELS = 96;
// The lab's idle-motion strength.
const IDLE = 0.75;
const actors = new Set<PixelkinActor>();
let renderer: CrowdGLRenderer | null | undefined;
let frame = 0;
let previous = 0;
let lastPaint = 0;
let clock = 0;
let pointer: { x: number; y: number } | null = null;
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function engine(): CrowdGLRenderer | null {
  if (renderer !== undefined) return renderer;
  renderer = null;
  if (typeof WebGL2RenderingContext === "undefined") return null;
  try {
    const created = new CrowdGLRenderer();
    if (!created.available) return null;
    created.canvas.addEventListener("webglcontextlost", () => {
      // Recreate on the next frame; actors keep their last painted image.
      if (renderer === created) renderer = undefined;
    });
    renderer = created;
  } catch {
    renderer = null;
  }
  return renderer;
}

export const pixelkinEngineAvailable = () => engine() !== null;

const reduced = () => reducedMotion?.matches ?? false;

export function createPixelkinActor(
  canvas: HTMLCanvasElement,
  kin: Kin,
  size: number
): PixelkinActor {
  const actor = {
    canvas,
    size,
    visible: true,
    hopAt: null,
    gaze: [0, 0],
    pinnedExpression: null,
    painted: clock
  } as Partial<PixelkinActor> as PixelkinActor;
  setPixelkinKin(actor, kin);
  return actor;
}

export function setPixelkinKin(actor: PixelkinActor, kin: Kin) {
  actor.kin = kin;
  // A random phase keeps several Kin on one screen from blinking in unison.
  actor.member = kinMember(kin, { seed: kin.seed, phase: Math.random() * 3.6 });
  actor.rest = kinRestFrame(kin);
  actor.personality ??= new PixelkinPersonalities.Controller();
  actor.personality.select(kin.face.personality);
  actor.expression = actor.personality.update(0) ?? "neutral";
}

export function setPixelkinExpression(
  actor: PixelkinActor,
  expression: string | null
) {
  actor.pinnedExpression = expression;
  wakePixelkins();
}

function aim(actor: PixelkinActor): [number, number] {
  if (!pointer || reduced()) return [0, 0];
  const rect = actor.canvas.getBoundingClientRect();
  const dx = pointer.x - (rect.left + rect.width / 2),
    dy = pointer.y - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance < rect.width * 0.35) return [0, 0];
  // Screen Y grows downward; the renderer’s gaze and pitch use upward Y.
  return [dx / distance, Math.max(-1, Math.min(1, -dy / distance))];
}

function paint(actor: PixelkinActor, gl: CrowdGLRenderer) {
  const context = actor.canvas.getContext("2d");
  if (!context) return;
  const motion = !reduced();
  const t = motion ? clock : 0;
  if (motion) {
    const next = actor.personality.update(clock - actor.painted);
    if (next) actor.expression = next;
  }
  actor.painted = clock;
  const hop =
    actor.hopAt === null || !motion ? -1 : (clock - actor.hopAt) / HOP;
  if (hop >= 1) actor.hopAt = null;
  const air = hop < 0 || hop >= 1 ? 0 : hop;
  const jump = 4 * air * (1 - air);
  const [gx, gy] = aim(actor);
  actor.gaze[0] += (gx - actor.gaze[0]) * 0.25;
  actor.gaze[1] += (gy - actor.gaze[1]) * 0.25;
  const [lookX, lookY] = actor.gaze;
  // Breathing, sway and turn towards the pointer follow the lab's solo motion.
  const phase = t * 2.05 + actor.member.phase;
  const breathing = motion ? Math.sin(phase) * 0.025 * IDLE : 0;
  const scale = actor.rest.visualScale;
  setKinPose(actor.member, {
    expression: air > 0 ? "joy" : (actor.pinnedExpression ?? actor.expression),
    armSwing: motion ? Math.sin(phase) * 0.035 * IDLE : 0
  });
  // Without a fixed value the renderer blinks on its own.
  delete actor.member.gazeBlink;

  const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  const device = Math.round(actor.size * ratio);
  const zoom = Math.ceil(device / MAX_PIXELS);
  const pixels = Math.max(16, Math.round(device / zoom));
  gl.render(
    kinScene({
      width: pixels,
      height: pixels,
      time: t,
      objects: [
        {
          member: actor.member,
          x: 0,
          y:
            actor.rest.bodyY +
            ((motion ? Math.sin(phase) * 0.026 * IDLE : 0) + jump * 0.22) *
              scale,
          z: 0,
          yaw:
            lookX * 0.31 * 1.5 +
            (motion ? Math.sin(t * 0.66) * 0.025 * IDLE : 0) +
            TAU * air,
          pitch:
            -lookY * 0.19 * 1.5 +
            (motion ? Math.sin(t * 0.81 + 1.4) * 0.014 * IDLE : 0),
          roll:
            -lookX * 0.038 * 1.5 +
            (motion ? Math.sin(t * 1.13 + 0.6) * 0.012 * IDLE : 0),
          scaleX: scale * (1 + breathing * 0.52),
          scaleY: scale * (1 - breathing),
          scaleZ: scale * (1 + breathing * 0.34),
          glossy: actor.kin.body.shininess,
          gaze: [lookX, lookY]
        }
      ]
    })
  );
  // Whole-number enlargement keeps the pixel art crisp.
  const size = pixels * zoom;
  if (actor.canvas.width !== size) {
    actor.canvas.width = size;
    actor.canvas.height = size;
  } else context.clearRect(0, 0, size, size);
  context.imageSmoothingEnabled = false;
  context.drawImage(gl.canvas, 0, 0, pixels, pixels, 0, 0, size, size);
}

function tick(now: number) {
  frame = 0;
  if (document.hidden) {
    previous = 0;
    return;
  }
  if (previous && !reduced()) clock += Math.min((now - previous) / 1000, 0.05);
  previous = now;
  // 30 fps is plenty for small companions.
  if (now - lastPaint >= 32) {
    lastPaint = now;
    const gl = engine();
    if (gl)
      // Grouping by size avoids resizing the shared canvas between every Kin.
      [...actors]
        .filter((actor) => actor.visible)
        .sort((a, b) => a.size - b.size)
        .forEach((actor) => paint(actor, gl));
  }
  if (!reduced() && actors.size) frame = requestAnimationFrame(tick);
}

export function wakePixelkins() {
  if (frame || !actors.size) return;
  lastPaint = 0;
  frame = requestAnimationFrame(tick);
}

const onPointer = (event: PointerEvent) => {
  pointer = { x: event.clientX, y: event.clientY };
};
const onVisibility = () => {
  cancelAnimationFrame(frame);
  frame = 0;
  previous = 0;
  if (!document.hidden) wakePixelkins();
};

function start() {
  reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  reducedMotion?.addEventListener("change", wakePixelkins);
  observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          for (const entry of entries)
            for (const actor of actors)
              if (actor.canvas === entry.target)
                actor.visible = entry.isIntersecting;
          wakePixelkins();
        });
  window.addEventListener("pointermove", onPointer, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
}

function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
  previous = 0;
  reducedMotion?.removeEventListener("change", wakePixelkins);
  observer?.disconnect();
  observer = null;
  pointer = null;
  window.removeEventListener("pointermove", onPointer);
  document.removeEventListener("visibilitychange", onVisibility);
}

export function addPixelkin(actor: PixelkinActor) {
  if (!actors.size) start();
  actors.add(actor);
  observer?.observe(actor.canvas);
  wakePixelkins();
  return () => {
    actors.delete(actor);
    observer?.unobserve(actor.canvas);
    if (!actors.size) stop();
  };
}

export function hopPixelkin(actor: PixelkinActor) {
  if (!reduced()) actor.hopAt = clock;
  wakePixelkins();
}
