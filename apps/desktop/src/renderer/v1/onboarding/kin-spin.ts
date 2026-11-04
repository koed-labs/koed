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
  #time = 0;
  #target = FRONT;
  #scale = 0;

  begin(x: number, time: number, width: number, displayedAngle: number) {
    this.angle = displayedAngle;
    this.velocity = 0;
    this.active = this.dragging = true;
    this.moved = false;
    this.#x = this.#startX = x;
    this.#time = time;
    this.#scale = TAU / Math.max(160, width);
  }

  move(x: number, time: number) {
    if (!this.dragging) return;
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
      return;
    }
    // Project in the release direction so a quick flick can complete a turn.
    this.#target =
      Math.round((this.angle + this.velocity * 0.22 - FRONT) / TAU) * TAU +
      FRONT;
  }

  step(dt: number, reduced: boolean) {
    this.startled = Math.max(0, this.startled - dt * 0.65);
    if (!this.active || this.dragging) return;
    if (reduced) {
      this.active = false;
      this.angle = FRONT;
      this.velocity = 0;
      return;
    }
    // Small substeps keep the spring stable after a dropped frame.
    for (let remaining = Math.min(dt, 0.05); remaining > 0; ) {
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
      this.active = false;
    }
  }
}
