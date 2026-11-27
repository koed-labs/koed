import { useEffect, useRef, useState, type PointerEvent } from "react";

const widthKey = "koed:sidebar-width";
const defaultWidth = 280;
const minimumWidth = 220;
const maximumWidth = 520;
const railWidth = 60;
const minimumMainWidth = 480;
const keyboardStep = 16;

function clampWidth(width: number, maximum = maximumWidth) {
  return Math.min(maximum, Math.max(minimumWidth, Math.round(width)));
}

function getStoredWidth() {
  try {
    const saved = window.localStorage.getItem(widthKey)?.trim();
    const width = saved ? Number(saved) : defaultWidth;
    return Number.isFinite(width) ? clampWidth(width) : defaultWidth;
  } catch {
    return defaultWidth;
  }
}

function getMaximumWidth() {
  if (typeof window === "undefined") return maximumWidth;
  return clampWidth(window.innerWidth - railWidth - minimumMainWidth);
}

export function useSidebarWidth() {
  const [preferredWidth, setPreferredWidth] = useState(getStoredWidth);
  const [maxWidth, setMaxWidth] = useState(getMaximumWidth);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setMaxWidth(getMaximumWidth());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return {
    width: clampWidth(previewWidth ?? preferredWidth, maxWidth),
    maxWidth,
    onPreview: setPreviewWidth,
    onResize(nextWidth: number) {
      setPreferredWidth(nextWidth);
      try {
        window.localStorage.setItem(widthKey, String(nextWidth));
      } catch {
        // The layout still works when the renderer cannot write preferences.
      }
    }
  };
}

export function SidebarResizeHandle({
  sidebarId,
  width,
  maxWidth,
  onPreview,
  onResize
}: ReturnType<typeof useSidebarWidth> & { sidebarId: string }) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => () => onPreview(null), [onPreview]);

  function widthAt(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start?.id !== event.pointerId) return null;
    return clampWidth(start.width + event.clientX - start.x, maxWidth);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    onPreview(null);
  }

  return (
    <div
      className="v1-navigation-resize"
      role="separator"
      tabIndex={0}
      aria-label="Resize Projects and Anchors sidebar"
      aria-orientation="vertical"
      aria-controls={sidebarId}
      aria-valuemin={minimumWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const nextWidth = widthAt(event);
        if (nextWidth !== null) onPreview(nextWidth);
      }}
      onPointerUp={(event) => {
        const nextWidth = widthAt(event);
        if (nextWidth !== null && nextWidth !== drag.current?.width)
          onResize(nextWidth);
        endDrag(event);
      }}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        if (drag.current || event.altKey || event.ctrlKey || event.metaKey)
          return;
        let nextWidth: number;
        switch (event.key) {
          case "ArrowLeft":
            nextWidth = clampWidth(width - keyboardStep, maxWidth);
            break;
          case "ArrowRight":
            nextWidth = clampWidth(width + keyboardStep, maxWidth);
            break;
          case "Home":
            nextWidth = minimumWidth;
            break;
          case "End":
            nextWidth = maxWidth;
            break;
          default:
            return;
        }
        event.preventDefault();
        if (nextWidth !== width) onResize(nextWidth);
      }}
    />
  );
}
