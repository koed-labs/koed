"use client";

import { useLayoutEffect, useRef } from "react";
import { Bot } from "lucide-react";
import { createPixelkinSession, type PixelkinSession } from "@/lib/pixelkin/engine";

const SIZE_CLASS = {
  sm: "h-5 w-5",
  md: "h-8 w-8",
  lg: "h-12 w-12",
  xl: "h-20 w-20",
} as const;

const RADIUS_CLASS = {
  sm: "rounded-md",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
} as const;

const ICON_CLASS = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
  lg: "h-3.5 w-3.5",
  xl: "h-7 w-7",
} as const;

// The pixelkin engine frames its character like a small 3D scene, with a lot
// of headroom/floor space around it - great for the avatar editor, but it
// means the figure only fills a fraction of the square canvas everywhere
// else. Scaling the rendered canvas/image up inside a same-size,
// overflow-hidden box crops that margin away so the character reads as a
// proper avatar instead of a speck floating in a box.
const AVATAR_ZOOM = 1.6;

export function AgentAvatarView({
  image,
  spec,
  name,
  size = "md",
  className = "",
}: {
  image?: string;
  // The agent's redrawable pixel-avatar config. When present, this renders
  // the live, still-animating engine (idle blink, gaze, bounce) instead of
  // the frozen PNG snapshot in `image` - the same "liveness" the avatar
  // editor itself has, just without the edit controls.
  spec?: Record<string, unknown>;
  name: string;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}) {
  const box = SIZE_CLASS[size];
  const radius = RADIUS_CLASS[size];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PixelkinSession | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec) return undefined;
    const session = createPixelkinSession(canvas);
    sessionRef.current = session;
    session.applySpec(spec);
    return () => {
      session.destroy();
      sessionRef.current = null;
    };
  }, [spec]);

  if (spec) {
    return (
      <span
        className={`${box} ${radius} relative inline-block flex-shrink-0 overflow-hidden border border-border bg-background ${className}`}
      >
        <canvas
          ref={canvasRef}
          aria-label={`${name} avatar`}
          className="absolute inset-0 h-full w-full cursor-crosshair"
          style={{ imageRendering: "pixelated", transform: `scale(${AVATAR_ZOOM})`, transformOrigin: "50% 50%" }}
        />
      </span>
    );
  }
  if (image) {
    return (
      <span
        className={`${box} ${radius} relative inline-block flex-shrink-0 overflow-hidden border border-border bg-background ${className}`}
      >
        <img
          src={image}
          alt={`${name} avatar`}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ imageRendering: "pixelated", transform: `scale(${AVATAR_ZOOM})`, transformOrigin: "50% 50%" }}
        />
      </span>
    );
  }
  return (
    <span
      className={`${box} ${radius} inline-flex flex-shrink-0 items-center justify-center border border-border bg-surface text-muted ${className}`}
      aria-hidden="true"
    >
      <Bot className={ICON_CLASS[size]} />
    </span>
  );
}
