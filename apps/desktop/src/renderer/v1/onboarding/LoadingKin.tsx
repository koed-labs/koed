import { useEffect, useRef, useState } from "react";
import {
  CrowdGLRenderer,
  EXPRESSIONS,
  KIN_DEFAULTS,
  clone,
  kinMember
} from "../pixelkin/vendor/index.js";
import { KinSpin } from "./kin-spin.js";
import { kinStageSize, kinStageSurface } from "../pixelkin/presentation.js";
import { createHappyJoyCycle, onboardingSkins } from "./kin-presentation.js";

type Props = {
  initialized?: boolean;
  complete: boolean;
  stage: number;
  midpointReached: boolean;
  sad?: boolean;
};
const TAU = Math.PI * 2;
const TAKEOFF = 0.16;
const AIR_TIME = 0.92;
const LANDING = TAKEOFF + AIR_TIME;
const CELEBRATION_DURATION = 1.5;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => {
  const t = clamp(n);
  return t * t * (3 - 2 * t);
};

const differentIndex = (current: number, length: number) =>
  (current + 1 + Math.floor(Math.random() * (length - 1))) % length;

// Choreography follows the retained prototype. Rendering and expressions come
// exclusively from the engine vendored on this branch.
export function LoadingKin({
  initialized = true,
  complete,
  stage,
  midpointReached,
  sad = false
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const suppressClick = useRef(false);
  const settings = useRef({
    initialized,
    complete,
    stage,
    midpointReached,
    sad
  });
  const kick = useRef(false);
  const wake = useRef(() => {});
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    settings.current = { initialized, complete, stage, midpointReached, sad };
    wake.current();
  }, [initialized, complete, stage, midpointReached, sad]);

  useEffect(() => {
    let dispose = () => {};
    try {
      if (!host.current || typeof WebGL2RenderingContext === "undefined")
        throw new Error("WebGL2 unavailable");
      const renderer = new CrowdGLRenderer();
      if (!renderer.available) throw new Error("WebGL2 unavailable");
      const element = host.current;
      const canvas = renderer.canvas;
      canvas.setAttribute("aria-hidden", "true");
      element.appendChild(canvas);
      let skinIndex = 0;
      const member = {
        ...kinMember(clone(KIN_DEFAULTS)),
        ...onboardingSkins[skinIndex],
        expression: "happy",
        expressionFrom: "happy" as string | Record<string, number>,
        expressionTo: "happy" as string | Record<string, number>,
        expressionProgress: 0,
        gazeBlink: 0
      };
      element.dataset.kinSkin = String(member.seed);
      const randomizeLook = () => {
        skinIndex = differentIndex(skinIndex, onboardingSkins.length);
        Object.assign(member, onboardingSkins[skinIndex]);
        element.dataset.kinSkin = String(member.seed);
      };
      const dragSpin = new KinSpin();
      let displayedYaw = -0.14;
      let idleSince = 0;
      let pointer: number | null = null;
      const happyCycle = createHappyJoyCycle(72);
      // Raised inner brows make the failed connection read as concern.
      const sadExpression = {
        ...EXPRESSIONS.sad,
        browLift: 0.12,
        browTilt: -0.65
      };
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      let reduced = media.matches;
      let frame = 0;
      let contextLost = false;
      let clock = 0;
      let previousTime = 0;
      let lastPaint = 0;
      let burstAt: number | null = null;
      let pendingCelebrations = 0;
      let changeOnLanding = false;
      let spinning = false;
      let midpointHopPlayed = false;
      let lastInitialized = settings.current.initialized;
      let lastStage = settings.current.stage;
      let lastComplete = settings.current.complete;
      let width = Math.max(1, element.clientWidth);
      let height = Math.max(1, element.clientHeight);

      function render(now: number) {
        frame = 0;
        if (document.hidden || contextLost) {
          previousTime = 0;
          return;
        }
        const state = settings.current;
        if (state.sad) cancelDrag();
        // Initial inspection is a baseline, not six freshly completed stages.
        if (!lastInitialized || !state.initialized) {
          lastStage = state.stage;
          lastComplete = state.complete;
        }
        lastInitialized = state.initialized;
        const elapsed = previousTime
          ? Math.max(0, (now - previousTime) / 1000)
          : 0;
        const dt = Math.min(elapsed, 0.05);
        const wasSpinning = dragSpin.active;
        dragSpin.step(dt, reduced, now);
        if (pointer !== null && !dragSpin.dragging) {
          const id = pointer;
          pointer = null;
          control.dataset.dragging = "false";
          suppressClick.current = true;
          if (control.hasPointerCapture(id)) control.releasePointerCapture(id);
        }
        if (wasSpinning && !dragSpin.active) idleSince = clock;
        if (!reduced) clock += dt;
        previousTime = now;
        if (state.stage !== lastStage || (lastComplete && !state.complete))
          midpointHopPlayed = false;
        // Each completed stage earns one jump-and-spin; preview restarts do not.
        if (state.stage < lastStage || (lastComplete && !state.complete)) {
          pendingCelebrations = 0;
          burstAt = null;
          changeOnLanding = false;
        } else {
          pendingCelebrations += Math.max(0, state.stage - lastStage);
          if (state.complete && !lastComplete) pendingCelebrations += 1;
        }
        lastStage = state.stage;
        lastComplete = state.complete;
        if (kick.current) {
          pendingCelebrations += 1;
          kick.current = false;
        }
        if (state.sad) pendingCelebrations = 0;
        if (reduced) {
          // Same milestone feedback, without waiting for an animation that is disabled.
          if (pendingCelebrations || changeOnLanding) randomizeLook();
          pendingCelebrations = 0;
          changeOnLanding = false;
          burstAt = null;
          if (state.midpointReached) midpointHopPlayed = true;
        } else {
          if (burstAt !== null && clock - burstAt >= CELEBRATION_DURATION)
            burstAt = null;
          if (!dragSpin.active && burstAt === null && pendingCelebrations > 0) {
            pendingCelebrations -= 1;
            burstAt = clock;
            changeOnLanding = true;
            spinning = true;
          } else if (
            !dragSpin.active &&
            burstAt === null &&
            state.midpointReached &&
            !midpointHopPlayed &&
            !state.complete
          ) {
            // One plain hop at halfway; finish any active trick before starting it.
            burstAt = clock;
            midpointHopPlayed = true;
            spinning = false;
            changeOnLanding = false;
          }
        }
        // 30 fps is plenty for one little companion during an installation.
        if (now - lastPaint >= (dragSpin.active ? 16 : 32)) {
          lastPaint = now;
          const celebrating = burstAt !== null;
          element.dataset.kinAnimating = String(
            celebrating || pendingCelebrations > 0 || dragSpin.active
          );
          const jumpTime = burstAt === null ? -1 : clock - burstAt;
          const air = clamp((jumpTime - TAKEOFF) / AIR_TIME);
          if (changeOnLanding && jumpTime >= LANDING) {
            randomizeLook();
            changeOnLanding = false;
          }
          const jump = jumpTime < 0 || reduced ? 0 : 4 * air * (1 - air);
          const squash =
            jumpTime < 0 || reduced
              ? 0
              : 0.13 * Math.exp(-Math.pow((jumpTime - 0.12) / 0.08, 2)) +
                0.16 * Math.exp(-Math.pow((jumpTime - 1.12) / 0.12, 2));
          const breathe = reduced ? 0 : Math.sin(clock * 2.4) * 0.015;
          const scaleY = 1 + jump * 0.12 - squash + breathe;
          const scaleXZ = 1 / Math.sqrt(scaleY);
          element.style.setProperty(
            "--kin-shadow-scale",
            String(1 - jump * 0.3)
          );
          element.style.setProperty(
            "--kin-shadow-opacity",
            String(0.3 - jump * 0.15)
          );
          const spin =
            !reduced && celebrating && spinning ? TAU * ease(air) : 0;
          const blend = happyCycle(clock);
          member.expressionFrom = state.sad
            ? sadExpression
            : celebrating || state.complete
              ? "joy"
              : blend.from;
          member.expressionTo = state.sad
            ? sadExpression
            : celebrating || state.complete
              ? "joy"
              : blend.to;
          member.browThickness = state.sad
            ? 0.9
            : onboardingSkins[skinIndex]!.browThickness;
          member.expressionProgress = blend.progress;
          if (dragSpin.startled > 0) {
            // Blend a wide-eyed, worried face back to the current mood.
            member.expressionFrom = {
              ...EXPRESSIONS.surprised,
              browLift: 0.5,
              browTilt: -0.5
            };
            member.expressionProgress = 1 - Math.min(1, dragSpin.startled * 2);
          }
          element.dataset.kinMood =
            dragSpin.startled > 0.1 ? "startled" : state.sad ? "sad" : "happy";
          member.gazeBlink = reduced
            ? 0
            : Math.exp(-Math.pow((((clock + 1.1) % 4.7) - 4.4) / 0.075, 2));
          // Face the camera between tricks, with a small curious head turn.
          const yaw = dragSpin.active
            ? dragSpin.angle
            : reduced
              ? -0.14
              : -0.14 + Math.sin((clock - idleSince) * 0.9) * 0.16 + spin;
          displayedYaw = yaw;
          element.dataset.kinYaw = String(yaw);
          const position = { x: 0, y: 2.7, z: 7.4 };
          const target = { x: 0, y: 1.25, z: 0 };
          const length = Math.hypot(
            target.y - position.y,
            target.z - position.z
          );
          const forward = {
            x: 0,
            y: (target.y - position.y) / length,
            z: (target.z - position.z) / length
          };
          renderer.render({
            ...kinStageSize(width, height),
            pixelStep: 1,
            camera: {
              position,
              target,
              forward,
              right: { x: 1, y: 0, z: 0 },
              up: { x: 0, y: -forward.z, z: forward.y },
              fov: 0.4,
              aspect: width / height
            },
            objects: [
              {
                member,
                x: 0,
                y: member.body.height * 0.5 * scaleY + jump * 0.6,
                z: 0,
                yaw,
                pitch: 0,
                roll: reduced ? 0 : Math.sin(clock * 1.1) * 0.025,
                gaze: [0, 0.05],
                scaleX: scaleXZ,
                scaleY,
                scaleZ: scaleXZ
              }
            ],
            ...kinStageSurface(),
            time: reduced ? 0 : clock
          });
        }
        if (!reduced || dragSpin.active || dragSpin.startled > 0)
          frame = requestAnimationFrame(render);
      }
      const requestFrame = () => {
        if (!frame && !contextLost) {
          lastPaint = 0;
          frame = requestAnimationFrame(render);
        }
      };
      const control = button.current!;
      const onDown = (event: PointerEvent) => {
        if (
          contextLost ||
          event.button !== 0 ||
          !event.isPrimary ||
          pointer !== null
        )
          return;
        pointer = event.pointerId;
        suppressClick.current = false;
        dragSpin.begin(event.clientX, event.timeStamp, width, displayedYaw);
        // Grabbing interrupts a trick at its currently displayed angle.
        burstAt = null;
        changeOnLanding = false;
        control.setPointerCapture(event.pointerId);
        control.dataset.dragging = "true";
        requestFrame();
      };
      const onMove = (event: PointerEvent) => {
        if (pointer !== event.pointerId) return;
        dragSpin.move(event.clientX, event.timeStamp);
        if (dragSpin.moved) suppressClick.current = true;
        requestFrame();
      };
      const onEnd = (event: PointerEvent) => {
        if (pointer !== event.pointerId) return;
        const cancelled = event.type !== "pointerup";
        dragSpin.end(event.timeStamp, reduced, cancelled);
        pointer = null;
        control.dataset.dragging = "false";
        if (cancelled) suppressClick.current = true;
        if (control.hasPointerCapture(event.pointerId))
          control.releasePointerCapture(event.pointerId);
        requestFrame();
      };
      const cancelDrag = () => {
        if (pointer === null) return;
        const id = pointer;
        pointer = null;
        dragSpin.end(performance.now(), reduced, true);
        control.dataset.dragging = "false";
        suppressClick.current = true;
        if (control.hasPointerCapture(id)) control.releasePointerCapture(id);
      };
      control.addEventListener("pointerdown", onDown);
      control.addEventListener("pointermove", onMove);
      control.addEventListener("pointerup", onEnd);
      control.addEventListener("pointercancel", onEnd);
      control.addEventListener("lostpointercapture", onEnd);
      wake.current = requestFrame;
      const onVisibility = () => {
        if (document.hidden) cancelDrag();
        cancelAnimationFrame(frame);
        frame = 0;
        previousTime = 0;
        if (!document.hidden) requestFrame();
      };
      const onMotion = () => {
        reduced = media.matches;
        requestFrame();
      };
      const resize = new ResizeObserver(() => {
        width = Math.max(1, element.clientWidth);
        height = Math.max(1, element.clientHeight);
        requestFrame();
      });
      resize.observe(element);
      media.addEventListener("change", onMotion);
      document.addEventListener("visibilitychange", onVisibility);
      const onContextLost = () => {
        contextLost = true;
        cancelAnimationFrame(frame);
        frame = 0;
        wake.current = () => {};
        setStatus("fallback");
      };
      canvas.addEventListener("webglcontextlost", onContextLost);
      requestFrame();
      setStatus("ready");
      dispose = () => {
        wake.current = () => {};
        control.removeEventListener("pointerdown", onDown);
        control.removeEventListener("pointermove", onMove);
        control.removeEventListener("pointerup", onEnd);
        control.removeEventListener("pointercancel", onEnd);
        control.removeEventListener("lostpointercapture", onEnd);
        canvas.removeEventListener("webglcontextlost", onContextLost);
        cancelAnimationFrame(frame);
        resize.disconnect();
        media.removeEventListener("change", onMotion);
        document.removeEventListener("visibilitychange", onVisibility);
        renderer.gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      };
    } catch {
      setStatus("fallback");
    }
    return () => {
      dispose();
    };
  }, []);

  return (
    <button
      ref={button}
      type="button"
      className="lp-kin-button"
      disabled={sad}
      aria-label={
        sad
          ? "Kin is sad. Let’s try again."
          : "Click Kin to jump, or drag to spin"
      }
      onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false;
          return;
        }
        kick.current = true;
        wake.current();
      }}
    >
      <div
        ref={host}
        className="lp-kin-scene"
        data-kin-state={status}
        data-kin-mood={sad ? "sad" : "happy"}
      >
        {status !== "ready" && (
          <span className="lp-kin-fallback" aria-hidden="true">
            <i />
            <i />
            <b />
          </span>
        )}
      </div>
    </button>
  );
}
