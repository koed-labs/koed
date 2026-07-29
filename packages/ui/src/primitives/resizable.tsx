"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type CSSProperties,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent
} from "react";

import { cn } from "../cn.js";

type ResizeContextValue = {
  direction: "horizontal" | "vertical";
  max: number;
  min: number;
  onSizeChange: (size: number) => void;
  size: number;
};

const ResizeContext = createContext<ResizeContextValue | null>(null);

function Resizable({
  className,
  direction = "horizontal",
  size,
  min = 240,
  max = 640,
  onSizeChange,
  style,
  ...props
}: ComponentProps<"div"> & {
  direction?: ResizeContextValue["direction"];
  size: number;
  min?: number;
  max?: number;
  onSizeChange: (size: number) => void;
}) {
  const value = useMemo(
    () => ({ direction, max, min, onSizeChange, size }),
    [direction, max, min, onSizeChange, size]
  );
  return (
    <ResizeContext value={value}>
      <div
        className={cn(
          "flex min-h-0 min-w-0",
          direction === "vertical" ? "flex-col" : "flex-row",
          className
        )}
        data-slot="resizable"
        style={{ "--resizable-size": `${size}px`, ...style } as CSSProperties}
        {...props}
      />
    </ResizeContext>
  );
}

function ResizablePanel({
  className,
  primary = false,
  ...props
}: ComponentProps<"div"> & { primary?: boolean }) {
  return (
    <div
      className={cn(
        "min-h-0 min-w-0 overflow-hidden",
        primary ? "basis-(--resizable-size) shrink-0" : "flex-1",
        className
      )}
      data-slot="resizable-panel"
      {...props}
    />
  );
}

function ResizableHandle({ className, ...props }: ComponentProps<"div">) {
  const context = useContext(ResizeContext);
  const startRef = useRef<{ coordinate: number; size: number } | null>(null);
  if (!context) {
    throw new Error("ResizableHandle must be used inside Resizable.");
  }
  const { direction, max, min, onSizeChange, size } = context;
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [max, min]
  );
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = {
      coordinate: direction === "horizontal" ? event.clientX : event.clientY,
      size
    };
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !startRef.current ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    const coordinate =
      direction === "horizontal" ? event.clientX : event.clientY;
    onSizeChange(
      clamp(startRef.current.size + coordinate - startRef.current.coordinate)
    );
  };
  return (
    <div
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={size}
      className={cn(
        "relative shrink-0 bg-border outline-none after:absolute after:inset-[-3px] focus-visible:bg-ring",
        direction === "horizontal"
          ? "w-px cursor-col-resize"
          : "h-px cursor-row-resize",
        className
      )}
      data-slot="resizable-handle"
      onKeyDown={(event) => {
        const delta =
          event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -8
            : event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 8
              : 0;
        if (delta) {
          event.preventDefault();
          onSizeChange(clamp(size + delta));
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        startRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      role="separator"
      tabIndex={0}
      {...props}
    />
  );
}

export { Resizable, ResizableHandle, ResizablePanel };
