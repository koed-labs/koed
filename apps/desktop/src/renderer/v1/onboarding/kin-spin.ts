const TAU = Math.PI * 2;
export const KIN_SPIN_FRONT = -0.14;
const FRONT = KIN_SPIN_FRONT;
const limit = (value: number, max: number) =>
  Math.max(-max, Math.min(max, value));

/** Direct pointer tracking, followed by an interruptible return to the front. */
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

  begin(x: number, time: number, width: number, displayedAngle: number) {
    this.angle = displayedAngle;
    this.velocity = 0;
    this.active = this.dragging = true;
    this.moved = false;
    this.#idle = this.#shake = 0;
    this.#shouldShake = false;
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
    this.velocity = limit(delta / dt, 18);
    if (Math.abs(this.velocity) > 7) this.startled = 1;
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
    // Project in the release direction so a quick flick can complete a turn.
    this.#target =
      Math.round((this.angle + this.velocity * 0.22 - FRONT) / TAU) * TAU +
      FRONT;
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
    ) {
      this.angle = FRONT;
      this.velocity = 0;
      if (this.#shouldShake) {
        this.#shouldShake = false;
        this.#shake = 0.5;
      } else {
        this.active = false;
      }
    }
  }
}
