const TAU = Math.PI * 2;
export const KIN_SPIN_FRONT = -0.14;
const FRONT = KIN_SPIN_FRONT;
const limit = (value: number, max: number) =>
  Math.max(-max, Math.min(max, value));
// Fastest spin a flick can impart, in radians per second.
const MAX_VELOCITY = 36;
// Release velocity is averaged over this window so one late event can't kill it.
const VELOCITY_WINDOW_MS = 80;
// A hand slows and pauses before the button comes up, so the throw uses the
// fastest recent movement rather than the last, slowest event.
const RELEASE_LOOKBACK_MS = 160;
// Held still this long before release means no throw.
const STALE_MS = 160;
// A thrown Kin loses this fraction of its speed per second (exp decay).
const FRICTION = 1.4;
// Releases at least this fast coast; slower ones spring to the front.
const COAST_MIN = 5;
// The coast hands over to the spring once it slows below this.
const COAST_HANDOFF = 3.5;

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
  #coasting = false;
  #peaks: { time: number; v: number }[] = [];

  begin(x: number, time: number, width: number, displayedAngle: number) {
    this.angle = displayedAngle;
    this.velocity = 0;
    this.active = this.dragging = true;
    this.moved = false;
    this.#idle = this.#shake = 0;
    this.#shouldShake = false;
    this.#coasting = false;
    this.#peaks = [];
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
    this.#peaks.push({ time, v: this.velocity });
    while (this.#peaks[0] && time - this.#peaks[0].time > RELEASE_LOOKBACK_MS)
      this.#peaks.shift();
    this.#x = x;
    this.#time = time;
  }

  end(time: number, reduced: boolean, cancelled = false) {
    if (!this.dragging) return;
    this.dragging = false;
    if (time - this.#time > STALE_MS || cancelled) this.velocity = 0;
    else {
      const sign = Math.sign(this.velocity);
      let best = this.velocity;
      for (const { time: at, v } of this.#peaks)
        if (
          time - at <= RELEASE_LOOKBACK_MS &&
          Math.sign(v) === sign &&
          Math.abs(v) > Math.abs(best)
        )
          best = v;
      this.velocity = best;
    }
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
    // A throw coasts on its own momentum, slowing with friction, then the
    // spring takes over from that speed to land on a front-facing turn.
    if (Math.abs(this.velocity) >= COAST_MIN) {
      this.#coasting = true;
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
    this.#coasting = false;
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
    if (this.#coasting) {
      const frame = Math.min(Math.max(0, dt), 0.05);
      this.angle += this.velocity * frame;
      this.velocity *= Math.exp(-FRICTION * frame);
      if (Math.abs(this.velocity) > COAST_HANDOFF) return;
      // Spring to the front-facing turn nearest where friction would stop it.
      this.#target =
        Math.round((this.angle + this.velocity / FRICTION - FRONT) / TAU) *
          TAU +
        FRONT;
      this.#coasting = false;
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
