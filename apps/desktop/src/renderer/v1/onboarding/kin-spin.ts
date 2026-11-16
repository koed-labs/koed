const TAU = Math.PI * 2;
export const KIN_SPIN_FRONT = -0.14;
const FRONT = KIN_SPIN_FRONT;
const limit = (value: number, max: number) =>
  Math.max(-max, Math.min(max, value));
// Fastest spin a flick can impart, in radians per second.
const MAX_VELOCITY = 36;
// Release velocity is averaged over this window so one late event can't kill it.
const VELOCITY_WINDOW_MS = 80;
// Seconds of release velocity a thrown Kin coasts through before it stops.
const COAST = 0.75;
// The coast eases out as (1 - t)^GLIDE_POWER, so it starts at release velocity.
const GLIDE_POWER = 3;
// Longer glides feel stuck; let the spring handle slow releases instead.
const MAX_GLIDE_SECONDS = 3;

/** Direct pointer tracking, then an interruptible inertial coast to the front. */
export class KinSpin {
  angle = FRONT;
  velocity = 0;
  active = false;
  dragging = false;
  startled = 0;
  moved = false;
  #x = 0;
  #startX = 0;
  #activityX = 0;
  #activityTime = 0;
  #time = 0;
  #target = FRONT;
  #scale = 0;
  #idle = 0;
  #shake = 0;
  #shouldShake = false;
  #samples: { x: number; time: number }[] = [];
  #glide: { distance: number; duration: number; elapsed: number } | null = null;

  begin(x: number, time: number, width: number, displayedAngle: number) {
    this.angle = displayedAngle;
    this.velocity = 0;
    this.active = this.dragging = true;
    this.moved = false;
    this.#idle = this.#shake = 0;
    this.#shouldShake = false;
    this.#glide = null;
    this.#samples = [{ x, time }];
    this.#x = this.#startX = this.#activityX = x;
    this.#time = this.#activityTime = time;
    this.#scale = TAU / Math.max(160, width);
  }

  move(x: number, time: number) {
    if (!this.dragging) return;
    if (x !== this.#activityX) {
      this.#idle = 0;
      this.#activityX = x;
      this.#activityTime = time;
    }
    if (!this.moved && Math.abs(x - this.#startX) < 6) return;
    this.moved = true;
    const delta = (x - this.#x) * this.#scale;
    const dt = Math.max(8, time - this.#time) / 1000;
    this.angle += delta;
    if (Math.abs(delta / dt) > 7) this.startled = 1;
    const samples = this.#samples;
    samples.push({ x, time });
    while (samples.length > 2 && time - samples[0]!.time > VELOCITY_WINDOW_MS)
      samples.shift();
    const oldest = samples[0]!;
    this.velocity = limit(
      ((x - oldest.x) * this.#scale) / (Math.max(8, time - oldest.time) / 1000),
      MAX_VELOCITY
    );
    this.#x = x;
    this.#time = time;
  }

  end(time: number, reduced: boolean, cancelled = false) {
    if (!this.dragging) return;
    this.dragging = false;
    if (time - this.#time > 100 || cancelled) this.velocity = 0;
    if (!this.moved || reduced || cancelled) {
      this.active = false;
      this.velocity = 0;
      this.angle = FRONT;
      if (reduced) this.startled = 0;
      return;
    }
    const nearestFront = Math.round((this.angle - FRONT) / TAU) * TAU + FRONT;
    this.#shouldShake =
      Math.abs(this.angle - nearestFront) > Math.PI / 2 + 1e-9;
    // A throw coasts on its own momentum, easing to rest on a front-facing
    // turn. Starting the ease at the release velocity keeps the hand-off smooth.
    const coast =
      Math.round((this.angle + this.velocity * COAST - FRONT) / TAU) * TAU +
      FRONT;
    const distance = coast - this.angle;
    const duration = (GLIDE_POWER * distance) / this.velocity;
    if (
      distance * this.velocity > 0 &&
      Math.abs(distance) >= 1 &&
      duration <= MAX_GLIDE_SECONDS
    ) {
      this.#target = coast;
      this.#glide = {
        distance,
        duration,
        elapsed: 0
      };
      return;
    }
    // Too slow to carry a turn: spring to the front the release leans toward.
    this.#target =
      Math.round((this.angle + this.velocity * 0.22 - FRONT) / TAU) * TAU +
      FRONT;
  }

  #settle() {
    this.angle = FRONT;
    this.velocity = 0;
    this.#glide = null;
    if (this.#shouldShake) {
      this.#shouldShake = false;
      this.#shake = 0.5;
    } else {
      this.active = false;
    }
  }

  step(dt: number, reduced: boolean, now?: number) {
    this.startled = reduced ? 0 : Math.max(0, this.startled - dt * 0.65);
    if (this.dragging) {
      this.#idle =
        now === undefined
          ? this.#idle + Math.max(0, dt)
          : Math.max(0, (now - this.#activityTime) / 1000);
      if (this.#idle >= 2) this.end(this.#time + 2000, reduced);
      else return;
    }
    if (!this.active) return;
    if (reduced) {
      this.active = false;
      this.angle = FRONT;
      this.velocity = 0;
      return;
    }
    if (this.#shake > 0) {
      this.#shake = Math.max(0, this.#shake - dt);
      this.angle =
        FRONT + Math.sin(this.#shake * 32) * 0.08 * (this.#shake / 0.5);
      if (!this.#shake) this.active = false;
      return;
    }
    const glide = this.#glide;
    if (glide) {
      glide.elapsed += Math.min(Math.max(0, dt), 0.05);
      const left = Math.max(0, 1 - glide.elapsed / glide.duration);
      this.angle = this.#target - glide.distance * left ** GLIDE_POWER;
      this.velocity =
        ((GLIDE_POWER * glide.distance) / glide.duration) *
        left ** (GLIDE_POWER - 1);
      if (!left) this.#settle();
      return;
    }
    // Small substeps keep the spring stable after a dropped frame.
    for (let remaining = Math.min(dt, 0.05); remaining > 0;) {
      const step = Math.min(remaining, 1 / 120);
      this.velocity +=
        ((this.#target - this.angle) * 100 - this.velocity * 19) * step;
      this.angle += this.velocity * step;
      remaining -= step;
    }
    if (
      Math.abs(this.#target - this.angle) < 0.002 &&
      Math.abs(this.velocity) < 0.02
    )
      this.#settle();
  }
}
