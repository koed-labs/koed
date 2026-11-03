import { useEffect, useRef } from "react";

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  ax: number;
  ay: number;
  az: number;
  wx: number;
  wy: number;
  wz: number;
  age: number;
  life: number;
  color: string;
};
export function OnboardingConfetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current,
      hero = canvas?.closest("[data-confetti-container]");
    if (!canvas || !hero) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let width = 1,
      height = 1,
      frame = 0,
      last = 0,
      clock = 0,
      visible = true;
    let pieces: Piece[] = [];
    let nextLeft = 0.05,
      nextRight = 0.9;
    const colors = [
      "#ffe02b",
      "#ff6a00",
      "#7858ff",
      "#0de9e2",
      "#ff3875",
      "#b8ff00"
    ];
    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
    };
    const burst = (side: number) => {
      const count = width < 700 ? 10 : 18;
      const sizeScale = Math.max(0.55, Math.min(1, width / 1280));
      const originY = -20; // Launch 24px above the previous origin, behind the header.
      for (let i = 0; i < count; i++) {
        const speed =
          Math.min(width * 0.3, 300) * (0.35 + Math.random() * 1.15) * 2.6;
        const angle = ((10 + Math.random() * 70) * Math.PI) / 180;
        pieces.push({
          x: width * 0.5 + side * Math.min(width * 0.5 + 6, 560),
          y: originY + Math.random() * 12,
          vx: -side * speed * Math.cos(angle),
          vy: speed * Math.sin(angle),
          size: (5 + Math.random() * 4) * 1.3 * sizeScale,
          ax: Math.random() * 6.28,
          ay: Math.random() * 6.28,
          az: Math.random() * 6.28,
          wx: (Math.random() - 0.5) * 12,
          wy: (Math.random() - 0.5) * 14,
          wz: (Math.random() - 0.5) * 8,
          age: 0,
          life: 3.5 + Math.random(),
          color: colors[i % colors.length]!
        });
      }
    };
    const render = (now: number) => {
      frame = 0;
      if (
        media.matches ||
        !visible ||
        document.hidden ||
        !hero.classList.contains("confetti-active")
      ) {
        last = 0;
        return;
      }
      const dt = last ? Math.min((now - last) / 1000, 0.035) : 0;
      last = now;
      clock += dt;
      if (clock >= nextLeft) {
        burst(-1);
        nextLeft = clock + 1.5 + Math.random() * 0.5;
      }
      if (clock >= nextRight) {
        burst(1);
        nextRight = clock + 1.7 + Math.random() * 0.5;
      }
      ctx.clearRect(0, 0, width, height);
      pieces = pieces.filter((p) => p.age < p.life && p.y < height * 0.8 + 64);
      for (const p of pieces) {
        p.age += dt;
        // Air drag slows the burst into a light paper-like fall.
        const airDrag = 1 - Math.exp(-3 * dt);
        p.vx *= Math.exp(-1.15 * dt);
        p.vy += (200 - p.vy) * airDrag;
        const flutter =
          Math.sin(p.age * 4 + p.ax) * 14 * (1 - Math.exp(-p.age * 3));
        p.x += (p.vx + flutter) * dt;
        p.y += p.vy * dt;
        p.ax += p.wx * dt;
        p.ay += p.wy * dt;
        p.az += p.wz * dt;
        const cx = Math.cos(p.ax),
          sx = Math.sin(p.ax),
          cy = Math.cos(p.ay),
          sy = Math.sin(p.ay),
          cz = Math.cos(p.az),
          sz = Math.sin(p.az);
        ctx.globalAlpha = Math.min(
          1,
          p.age / 0.05,
          Math.max(0, (p.life - p.age) / 0.5),
          Math.max(0, (height * 0.8 + 64 - p.y) / (height * 0.18))
        );
        ctx.fillStyle = p.color;
        ctx.beginPath();
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1]
        ].forEach(([u, v], i) => {
          const x = (u! * p.size) / 2,
            y = (v! * p.size) / 2;
          const yy = y * cx,
            z = y * sx,
            xx = x * cy + z * sy,
            zz = -x * sy + z * cy;
          const projection = 180 / (180 + zz);
          const px = p.x + (xx * cz - yy * sz) * projection,
            py = p.y + (xx * sz + yy * cz) * projection;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(render);
    };
    const start = () => {
      if (
        !media.matches &&
        !frame &&
        visible &&
        !document.hidden &&
        hero.classList.contains("confetti-active")
      )
        frame = requestAnimationFrame(render);
    };
    const observer = new MutationObserver(start);
    observer.observe(hero, { attributes: true, attributeFilter: ["class"] });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (!visible) {
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      } else start();
    });
    intersection.observe(hero);
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    const motion = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      ctx.clearRect(0, 0, width, height);
      start();
    };
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", start);
    resize();
    start();
    return () => {
      media.removeEventListener("change", motion);
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      sizeObserver.disconnect();
      document.removeEventListener("visibilitychange", start);
    };
  }, []);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 6,
        pointerEvents: "none"
      }}
    />
  );
}
